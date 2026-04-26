import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { fetchModels, type OmlxModel } from "./src/catalog.ts";
import { loadConfig, MissingEnvError, type OmlxConfig } from "./src/config.ts";
import { compactOmlxContext } from "./src/context.ts";
import { buildLabels } from "./src/labels.ts";
import { applyOmlxCompatibilityOverlay } from "./src/overlay.ts";
import { toProviderConfig } from "./src/provider.ts";
import {
	getAutoplanFailureMessage,
	getAutoplanInvalidTurnReason,
	getLatestAutoplanInvocationKey,
} from "./src/recovery.ts";
import { applyOmlxThinkingControls } from "./src/thinking.ts";

const PROVIDER = "omlx";
const STATUS_KEY = "omlx";
const DEBUG_LOG_DIR = join(homedir(), ".pi", "packages", "pi-omlx-picker", "log");
const DEBUG_LOG_FILE = join(DEBUG_LOG_DIR, "provider-debug.log");
const EXTENSION_SINGLETON_KEY = Symbol.for("pi-omlx-picker/loaded");

interface State {
	config: OmlxConfig | undefined;
	catalog: OmlxModel[];
	registered: boolean;
	lastError: string | undefined;
	autoplanRecoveryCount: number;
	lastAutoplanFailureKey: string | undefined;
	lastToolCallFingerprint: string | undefined;
	repeatedToolCallCount: number;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const globalState = globalThis as Record<PropertyKey, unknown>;
	if (globalState[EXTENSION_SINGLETON_KEY]) {
		debugLog("extension_load_skipped", { provider: PROVIDER, reason: "already_loaded" });
		return;
	}
	globalState[EXTENSION_SINGLETON_KEY] = true;

	const state: State = {
		config: undefined,
		catalog: [],
		registered: false,
		lastError: undefined,
		autoplanRecoveryCount: 0,
		lastAutoplanFailureKey: undefined,
		lastToolCallFingerprint: undefined,
		repeatedToolCallCount: 0,
	};

	debugLog("extension_load", { provider: PROVIDER });
	await initialRegister(pi, state);

	pi.on("session_start", () => {
		state.autoplanRecoveryCount = 0;
		state.lastAutoplanFailureKey = undefined;
		state.lastToolCallFingerprint = undefined;
		state.repeatedToolCallCount = 0;
		debugLog("session_start", { provider: PROVIDER, autoplanRecoveryCount: 0 });
	});

	const IMAGE_PATH_RE = /(?:^|\s)(\/[^\s]+\.(?:png|jpg|jpeg|webp|gif))(?=\s|$)/gi;
	const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

	pi.on("input", (event) => {
		const matches = [...event.text.matchAll(IMAGE_PATH_RE)];
		if (matches.length === 0) return { action: "continue" };

		const images: { type: "image"; data: string; mimeType: string }[] = [];
		let text = event.text;

		for (const match of matches) {
			const path = match[1];
			try {
				const data = readFileSync(path).toString("base64");
				const ext = path.split(".").pop()!.toLowerCase();
				images.push({ type: "image", data, mimeType: MIME[ext] ?? "image/png" });
				text = text.replace(match[0], " ").trim();
				debugLog("image_attached", { path, mimeType: MIME[ext] ?? "image/png" });
			} catch (err) {
				debugLog("image_attach_error", { path, error: String(err) });
			}
		}

		if (images.length === 0) return { action: "continue" };
		return { action: "transform", text: text || " ", images };
	});

	(pi.on as any)("context", (event: any, ctx: any) => {
		if (ctx.model?.provider !== PROVIDER) return;
		const result = compactOmlxContext(Array.isArray(event?.messages) ? event.messages : []);
		if (!result.stats) return;
		debugLog("context_compaction", {
			model: ctx.model?.id,
			...result.stats,
		});
		return { messages: result.messages };
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;
		const overlaidPayload = applyCompatibilityOverlay(event.payload, ctx);
		const payload = applyOmlxThinkingControls(overlaidPayload, pi.getThinkingLevel());
		const autoplanPayloadPath = writeAutoplanPayloadSnapshot(payload, ctx.model?.id);
		debugLog("before_provider_request", {
			model: ctx.model?.id,
			thinkingLevel: pi.getThinkingLevel(),
			autoplanPayloadPath,
			payload: summarizePayload(payload),
		});
		return payload;
	});

	pi.on("after_provider_response", (event: any, ctx: any) => {
		if (ctx.model?.provider !== PROVIDER) return;
		debugLog("after_provider_response", {
			model: ctx.model?.id,
			status: event?.status,
			headers: summarizeHeaders(event?.headers),
		});
	});

	pi.on("turn_end", (event: any, ctx: any) => {
		if (ctx.model?.provider !== PROVIDER) return;
		const toolResults = Array.isArray(event?.toolResults) ? event.toolResults.length : 0;
		const branchMessages = extractBranchMessages(ctx);
		debugLog("turn_end", {
			model: ctx.model?.id,
			turnIndex: event?.turnIndex,
			message: summarizeMessage(event?.message),
			toolResults,
		});

		// Detect repeated identical tool calls (stuck loop).
		const toolCalls: any[] = Array.isArray(event?.message?.content)
			? event.message.content.filter((c: any) => c?.type === "toolCall")
			: [];
		if (toolCalls.length > 0) {
			const fingerprint = toolCalls.map((c: any) => `${c.name}:${JSON.stringify(c.arguments)}`).join("|");
			if (fingerprint === state.lastToolCallFingerprint) {
				state.repeatedToolCallCount++;
				debugLog("repeated_tool_call", { model: ctx.model?.id, count: state.repeatedToolCallCount, fingerprint });
				if (state.repeatedToolCallCount >= 2) {
					ctx.ui.notify(
						`Model has repeated the same tool call ${state.repeatedToolCallCount + 1} times in a row — it may be stuck in a loop. Consider switching models or interrupting.`,
						"warning",
					);
				}
			} else {
				state.lastToolCallFingerprint = fingerprint;
				state.repeatedToolCallCount = 0;
			}
		} else {
			state.lastToolCallFingerprint = undefined;
			state.repeatedToolCallCount = 0;
		}

		const invalidReason = getAutoplanInvalidTurnReason(event?.message, toolResults, branchMessages);
		if (!invalidReason) return;
		const invocationKey = getLatestAutoplanInvocationKey(branchMessages);
		if (invocationKey && state.lastAutoplanFailureKey === invocationKey) {
			debugLog("autoplan_invalid_turn_suppressed", {
				model: ctx.model?.id,
				reason: invalidReason,
				invocationKey,
			});
			return;
		}
		state.lastAutoplanFailureKey = invocationKey;

		debugLog("autoplan_invalid_turn", {
			model: ctx.model?.id,
			reason: invalidReason,
			invocationKey,
		});
		ctx.ui.setStatus(STATUS_KEY, "OMLX model returned invalid autoplan output");
		ctx.ui.notify(
			`${getAutoplanFailureMessage(invalidReason)} Recommended next step: switch to a stronger model or continue without /autoplan on OMLX for this session.`,
			"warning",
		);
	});

	pi.on("tool_call", (event: any) => {
		debugLog("tool_call", {
			toolName: event?.toolName,
			input: summarizeToolInput(event?.input),
		});
	});

	pi.registerCommand("omlx", {
		description: "Pick an OMLX model",
		handler: async (_args, ctx) => {
			await handlePick(pi, ctx, state);
		},
	});

	pi.registerCommand("omlx-refresh", {
		description: "Refresh the OMLX model list",
		handler: async (_args, ctx) => {
			await refresh(pi, ctx, state, { silent: false });
		},
	});
}

function applyCompatibilityOverlay(payload: unknown, ctx: any): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const current = payload as Record<string, unknown>;
	const messages = Array.isArray(current.messages) ? current.messages : undefined;
	if (!messages) return payload;

	const result = applyOmlxCompatibilityOverlay(messages);
	if (!result.stats) return payload;

	debugLog("compatibility_overlay", {
		model: ctx.model?.id,
		...result.stats,
	});

	return {
		...current,
		messages: result.messages,
	};
}

function debugLog(kind: string, details: Record<string, unknown>): void {
	try {
		mkdirSync(DEBUG_LOG_DIR, { recursive: true });
		appendFileSync(
			DEBUG_LOG_FILE,
			`${JSON.stringify({ ts: new Date().toISOString(), kind, ...details })}\n`,
			"utf8",
		);
	} catch {
		// Logging must never break the provider path.
	}
}

function writeAutoplanPayloadSnapshot(payload: unknown, model: string | undefined): string | undefined {
	try {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
		const current = payload as Record<string, unknown>;
		const messages = Array.isArray(current.messages) ? current.messages : [];
		const hasAutoplan = messages.some((message) => messageTextIncludes(message, "<skill name=\"gstack-autoplan\""));
		if (!hasAutoplan) return undefined;

		mkdirSync(DEBUG_LOG_DIR, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = join(DEBUG_LOG_DIR, `autoplan-payload-${stamp}.json`);
		writeFileSync(
			path,
			JSON.stringify(
				{
					ts: new Date().toISOString(),
					model,
					payload,
				},
				null,
				2,
			),
			"utf8",
		);
		return path;
	} catch {
		return undefined;
	}
}

function summarizePayload(payload: unknown): Record<string, unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { type: typeof payload };
	}

	const current = payload as Record<string, unknown>;
	const messages = Array.isArray(current.messages) ? current.messages : [];
	return {
		keys: Object.keys(current).sort(),
		model: current.model,
		stream: current.stream,
		max_tokens: current.max_tokens,
		thinking_budget: current.thinking_budget,
		chat_template_kwargs: current.chat_template_kwargs,
		messageCount: messages.length,
		messageChars: messages.reduce((sum, message) => sum + estimateMessageChars(message), 0),
		lastMessagePreview: previewMessage(messages.at(-1)),
	};
}

function estimateMessageChars(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum, item) => {
		if (!item || typeof item !== "object") return sum;
		const text = (item as Record<string, unknown>).text;
		return sum + (typeof text === "string" ? text.length : 0);
	}, 0);
}

function previewMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content.slice(0, 240);
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).text : undefined))
		.find((item) => typeof item === "string");
	return typeof text === "string" ? text.slice(0, 240) : undefined;
}

function messageTextIncludes(message: unknown, pattern: string): boolean {
	if (!message || typeof message !== "object") return false;
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content.includes(pattern);
	if (!Array.isArray(content)) return false;
	return content.some((item) => {
		if (!item || typeof item !== "object") return false;
		const text = (item as Record<string, unknown>).text;
		return typeof text === "string" && text.includes(pattern);
	});
}

function summarizeHeaders(headers: unknown): Record<string, unknown> | undefined {
	if (!headers || typeof headers !== "object") return undefined;
	const entries: [string, unknown][] = [];
	if (typeof (headers as { forEach?: unknown }).forEach === "function") {
		(headers as { forEach: (callback: (value: unknown, key: string) => void) => void }).forEach((value, key) => {
			entries.push([key, value]);
		});
	} else {
		entries.push(...Object.entries(headers as Record<string, unknown>));
	}
	const interesting = ["content-type", "x-request-id", "openai-processing-ms"];
	const filtered = entries.filter(([key]) => interesting.includes(key.toLowerCase()));
	return Object.fromEntries(filtered);
}

function summarizeMessage(message: unknown): Record<string, unknown> {
	if (!message || typeof message !== "object") return { present: false };
	const current = message as Record<string, unknown>;
	const content = Array.isArray(current.content) ? current.content : [];
	const textParts = content
		.map((item) => {
			if (!item || typeof item !== "object") return undefined;
			const record = item as Record<string, unknown>;
			return typeof record.text === "string" ? record.text : undefined;
		})
		.filter((item): item is string => typeof item === "string");

	const toolCalls = content
		.map((item) => {
			if (!item || typeof item !== "object") return undefined;
			const record = item as Record<string, unknown>;
			return record.type === "toolCall" ? record.name : undefined;
		})
		.filter((item): item is string => typeof item === "string");

	return {
		role: current.role,
		stopReason: current.stopReason,
		contentTypes: content
			.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).type : undefined))
			.filter((item) => typeof item === "string"),
		textPreview: textParts.join("\n").slice(0, 400),
		toolCalls,
		usage: current.usage,
	};
}

function summarizeToolInput(input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	const current = { ...(input as Record<string, unknown>) };
	if (typeof current.command === "string") {
		current.command = current.command.slice(0, 240);
	}
	return current;
}

function extractBranchMessages(ctx: any): unknown[] {
	if (!ctx?.sessionManager || typeof ctx.sessionManager.getBranch !== "function") return [];
	return ctx.sessionManager
		.getBranch()
		.filter((entry: any) => entry?.type === "message")
		.map((entry: any) => entry.message);
}

async function initialRegister(pi: ExtensionAPI, state: State): Promise<void> {
	let config: OmlxConfig;
	try {
		config = loadConfig();
	} catch (err) {
		if (err instanceof MissingEnvError) {
			console.error(`[pi-omlx-picker] ${err.varName} is not set — provider 'omlx' not registered.`);
			return;
		}
		throw err;
	}
	state.config = config;

	let models: OmlxModel[];
	try {
		models = await fetchModels(config.apiRoot, process.env.OMLX_API_KEY!);
	} catch (err) {
		state.lastError = err instanceof Error ? err.message : String(err);
		console.error(`[pi-omlx-picker] unable to reach ${config.apiRoot}/models: ${state.lastError}`);
		console.error(`[pi-omlx-picker] provider 'omlx' not registered. Run /omlx-refresh once the server is reachable.`);
		return;
	}

	if (models.length === 0) {
		console.error(`[pi-omlx-picker] OMLX returned 0 models — provider 'omlx' not registered.`);
		return;
	}

	state.catalog = models;
	pi.registerProvider(PROVIDER, toProviderConfig(config.apiRoot, config.apiKeyEnvVar, models));
	state.registered = true;
}

async function refresh(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: State,
	opts: { silent: boolean },
): Promise<void> {
	let config: OmlxConfig;
	try {
		config = loadConfig();
	} catch (err) {
		if (err instanceof MissingEnvError) {
			const msg = `omlx: set ${err.varName}`;
			ctx.ui.setStatus(STATUS_KEY, msg);
			if (!opts.silent) ctx.ui.notify(msg, "error");
			if (state.registered) {
				pi.unregisterProvider(PROVIDER);
				state.registered = false;
			}
			state.config = undefined;
			return;
		}
		throw err;
	}
	state.config = config;

	let models: OmlxModel[];
	try {
		models = await fetchModels(config.apiRoot, process.env.OMLX_API_KEY!);
	} catch (err) {
		state.lastError = err instanceof Error ? err.message : String(err);
		const keepCount = state.catalog.length;
		const msg = keepCount > 0
			? `omlx: unreachable (keeping last ${keepCount})`
			: "omlx: unreachable";
		ctx.ui.setStatus(STATUS_KEY, msg);
		if (!opts.silent) ctx.ui.notify(`${msg} — ${state.lastError}`, "error");
		return;
	}

	state.catalog = models;
	state.lastError = undefined;

	if (models.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, "omlx: 0 models, unregistered");
		if (state.registered) {
			pi.unregisterProvider(PROVIDER);
			state.registered = false;
		}
		if (!opts.silent) ctx.ui.notify("omlx: no models returned", "warning");
		return;
	}

	pi.registerProvider(PROVIDER, toProviderConfig(config.apiRoot, config.apiKeyEnvVar, models));
	state.registered = true;

	const msg = `omlx: ${models.length} model${models.length === 1 ? "" : "s"}`;
	ctx.ui.setStatus(STATUS_KEY, msg);
	if (!opts.silent) ctx.ui.notify(msg, "info");
}

async function handlePick(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: State): Promise<void> {
	if (!state.registered || state.catalog.length === 0) {
		await refresh(pi, ctx, state, { silent: true });
	}
	if (!state.registered || state.catalog.length === 0) {
		ctx.ui.notify("omlx: no catalog available", "error");
		return;
	}

	const activeId = ctx.model?.provider === PROVIDER ? ctx.model.id : undefined;
	const labelled = buildLabels(state.catalog, activeId);
	const choice = await ctx.ui.select("Pick OMLX model", labelled.map((l) => l.label));
	if (!choice) return;

	const picked = labelled.find((l) => l.label === choice);
	if (!picked) {
		ctx.ui.notify(`omlx: could not resolve selection`, "error");
		return;
	}
	if (picked.id === activeId) return;

	const model = ctx.modelRegistry.find(PROVIDER, picked.id);
	if (!model) {
		ctx.ui.notify(`omlx: model ${picked.id} not in registry`, "error");
		return;
	}

	if (!ctx.isIdle()) {
		ctx.ui.setStatus(STATUS_KEY, `omlx: queued → ${picked.id}`);
		ctx.ui.notify(`omlx: queued switch to ${picked.id}`, "info");
		await ctx.waitForIdle();
	}

	const ok = await pi.setModel(model);
	if (!ok) {
		ctx.ui.notify(`omlx: failed to switch to ${picked.id} (no API key?)`, "error");
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, `omlx: ${state.catalog.length} models`);
	ctx.ui.notify(`omlx: now using ${picked.id}`, "info");
}
