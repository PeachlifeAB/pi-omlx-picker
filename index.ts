import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { fetchModels, resolveLocalModelSettingsPath, type CatalogDebugEvent, type OmlxModel } from "./src/catalog.ts";
import { loadConfig, MissingEnvError, type OmlxConfig } from "./src/config.ts";
import { compactOmlxContext } from "./src/context.ts";
import { applyOmlxCompatibilityOverlay } from "./src/overlay.ts";
import { extractOutputTokens, recordPerformanceSample, type PerformanceByModel } from "./src/performance.ts";
import { toProviderConfig } from "./src/provider.ts";
import {
	buildIncompleteStopFacts,
	classifyToolIntentStopRecovery,
	classifyToolValidationRecovery,
	classifyThinkingOnlyStopRecovery,
	emitIncompleteStopFactsEvent,
	extractToolValidationError,
	isEmptyUnusableAssistantStop,
	type IncompleteStopFacts,
	OMLX_INCOMPLETE_STOP_EVENT,
	type RepeatedToolCallFacts,
	type ToolValidationErrorFacts,
} from "./src/recovery.ts";
import { diagnoseBoundaryGarbage, hasProtocolMarkupLeak } from "./src/boundary-garbage.ts";
import { getRecoveryThinkingOverrideStatus } from "./src/recovery-readiness.ts";
import { buildSessionDiagnostics } from "./src/session-diagnostics.ts";
import { applyOmlxThinkingControls } from "./src/thinking.ts";
import { renderOmlxStatus, type StatusPiModel } from "./src/status.ts";
import {
	buildTaskBudgetSteer,
	recordTaskBudgetUsage,
	resetTaskBudget,
	type TaskBudgetState,
} from "./src/task-budget.ts";

const PROVIDER = "omlx";
const STATUS_KEY = "omlx";
// Maximum total recoveries per session across all types. Prevents unbounded
// alternating loops when different recovery types take turns resetting each
// other's per-occurrence counters.
const MAX_SESSION_RECOVERIES_BOUNDARY_GARBAGE = 6;
const MAX_SESSION_RECOVERIES_TRULY_EMPTY = 6;
const MAX_SESSION_RECOVERIES_THINKING_ONLY = 16;
const MAX_SESSION_RECOVERIES_TOOL_VALIDATION = 6;
const MAX_SESSION_RECOVERIES_TOOL_INTENT = 6;
const DEBUG_LOG_DIR = join(homedir(), ".pi", "packages", "pi-omlx-picker", "log");
const DEBUG_LOG_FILE = join(DEBUG_LOG_DIR, "provider-debug.log");
const EXTENSION_SINGLETON_KEY = Symbol.for("pi-omlx-picker/loaded");

interface State {
	config: OmlxConfig | undefined;
	catalog: OmlxModel[];
	registered: boolean;
	lastError: string | undefined;
	lastErrorAt: string | undefined;
	lastRefreshAt: string | undefined;
	modelSettingsPath: string | undefined;
	performance: PerformanceByModel;
	activeRequest: { modelId: string; startedAtMs: number } | undefined;
	requestSequence: number;
	activeCorrelationId: string | undefined;
	streamingSummary: StreamingSummary | undefined;
	taskBudget: TaskBudgetState;
	lastToolCallFingerprint: string | undefined;
	lastToolCallName: string | undefined;
	repeatedToolCallCount: number;
	boundaryGarbageRetry: boolean;
	trulyEmptyRetryInFlight: boolean;
	thinkingOnlyRetryCount: number;
	toolIntentRetryCount: number;
	toolValidationRetryCount: number;
	lastToolValidationError: ToolValidationErrorFacts | undefined;
	lastRequestHadTools: boolean;
	recoveryCounts: {
		boundaryGarbage: number;
		emptyStop: number;
		thinkingOnly: number;
		toolValidation: number;
		toolIntent: number;
	};
	corruptionCompactInFlight: boolean;
	corruptionCompactAttempted: boolean;
}

interface StreamingSummary {
	correlationId: string;
	eventCount: number;
	textDeltaCount: number;
	textDeltaChars: number;
	thinkingDeltaCount: number;
	thinkingDeltaChars: number;
	toolCallStartCount: number;
	toolCallDeltaCount: number;
	toolCallDeltaChars: number;
	toolCallEndCount: number;
	firstEventType?: string;
	lastEventType?: string;
	doneReason?: string;
	errorReason?: string;
	textPreview?: string;
	thinkingPreview?: string;
	toolCallNames: string[];
}

interface ContextCapableExtensionAPI {
	on(
		event: "context",
		handler: (event: { messages: unknown[] }, ctx: ExtensionContext) => void | { messages: unknown[] },
	): void;
}

type AfterProviderResponseEvent = {
	status: number;
	headers: Record<string, string>;
};

type MessageUpdateEvent = {
	assistantMessageEvent: unknown;
};

type TurnMessageContentItem = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
};

type BoundaryGarbageMessageLike = {
	role?: string;
	stopReason?: string;
	content?: string | TurnMessageContentItem[];
};

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
		lastErrorAt: undefined,
		lastRefreshAt: undefined,
		modelSettingsPath: undefined,
		performance: {},
		activeRequest: undefined,
		requestSequence: 0,
		activeCorrelationId: undefined,
		streamingSummary: undefined,
		taskBudget: resetTaskBudget(undefined),
		lastToolCallFingerprint: undefined,
		lastToolCallName: undefined,
		repeatedToolCallCount: 0,
		boundaryGarbageRetry: false,
		trulyEmptyRetryInFlight: false,
		thinkingOnlyRetryCount: 0,
		toolIntentRetryCount: 0,
		toolValidationRetryCount: 0,
		lastToolValidationError: undefined,
		lastRequestHadTools: false,
		recoveryCounts: {
			boundaryGarbage: 0,
			emptyStop: 0,
			thinkingOnly: 0,
			toolValidation: 0,
			toolIntent: 0,
		},
		corruptionCompactInFlight: false,
		corruptionCompactAttempted: false,
	};

	debugLog("extension_load", { provider: PROVIDER });
	await initialRegister(pi, state);

	pi.on("session_start", (_event, ctx) => {
		state.lastToolCallFingerprint = undefined;
		state.lastToolCallName = undefined;
		state.repeatedToolCallCount = 0;
		state.boundaryGarbageRetry = false;
		state.trulyEmptyRetryInFlight = false;
		state.thinkingOnlyRetryCount = 0;
		state.toolIntentRetryCount = 0;
		state.toolValidationRetryCount = 0;
		state.lastToolValidationError = undefined;
		state.lastRequestHadTools = false;
		state.recoveryCounts = {
			boundaryGarbage: 0,
			emptyStop: 0,
			thinkingOnly: 0,
			toolValidation: 0,
			toolIntent: 0,
		};
		state.corruptionCompactInFlight = false;
		state.corruptionCompactAttempted = false;
		state.activeRequest = undefined;
		state.activeCorrelationId = undefined;
		state.streamingSummary = undefined;
		state.taskBudget = resetTaskBudget(ctx.model?.provider === PROVIDER ? findCatalogModel(state, ctx.model.id) : undefined);
		const nativeThinking = applyOmlxNativeThinking(pi, state, ctx.model?.provider === PROVIDER ? ctx.model.id : undefined, "session_start");
		debugLog("session_start", {
			provider: PROVIDER,
			model: ctx.model?.provider === PROVIDER ? ctx.model.id : undefined,
			taskBudget: state.taskBudget,
			nativeThinking,
			recoveryCounts: state.recoveryCounts,
		});
	});

	pi.on("model_select", (event, ctx) => {
		state.activeRequest = undefined;
		state.activeCorrelationId = undefined;
		state.streamingSummary = undefined;
		state.boundaryGarbageRetry = false;
		state.trulyEmptyRetryInFlight = false;
		state.thinkingOnlyRetryCount = 0;
		state.toolIntentRetryCount = 0;
		state.toolValidationRetryCount = 0;
		state.lastToolValidationError = undefined;
		state.taskBudget = resetTaskBudget(event.model.provider === PROVIDER ? findCatalogModel(state, event.model.id) : undefined);
		const nativeThinking = applyOmlxNativeThinking(pi, state, event.model.provider === PROVIDER ? event.model.id : undefined, "model_select");
		updateOmlxFooter(ctx, state);
		debugLog("model_select", {
			provider: event.model.provider,
			model: event.model.id,
			previousProvider: event.previousModel?.provider,
			previousModel: event.previousModel?.id,
			source: event.source,
			taskBudget: state.taskBudget,
			nativeThinking,
		});
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

	(pi as unknown as ContextCapableExtensionAPI).on("context", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;
		const activeModel = findCatalogModel(state, ctx.model.id);
		const result = compactOmlxContext(Array.isArray(event.messages) ? event.messages : [], {
			maxToolResultTokens: activeModel?.maxToolResultTokens,
		});
		if (!result.stats) return;
		debugLog("context_compaction", {
			model: ctx.model?.id,
			maxToolResultTokens: activeModel?.maxToolResultTokens,
			...result.stats,
		});
		return { messages: result.messages };
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;
		const overlaidPayload = applyCompatibilityOverlay(event.payload, ctx);
		state.lastRequestHadTools = !!(overlaidPayload && typeof overlaidPayload === "object" && !Array.isArray(overlaidPayload) && hasTools(overlaidPayload as Record<string, unknown>));
		const activeModel = findCatalogModel(state, ctx.model.id);
		state.activeRequest = { modelId: ctx.model.id, startedAtMs: Date.now() };
		const correlationId = nextCorrelationId(state);
		state.activeCorrelationId = correlationId;
		state.streamingSummary = createStreamingSummary(correlationId);
		let payload = applyOmlxThinkingControls(overlaidPayload, pi.getThinkingLevel(), activeModel?.thinkingDefault);

		const recoveryThinkingDisableReasons = [
			state.boundaryGarbageRetry ? "boundary_garbage" : undefined,
			state.trulyEmptyRetryInFlight ? "truly_empty_stop" : undefined,
			state.toolIntentRetryCount > 0 ? "tool_intent_stop" : undefined,
		].filter((reason): reason is string => typeof reason === "string");
		if (recoveryThinkingDisableReasons.length > 0) {
			const p = payload as Record<string, unknown>;
			const ctk = (p.chat_template_kwargs && typeof p.chat_template_kwargs === "object")
				? { ...(p.chat_template_kwargs as Record<string, unknown>) }
				: {};
			ctk["enable_thinking"] = false;
			ctk["preserve_thinking"] = false;
			payload = { ...p, thinking_budget: 0, chat_template_kwargs: ctk };
		}
		const recoveryThinkingOverride = recoveryThinkingDisableReasons.length > 0
			? getRecoveryThinkingOverrideStatus(activeModel)
			: undefined;

		debugLog("before_provider_request", {
			correlationId,
			model: ctx.model?.id,
			thinkingLevel: pi.getThinkingLevel(),
			modelThinkingDefault: activeModel?.thinkingDefault,
			effectiveReasoning: activeModel?.thinkingDefault === true,
			displayName: activeModel?.displayName,
			taskBudget: state.taskBudget,
			toolsAvailable: state.lastRequestHadTools,
			boundaryGarbageRetry: state.boundaryGarbageRetry,
			recoveryThinkingDisableReasons,
			recoveryThinkingOverride,
			payload: summarizePayload(payload),
		});
		return payload;
	});

	pi.on("after_provider_response", (event: AfterProviderResponseEvent, ctx: ExtensionContext) => {
		if (ctx.model?.provider !== PROVIDER) return;
		debugLog("after_provider_response", {
			correlationId: state.activeCorrelationId,
			model: ctx.model?.id,
			status: event.status,
			headers: summarizeHeaders(event.headers),
		});
	});

	pi.on("message_update", (event: MessageUpdateEvent, ctx: ExtensionContext) => {
		if (ctx.model?.provider !== PROVIDER) return;
		if (!state.streamingSummary) {
			state.streamingSummary = createStreamingSummary(state.activeCorrelationId ?? "unknown");
		}
		updateStreamingSummary(state.streamingSummary, event?.assistantMessageEvent);
	});

	pi.on("message_end", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;
		const message = event.message && typeof event.message === "object"
			? event.message as unknown as Record<string, unknown>
			: undefined;
		if (message?.role !== "assistant") return;

		const outputTokens = extractOutputTokens(message);
		const request = state.activeRequest?.modelId === ctx.model.id ? state.activeRequest : undefined;
		if (request) {
			state.performance[ctx.model.id] = recordPerformanceSample(
				state.performance[ctx.model.id],
				ctx.model.id,
				request.startedAtMs,
				Date.now(),
				outputTokens,
			);
			state.activeRequest = undefined;
		}

		const budgetUpdate = recordTaskBudgetUsage(state.taskBudget, outputTokens);
		state.taskBudget = budgetUpdate.state;
		if (budgetUpdate.warning) {
			const content = buildTaskBudgetSteer(state.taskBudget, budgetUpdate.warning);
			debugLog("task_budget_steer", {
				model: ctx.model.id,
				warning: budgetUpdate.warning,
				taskBudget: state.taskBudget,
				outputTokens,
			});
			pi.sendMessage(
				{
					customType: "omlx-task-budget",
					content,
					display: false,
				},
				{
					deliverAs: "steer",
				},
			);
			updateOmlxFooter(ctx, state);
		}

		debugLog("assistant_message_metrics", {
			model: ctx.model.id,
			outputTokens,
			performance: state.performance[ctx.model.id],
			taskBudget: state.taskBudget,
		});
	});

	pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
		if (ctx.model?.provider !== PROVIDER) return;
		const activeModel = findCatalogModel(state, ctx.model.id);
		const rawToolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
		const toolResults = rawToolResults.length;
		const toolResultSummaries = summarizeToolResults(rawToolResults);
		const branchMessages = extractBranchMessages(ctx);
		const streamingSummary = state.streamingSummary;
		const turnMessage = event.message as unknown as BoundaryGarbageMessageLike;
		debugLog("turn_end", {
			correlationId: state.activeCorrelationId,
			model: ctx.model?.id,
			turnIndex: event.turnIndex,
			message: summarizeMessage(event.message),
			toolResults,
			toolResultSummaries,
			streamingSummary,
		});

		// Detect repeated identical tool calls (stuck loop).
		const toolCalls: TurnMessageContentItem[] = Array.isArray(turnMessage.content)
			? turnMessage.content.filter((c) => c?.type === "toolCall")
			: [];
		if (toolCalls.length > 0) {
			state.trulyEmptyRetryInFlight = false;
			state.thinkingOnlyRetryCount = 0;
			state.toolIntentRetryCount = 0;
			state.toolValidationRetryCount = 0;
			state.corruptionCompactAttempted = false;
			const fingerprint = toolCalls.map((c) => `${c.name}:${JSON.stringify(c.arguments)}`).join("|");
			if (fingerprint === state.lastToolCallFingerprint) {
				state.repeatedToolCallCount++;
				debugLog("repeated_tool_call", {
					correlationId: state.activeCorrelationId,
					model: ctx.model?.id,
					count: state.repeatedToolCallCount,
					fingerprint,
				});
				if (state.repeatedToolCallCount >= 2) {
					ctx.ui.notify(
						`Model has repeated the same tool call ${state.repeatedToolCallCount + 1} times in a row - it may be stuck in a loop. Consider switching models or interrupting.`,
						"warning",
					);
				}
				} else {
					state.lastToolCallFingerprint = fingerprint;
					state.lastToolCallName = typeof toolCalls[0]?.name === "string" ? toolCalls[0].name : undefined;
					state.repeatedToolCallCount = 0;
				}
			} else {
				state.lastToolCallFingerprint = undefined;
			state.lastToolCallName = undefined;
			state.repeatedToolCallCount = 0;
		}

		const toolValidationError = extractToolValidationError(rawToolResults);
		if (toolValidationError.hit) {
			state.lastToolValidationError = toolValidationError;
			state.toolValidationRetryCount = 0;
			debugLog("tool_validation_error_observed", {
				correlationId: state.activeCorrelationId,
				model: ctx.model?.id,
				turnIndex: event.turnIndex,
				toolName: toolValidationError.toolName,
				preview: toolValidationError.preview,
			});
		} else if (toolResults > 0 && toolResultSummaries.some((result) => result.isError !== true)) {
			state.lastToolValidationError = undefined;
			state.toolValidationRetryCount = 0;
		}

		const previousMessage = resolvePreviousBranchMessage(branchMessages, event.message);
		const boundaryGarbage = diagnoseBoundaryGarbage(
			previousMessage as unknown as BoundaryGarbageMessageLike | undefined,
			turnMessage,
		);
		if (boundaryGarbage.hit) {
			if (state.recoveryCounts.boundaryGarbage >= MAX_SESSION_RECOVERIES_BOUNDARY_GARBAGE) {
				debugLog("boundary_garbage_session_cap_exceeded", {
					correlationId: state.activeCorrelationId,
					model: ctx.model?.id,
					turnIndex: event.turnIndex,
					count: state.recoveryCounts.boundaryGarbage,
				});
				state.boundaryGarbageRetry = false;
				ctx.ui.setStatus(STATUS_KEY, "OMLX boundary recovery exhausted");
				ctx.ui.notify(
					"OMLX session appears corrupted: protocol tags keep leaking after multiple recovery attempts. Consider restarting the OMLX session.",
					"warning",
				);
				emitSessionCorruptionSuspected(pi, ctx, state, {
					reason: "boundary-garbage-cap",
					modelId: ctx.model?.id,
					turnIndex: event.turnIndex,
					recoveryCounts: { ...state.recoveryCounts },
				});
				return;
			}
			state.boundaryGarbageRetry = true;
			state.recoveryCounts.boundaryGarbage += 1;
			debugLog("boundary_garbage_retry", {
				correlationId: state.activeCorrelationId,
				model: ctx.model?.id,
				turnIndex: event.turnIndex,
				retryCount: state.recoveryCounts.boundaryGarbage,
				diagnosis: boundaryGarbage,
			});
			pi.sendMessage(
				{
					customType: "omlx-boundary-recovery",
					content: "Continue normally. Do not output protocol tags (</tool_call>, </parameter>, </function>, </tool_response>, <|im_start|>, <|im_end|>) on their own. Emit the next tool call or answer.",
					display: false,
				},
				{
					triggerTurn: true,
					deliverAs: "steer",
				},
			);
			return;
		}

		state.boundaryGarbageRetry = false;

		const repeatedToolCall: RepeatedToolCallFacts = {
			hit: state.repeatedToolCallCount > 0,
			toolName: state.lastToolCallName,
			count: state.repeatedToolCallCount > 0 ? state.repeatedToolCallCount + 1 : undefined,
		};
		const facts = buildIncompleteStopFacts({
			message: event.message,
			modelId: ctx.model?.id,
			turnIndex: event.turnIndex,
			toolResultCount: toolResults,
			toolsAvailable: state.lastRequestHadTools,
			boundaryGarbage,
			repeatedToolCall,
		});
		if (!facts) return;

		debugLog("assistant_stop_diagnosis", {
			correlationId: state.activeCorrelationId,
			model: ctx.model?.id,
			turnIndex: event.turnIndex,
			outputTokens: extractOutputTokens(event.message),
			limits: buildStopLimitDiagnostics(event.message, activeModel),
			recoveryThinkingOverride: getRecoveryThinkingOverrideStatus(activeModel),
			recoveryState: {
				boundaryGarbageRetry: state.boundaryGarbageRetry,
				trulyEmptyRetryInFlight: state.trulyEmptyRetryInFlight,
				thinkingOnlyRetryCount: state.thinkingOnlyRetryCount,
				toolIntentRetryCount: state.toolIntentRetryCount,
				toolValidationRetryCount: state.toolValidationRetryCount,
			},
			facts,
		});

		const toolValidationRecovery = classifyToolValidationRecovery(
			facts,
			state.lastToolValidationError,
			state.toolValidationRetryCount,
		);
		if (toolValidationRecovery === "retry") {
			if (state.recoveryCounts.toolValidation >= MAX_SESSION_RECOVERIES_TOOL_VALIDATION) {
				debugLog("tool_validation_session_cap_exceeded", {
					correlationId: state.activeCorrelationId,
					model: ctx.model?.id,
					count: state.recoveryCounts.toolValidation,
				});
				state.lastToolValidationError = undefined;
				state.toolValidationRetryCount = 0;
				ctx.ui.setStatus(STATUS_KEY, "OMLX repeated invalid tool recovery (session cap)");
				ctx.ui.notify("OMLX exceeded session cap for tool validation recoveries. Manual intervention needed.", "warning");
			} else {
				state.toolValidationRetryCount += 1;
				state.trulyEmptyRetryInFlight = false;
				state.recoveryCounts.toolValidation += 1;
				debugLog("tool_validation_recovery_retry", {
					correlationId: state.activeCorrelationId,
					model: ctx.model?.id,
					turnIndex: event?.turnIndex,
					turnKey: facts.turnKey,
					retryCount: state.toolValidationRetryCount,
					toolName: state.lastToolValidationError?.toolName,
					validationPreview: state.lastToolValidationError?.preview,
				});
				pi.sendMessage(
					{
						customType: "omlx-tool-validation-recovery",
						content: buildToolValidationRecoverySteer(state.lastToolValidationError, state.toolValidationRetryCount),
						display: false,
					},
					{
						triggerTurn: true,
						deliverAs: "steer",
					},
				);
				return;
			}
		}

			if (toolValidationRecovery === "failed") {
				debugLog("tool_validation_recovery_failed", {
					correlationId: state.activeCorrelationId,
				model: ctx.model?.id,
				turnIndex: event?.turnIndex,
				turnKey: facts.turnKey,
				retryCount: state.toolValidationRetryCount,
				toolName: state.lastToolValidationError?.toolName,
				validationPreview: state.lastToolValidationError?.preview,
			});
			state.lastToolValidationError = undefined;
			state.toolValidationRetryCount = 0;
			ctx.ui.setStatus(STATUS_KEY, "OMLX repeated invalid tool recovery");
			ctx.ui.notify("OMLX failed to recover from an invalid Pi tool call. Manual intervention needed.", "warning");
		}

		const toolIntentRecovery = classifyToolIntentStopRecovery(facts, state.toolIntentRetryCount);
		if (toolIntentRecovery === "retry") {
			if (state.recoveryCounts.toolIntent >= MAX_SESSION_RECOVERIES_TOOL_INTENT) {
				debugLog("tool_intent_session_cap_exceeded", {
					correlationId: state.activeCorrelationId,
					model: ctx.model?.id,
					count: state.recoveryCounts.toolIntent,
				});
				state.toolIntentRetryCount = 0;
				ctx.ui.setStatus(STATUS_KEY, "OMLX did not emit promised tool (session cap)");
				ctx.ui.notify("OMLX exceeded session cap for tool-intent recoveries. Manual intervention needed.", "warning");
			} else {
				state.toolIntentRetryCount += 1;
				state.trulyEmptyRetryInFlight = false;
				state.recoveryCounts.toolIntent += 1;
				debugLog("tool_intent_stop_retry", {
					correlationId: state.activeCorrelationId,
					model: ctx.model?.id,
					turnIndex: event?.turnIndex,
					turnKey: facts.turnKey,
					retryCount: state.toolIntentRetryCount,
					reason: facts.toolIntentStop.reason,
					textPreview: facts.textPreview,
				});
				pi.sendMessage(
					{
						customType: "omlx-tool-intent-recovery",
						content: buildToolIntentRecoverySteer(facts, state.toolIntentRetryCount),
						display: false,
					},
					{
						triggerTurn: true,
						deliverAs: "steer",
					},
				);
				return;
			}
		}

			if (toolIntentRecovery === "failed") {
				debugLog("tool_intent_stop_retry_failed", {
				correlationId: state.activeCorrelationId,
				model: ctx.model?.id,
				turnIndex: event?.turnIndex,
				turnKey: facts.turnKey,
				retryCount: state.toolIntentRetryCount,
				reason: facts.toolIntentStop.reason,
				textPreview: facts.textPreview,
			});
			state.toolIntentRetryCount = 0;
			ctx.ui.setStatus(STATUS_KEY, "OMLX did not emit a promised tool call");
			ctx.ui.notify("OMLX repeatedly described a tool action without emitting a Pi tool call. Manual intervention needed.", "warning");
		}

		// Path 1: thinking-only stop — model is reasoning, do not disable thinking
		const thinkingOnlyRecovery = classifyThinkingOnlyStopRecovery(facts, state.thinkingOnlyRetryCount);
		if (thinkingOnlyRecovery === "retry") {
			if (state.recoveryCounts.thinkingOnly >= MAX_SESSION_RECOVERIES_THINKING_ONLY) {
				debugLog("thinking_only_session_cap_exceeded", {
					correlationId: state.activeCorrelationId,
					model: ctx.model?.id,
					count: state.recoveryCounts.thinkingOnly,
				});
				state.thinkingOnlyRetryCount = 0;
				ctx.ui.setStatus(STATUS_KEY, "OMLX returned thinking-only stop (session cap)");
				ctx.ui.notify(
					"OMLX session appears corrupted: thinking-only stops repeat after multiple recovery attempts. Consider restarting the OMLX session.",
					"warning",
				);
				emitSessionCorruptionSuspected(pi, ctx, state, {
					reason: "thinking-only-cap",
					modelId: ctx.model?.id,
					turnIndex: event?.turnIndex,
					recoveryCounts: { ...state.recoveryCounts },
				});
			} else {
				state.recoveryCounts.thinkingOnly += 1;
				debugLog("thinking_only_retry", {
					correlationId: state.activeCorrelationId,
					model: ctx.model?.id,
					turnIndex: event?.turnIndex,
					turnKey: facts.turnKey,
					retryCount: state.recoveryCounts.thinkingOnly,
				});
				pi.sendMessage(
					{
						customType: "omlx-thinking-only-recovery",
						content: "Your previous turn produced only reasoning without a visible response or tool call. Continue your reasoning and commit to the next action: either emit a Pi tool call or write your final answer. Do not stop after the reasoning step.",
						display: false,
					},
					{
						triggerTurn: true,
						deliverAs: "steer",
					},
				);
				return;
			}
		}

		// Path 2: truly empty stop — nothing at all, disable thinking and demand action
		if (facts.emptyStop && !facts.hasVisibleText && !facts.hasThinking && !facts.hasToolCalls) {
			if (state.recoveryCounts.emptyStop >= MAX_SESSION_RECOVERIES_TRULY_EMPTY) {
				debugLog("empty_stop_session_cap_exceeded", {
					correlationId: state.activeCorrelationId,
					model: ctx.model?.id,
					count: state.recoveryCounts.emptyStop,
				});
				state.trulyEmptyRetryInFlight = false;
				ctx.ui.setStatus(STATUS_KEY, "OMLX returned empty completion (session cap)");
				ctx.ui.notify(
					"OMLX session appears corrupted: empty completions repeat after multiple recovery attempts. Consider restarting the OMLX session.",
					"warning",
				);
				emitSessionCorruptionSuspected(pi, ctx, state, {
					reason: "empty-stop-cap",
					modelId: ctx.model?.id,
					turnIndex: event?.turnIndex,
					recoveryCounts: { ...state.recoveryCounts },
				});
				return;
			}
			state.trulyEmptyRetryInFlight = true;
			state.recoveryCounts.emptyStop += 1;
			debugLog("empty_stop_retry", {
				correlationId: state.activeCorrelationId,
				model: ctx.model?.id,
				turnIndex: event?.turnIndex,
				turnKey: facts.turnKey,
				retryCount: state.recoveryCounts.emptyStop,
			});
			pi.sendMessage(
				{
					customType: "omlx-empty-stop-recovery",
					content: buildEmptyStopRecoverySteer(),
					display: false,
				},
				{
					triggerTurn: true,
					deliverAs: "steer",
				},
			);
			return;
		}

		if (!isEmptyUnusableAssistantStop(facts)) {
			state.trulyEmptyRetryInFlight = false;
		}
		if (!facts.toolIntentStop.hit) {
			state.toolIntentRetryCount = 0;
		}
		if (!facts.emptyStop && facts.hasVisibleText) {
			state.lastToolValidationError = undefined;
			state.toolValidationRetryCount = 0;
		}


		emitIncompleteStopFacts(pi, facts);
		debugLog("incomplete_stop", {
			model: ctx.model?.id,
			facts,
		});
	});

	pi.on("tool_call", (event: any) => {
		debugLog("tool_call", {
			toolName: event?.toolName,
			input: summarizeToolInput(event?.input),
		});
	});

	// Block write/edit tool calls whose content contains protocol tag fragments
	// from a tool call boundary (write contamination).
	pi.on("tool_call", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;
		if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return;

		const contentToCheck = isToolCallEventType("write", event)
			? event.input.content
			: isToolCallEventType("edit", event)
				? event.input.edits.map((e) => e.newText).join("\n")
				: "";

		if (!hasProtocolMarkupLeak(contentToCheck)) return;

		state.recoveryCounts.boundaryGarbage += 1;
		debugLog("write_contamination_blocked", {
			correlationId: state.activeCorrelationId,
			model: ctx.model?.id,
			toolName: event.toolName,
			contentPreview: contentToCheck.slice(0, 240),
		});

		pi.sendMessage(
			{
				customType: "omlx-write-contamination-recovery",
				content: "The file content you were about to write contains protocol tag fragments from a tool call boundary. Do not embed tool call syntax inside file content. Re-emit the write tool call with clean file content only.",
				display: false,
			},
			{
				triggerTurn: true,
				deliverAs: "steer",
			},
		);

		return { block: true, reason: "Write content contains protocol boundary garbage." };
	});

	pi.registerCommand("omlx-status", {
		description: "Show OMLX connection, active model mapping, settings, runtime, and recovery status",
		handler: async (_args, ctx) => {
			await handleStatus(pi, ctx, state);
		},
	});
}

function applyCompatibilityOverlay(payload: unknown, ctx: ExtensionContext): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const current = payload as Record<string, unknown>;
	const messages = Array.isArray(current.messages) ? current.messages : undefined;
	if (!messages) return payload;

	const result = applyOmlxCompatibilityOverlay(messages, { toolsAvailable: hasTools(current) });
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

function hasTools(payload: Record<string, unknown>): boolean {
	return Array.isArray(payload.tools) && payload.tools.length > 0;
}

function buildEmptyStopRecoverySteer(): string {
	return "Continue normally with thinking disabled for this recovery turn. Emit the next Pi tool call or a concise visible answer immediately. Do not end the turn with empty or thinking-only content.";
}

function buildToolIntentRecoverySteer(facts: IncompleteStopFacts, retryCount: number): string {
	const preview = facts.textPreview ? ` Previous visible text: "${facts.textPreview}"` : "";
	if (retryCount <= 1) {
		return `The previous assistant message described a tool action but did not emit a Pi tool call.${preview} Emit the Pi tool call now. If the action is writing or editing a file, call the appropriate Pi write/edit tool with path and content. Do not answer with planning prose, hidden-only thinking, or protocol tags.`;
	}
	return `The previous recovery still did not produce the promised Pi tool call.${preview} The next assistant message must either emit a valid Pi tool call now or give the concise final answer if no tool is needed. Do not emit hidden-only thinking, protocol tags, or planning prose.`;
}

function buildToolValidationRecoverySteer(validationError: ToolValidationErrorFacts | undefined, retryCount: number): string {
	const toolHint = validationError?.toolName ? ` for "${validationError.toolName}"` : "";
	if (retryCount <= 1) {
		return `The previous Pi tool call${toolHint} was rejected by argument validation. Re-emit the same intended tool call with valid arguments that satisfy the tool schema. Do not call it with {}. Include all required fields. If you need more context, inspect first with an appropriate Pi tool. Do not end with empty content.`;
	}
	return `The previous validation recovery still did not produce a valid Pi tool call${toolHint}. The next assistant message must either emit a Pi tool call with complete valid arguments, including every required field, or give the concise final answer if no tool is needed. Do not emit empty content or planning prose.`;
}

function nextCorrelationId(state: State): string {
	state.requestSequence += 1;
	return `omlx-${state.requestSequence.toString(36)}-${Date.now().toString(36).slice(-6)}`;
}

function createStreamingSummary(correlationId: string): StreamingSummary {
	return {
		correlationId,
		eventCount: 0,
		textDeltaCount: 0,
		textDeltaChars: 0,
		thinkingDeltaCount: 0,
		thinkingDeltaChars: 0,
		toolCallStartCount: 0,
		toolCallDeltaCount: 0,
		toolCallDeltaChars: 0,
		toolCallEndCount: 0,
		toolCallNames: [],
	};
}

function updateStreamingSummary(summary: StreamingSummary, event: unknown): void {
	if (!event || typeof event !== "object") return;
	const record = event as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : "unknown";
	summary.eventCount += 1;
	summary.firstEventType ??= type;
	summary.lastEventType = type;

	if (type === "text_delta") {
		const delta = typeof record.delta === "string" ? record.delta : "";
		summary.textDeltaCount += 1;
		summary.textDeltaChars += delta.length;
		summary.textPreview = appendPreview(summary.textPreview, delta);
	} else if (type === "thinking_delta") {
		const delta = typeof record.delta === "string" ? record.delta : "";
		summary.thinkingDeltaCount += 1;
		summary.thinkingDeltaChars += delta.length;
		summary.thinkingPreview = appendPreview(summary.thinkingPreview, delta);
	} else if (type === "toolcall_start") {
		summary.toolCallStartCount += 1;
	} else if (type === "toolcall_delta") {
		const delta = typeof record.delta === "string" ? record.delta : "";
		summary.toolCallDeltaCount += 1;
		summary.toolCallDeltaChars += delta.length;
	} else if (type === "toolcall_end") {
		summary.toolCallEndCount += 1;
		const toolCall = record.toolCall;
		if (toolCall && typeof toolCall === "object") {
			const name = (toolCall as Record<string, unknown>).name;
			if (typeof name === "string" && !summary.toolCallNames.includes(name)) {
				summary.toolCallNames.push(name);
			}
		}
	} else if (type === "done") {
		if (typeof record.reason === "string") summary.doneReason = record.reason;
	} else if (type === "error") {
		if (typeof record.reason === "string") summary.errorReason = record.reason;
	}
}

function appendPreview(current: string | undefined, delta: string): string | undefined {
	if (!delta) return current;
	return `${current ?? ""}${delta}`.slice(0, 240);
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

interface SessionCorruptionSuspectedFacts {
	reason: "boundary-garbage-cap" | "empty-stop-cap" | "thinking-only-cap";
	modelId?: string;
	turnIndex?: number;
	recoveryCounts: Record<string, number>;
}

const OMLX_SESSION_CORRUPTION_EVENT = "pi-omlx-picker:session-corruption-suspected";

const CORRUPTION_COMPACT_RESUME_STEER =
	"The previous OMLX context was compacted after repeated provider corruption. " +
	"Continue the task from the compacted summary. Do not emit protocol tags such as " +
	"</tool_call>, </parameter>, </function>, </tool_response>, <|im_start|>, or " +
	"<|im_end|> as standalone text.";

function emitSessionCorruptionSuspected(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: State,
	facts: SessionCorruptionSuspectedFacts,
): void {
	// Emit the event for observability and external hooks.
	const events = (pi as unknown as { events?: { emit?: (name: string, payload: SessionCorruptionSuspectedFacts) => unknown } }).events;
	debugLog("session_corruption_suspected", {
		event: OMLX_SESSION_CORRUPTION_EVENT,
		facts,
		compactInFlight: state.corruptionCompactInFlight,
		compactAttempted: state.corruptionCompactAttempted,
	});
	if (typeof events?.emit === "function") {
		try {
			const result = events.emit(OMLX_SESSION_CORRUPTION_EVENT, facts);
			if (result && typeof (result as Promise<unknown>).then === "function") {
				(result as Promise<unknown>).catch((err) => {
					debugLog("session_corruption_event_error", {
						event: OMLX_SESSION_CORRUPTION_EVENT,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
		} catch (err) {
			debugLog("session_corruption_event_error", {
				event: OMLX_SESSION_CORRUPTION_EVENT,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Trigger compaction if not already in-flight or previously attempted this episode.
	if (state.corruptionCompactInFlight || state.corruptionCompactAttempted) {
		debugLog("session_corruption_compact_skipped", {
			reason: state.corruptionCompactInFlight ? "in-flight" : "already-attempted",
			facts,
		});
		return;
	}

	if (typeof ctx.compact !== "function") {
		debugLog("session_corruption_compact_unavailable", { facts });
		return;
	}

	state.corruptionCompactInFlight = true;
	state.corruptionCompactAttempted = true;
	debugLog("session_corruption_compact_start", { facts });

	ctx.compact({
		customInstructions:
			"The session encountered OMLX provider corruption: the model emitted protocol tags " +
			"(</tool_call>, </parameter>, <|im_start|>, etc.) as output, or produced empty/thinking-only " +
			"stops repeatedly. Summarize only meaningful task progress. Omit corrupted turns, " +
			"empty assistant stops, and recovery steers.",
		onComplete: () => {
			state.corruptionCompactInFlight = false;
			debugLog("session_corruption_compact_complete", { facts });
			pi.sendMessage(
				{
					customType: "omlx-corruption-resume",
					content: CORRUPTION_COMPACT_RESUME_STEER,
					display: false,
				},
				{
					triggerTurn: true,
					deliverAs: "steer",
				},
			);
		},
		onError: (error) => {
			state.corruptionCompactInFlight = false;
			const message = error instanceof Error ? error.message : String(error);
			debugLog("session_corruption_compact_error", { facts, error: message });
			ctx.ui.notify(
				`OMLX session corruption recovery: compaction failed (${message}). Manual intervention needed.`,
				"warning",
			);
		},
	});
}

function emitIncompleteStopFacts(pi: ExtensionAPI, facts: IncompleteStopFacts): void {
	const events = (pi as unknown as { events?: { emit?: (name: string, payload: IncompleteStopFacts) => unknown } }).events;
	const emitted = emitIncompleteStopFactsEvent(events, facts, (err) => {
		debugLog("incomplete_stop_event_error", {
			event: OMLX_INCOMPLETE_STOP_EVENT,
			turnKey: facts.turnKey,
			error: err instanceof Error ? err.message : String(err),
		});
	});
	if (emitted) {
		debugLog("incomplete_stop_event_emitted", {
			event: OMLX_INCOMPLETE_STOP_EVENT,
			turnKey: facts.turnKey,
			model: facts.modelId,
		});
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
		toolNames: summarizeToolNames(current.tools),
		tools: summarizeTools(current.tools),
	};
}

function summarizeToolNames(tools: unknown): string[] | undefined {
	if (!Array.isArray(tools)) return undefined;
	return tools
		.map((tool) => {
			if (!tool || typeof tool !== "object") return undefined;
			const record = tool as Record<string, unknown>;
			if (typeof record.name === "string") return record.name;
			const fn = record.function;
			if (fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).name === "string") {
				return (fn as Record<string, unknown>).name as string;
			}
			return undefined;
		})
		.filter((name): name is string => typeof name === "string")
		.slice(0, 20);
}

function summarizeTools(tools: unknown): Array<{ name: string; required?: string[] }> | undefined {
	if (!Array.isArray(tools)) return undefined;
	const summaries: Array<{ name: string; required?: string[] }> = [];
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const record = tool as Record<string, unknown>;
		const fn = record.function && typeof record.function === "object"
			? record.function as Record<string, unknown>
			: record;
		const name = typeof fn.name === "string" ? fn.name : undefined;
		if (!name) continue;
		const parameters = fn.parameters && typeof fn.parameters === "object"
			? fn.parameters as Record<string, unknown>
			: undefined;
		const required = Array.isArray(parameters?.required)
			? parameters.required.filter((item): item is string => typeof item === "string")
			: undefined;
		summaries.push(required ? { name, required } : { name });
		if (summaries.length >= 20) break;
	}
	return summaries;
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

function buildStopLimitDiagnostics(message: unknown, model: OmlxModel | undefined): Record<string, unknown> {
	const record = message && typeof message === "object" ? message as Record<string, unknown> : undefined;
	const usage = record?.usage;
	const outputTokens = extractOutputTokens(record);
	const inputTokens = extractUsageNumber(usage, ["input", "inputTokens", "prompt_tokens"]);
	const cacheReadTokens = extractUsageNumber(usage, ["cacheRead", "cache_read", "cached_tokens"]);
	const cacheWriteTokens = extractUsageNumber(usage, ["cacheWrite", "cache_write"]);
	const totalTokens = extractUsageNumber(usage, ["totalTokens", "total", "total_tokens"])
		?? sumDefined([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]);
	const outputRatio = ratio(outputTokens, model?.maxTokens);
	const contextRatio = ratio(totalTokens, model?.contextWindow);
	return {
		stopReason: record?.stopReason,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		totalTokens,
		modelMaxTokens: model?.maxTokens,
		modelContextWindow: model?.contextWindow,
		outputRatio,
		contextRatio,
		likelyOutputLimit: record?.stopReason === "length" || (outputRatio !== undefined && outputRatio >= 0.98),
		highContextPressure: contextRatio !== undefined && contextRatio >= 0.8,
	};
}

function extractUsageNumber(usage: unknown, keys: string[]): number | undefined {
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
	const record = usage as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
	let sum = 0;
	let sawValue = false;
	for (const value of values) {
		if (value === undefined) continue;
		sum += value;
		sawValue = true;
	}
	return sawValue ? sum : undefined;
}

function ratio(value: number | undefined, limit: number | undefined): number | undefined {
	if (typeof value !== "number" || typeof limit !== "number") return undefined;
	if (!Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0) return undefined;
	return value / limit;
}

function summarizeToolResults(toolResults: unknown[]): Array<Record<string, unknown>> {
	return toolResults.map((result) => {
		if (!result || typeof result !== "object") return { type: typeof result };
		const record = result as Record<string, unknown>;
		return {
			toolName: record.toolName,
			isError: record.isError,
			contentPreview: extractContentPreview(record.content),
			detailsType: record.details === undefined ? undefined : typeof record.details,
		};
	});
}

function extractContentPreview(content: unknown): string | undefined {
	if (typeof content === "string") return content.slice(0, 240);
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((item) => {
			if (typeof item === "string") return item;
			if (!item || typeof item !== "object") return undefined;
			const record = item as Record<string, unknown>;
			if (typeof record.text === "string") return record.text;
			if (typeof record.content === "string") return record.content;
			return undefined;
		})
		.filter((item): item is string => typeof item === "string")
		.join("\n");
	return text ? text.slice(0, 240) : undefined;
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

function resolvePreviousBranchMessage(
	branchMessages: unknown[],
	currentMessage: unknown,
): unknown | undefined {
	if (branchMessages.length === 0) return undefined;

	const current =
		currentMessage && typeof currentMessage === "object"
			? (currentMessage as Record<string, unknown>)
			: undefined;

	const currentRole = typeof current?.role === "string" ? current.role : undefined;
	const currentTimestamp = current?.timestamp;
	const currentStopReason =
		typeof current?.stopReason === "string" ? current.stopReason : undefined;

	const last = branchMessages[branchMessages.length - 1];
	if (last && typeof last === "object") {
		const record = last as Record<string, unknown>;
		const sameRole = record.role === currentRole;
		const sameTimestamp = record.timestamp === currentTimestamp;
		const sameStopReason = record.stopReason === currentStopReason;

		if (sameRole && (sameTimestamp || sameStopReason)) {
			return branchMessages.length >= 2
				? branchMessages[branchMessages.length - 2]
				: undefined;
		}
	}

	return last;
}

async function initialRegister(pi: ExtensionAPI, state: State): Promise<void> {
	let config: OmlxConfig;
	try {
		config = loadConfig();
	} catch (err) {
		if (err instanceof MissingEnvError) {
			console.error(`[pi-omlx-picker] ${err.varName} is not set - provider 'omlx' not registered.`);
			state.lastError = `${err.varName} is not set`;
			state.lastErrorAt = new Date().toISOString();
			return;
		}
		throw err;
	}
	state.config = config;
	state.modelSettingsPath = resolveLocalModelSettingsPath(process.env.OMLX_MODEL_SETTINGS_PATH);

	let models: OmlxModel[];
	try {
		models = await fetchModels(config.apiRoot, process.env.OMLX_API_KEY!, { onDebug: debugCatalogEvent });
	} catch (err) {
		state.lastError = err instanceof Error ? err.message : String(err);
		state.lastErrorAt = new Date().toISOString();
		console.error(`[pi-omlx-picker] unable to reach ${config.apiRoot}/models: ${state.lastError}`);
		console.error(`[pi-omlx-picker] provider 'omlx' not registered. Run /omlx-status once the server is reachable.`);
		return;
	}

	if (models.length === 0) {
		state.lastError = "OMLX returned 0 models";
		state.lastErrorAt = new Date().toISOString();
		console.error(`[pi-omlx-picker] OMLX returned 0 models - provider 'omlx' not registered.`);
		return;
	}

	state.catalog = models;
	state.lastRefreshAt = new Date().toISOString();
	state.lastError = undefined;
	state.lastErrorAt = undefined;
	pi.registerProvider(PROVIDER, toProviderConfig(config.apiRoot, config.apiKeyEnvVar, models, (event) => {
		debugLog("stream_first_delta_timeout", {
			model: event.model,
			timeoutMs: event.timeoutMs,
			attempt: event.attempt,
			maxAttempts: event.maxAttempts,
			final: event.final,
			correlationId: state.activeCorrelationId,
		});
	}));
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
			state.lastError = `${err.varName} is not set`;
			state.lastErrorAt = new Date().toISOString();
			ctx.ui.setStatus(STATUS_KEY, msg);
			if (!opts.silent) ctx.ui.notify(msg, "error");
			if (state.registered) {
				pi.unregisterProvider(PROVIDER);
				state.registered = false;
			}
			state.config = undefined;
			state.modelSettingsPath = undefined;
			return;
		}
		throw err;
	}
	state.config = config;
	state.modelSettingsPath = resolveLocalModelSettingsPath(process.env.OMLX_MODEL_SETTINGS_PATH);

	let models: OmlxModel[];
	try {
		models = await fetchModels(config.apiRoot, process.env.OMLX_API_KEY!, { onDebug: debugCatalogEvent });
	} catch (err) {
		state.lastError = err instanceof Error ? err.message : String(err);
		state.lastErrorAt = new Date().toISOString();
		const keepCount = state.catalog.length;
		const msg = keepCount > 0
			? `omlx: unreachable (keeping last ${keepCount})`
			: "omlx: unreachable";
		updateOmlxFooter(ctx, state, msg);
		if (!opts.silent) ctx.ui.notify(`${msg} - ${state.lastError}`, "error");
		return;
	}

	state.catalog = models;
	state.lastError = undefined;
	state.lastErrorAt = undefined;
	state.lastRefreshAt = new Date().toISOString();

	if (models.length === 0) {
		state.lastError = "OMLX returned 0 models";
		state.lastErrorAt = new Date().toISOString();
		if (state.registered) {
			pi.unregisterProvider(PROVIDER);
			state.registered = false;
		}
		updateOmlxFooter(ctx, state, "omlx: 0 models, unregistered");
		if (!opts.silent) ctx.ui.notify("omlx: no models returned", "warning");
		return;
	}

	pi.registerProvider(PROVIDER, toProviderConfig(config.apiRoot, config.apiKeyEnvVar, models, (event) => {
		debugLog("stream_first_delta_timeout", {
			model: event.model,
			timeoutMs: event.timeoutMs,
			attempt: event.attempt,
			maxAttempts: event.maxAttempts,
			final: event.final,
			correlationId: state.activeCorrelationId,
		});
	}));
	state.registered = true;

	const msg = `omlx: ${models.length} model${models.length === 1 ? "" : "s"}`;
	updateOmlxFooter(ctx, state);
	if (!opts.silent) ctx.ui.notify(msg, "info");
}

async function handleStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: State): Promise<void> {
	await refresh(pi, ctx, state, { silent: true });
	const activeModel = ctx.model?.provider === PROVIDER ? findCatalogModel(state, ctx.model.id) : undefined;
	if (activeModel && state.taskBudget.modelId !== activeModel.id) {
		state.taskBudget = resetTaskBudget(activeModel);
	}
	const nativeThinking = applyOmlxNativeThinking(pi, state, activeModel?.id, "omlx_status");
	const text = renderOmlxStatus({
		apiRoot: state.config?.apiRoot,
		registered: state.registered,
		catalog: state.catalog,
		modelSettingsPath: state.modelSettingsPath,
		modelSettingsFound: state.modelSettingsPath ? existsSync(state.modelSettingsPath) : undefined,
		lastRefreshAt: state.lastRefreshAt,
		lastError: state.lastError,
		lastErrorAt: state.lastErrorAt,
		activePiModel: toStatusPiModel(ctx.model),
		currentThinkingLevel: pi.getThinkingLevel(),
		performance: activeModel ? state.performance[activeModel.id] : undefined,
		taskBudget: state.taskBudget,
		recoveryCounts: state.recoveryCounts,
		recoveryThinkingOverride: getRecoveryThinkingOverrideStatus(activeModel),
		session: buildSessionDiagnostics(ctx.sessionManager, {
			onUnavailable: (reason) => debugLog("session_diagnostics_unavailable", { reason }),
		}),
		debugLogFile: DEBUG_LOG_FILE,
	});
	if (nativeThinking) {
		debugLog("native_thinking_status_sync", nativeThinking);
	}
	ctx.ui.notify(text, state.lastError ? "warning" : "info");
}

function toStatusPiModel(model: unknown): StatusPiModel | undefined {
	if (!model || typeof model !== "object") return undefined;
	const record = model as Record<string, unknown>;
	return {
		provider: typeof record.provider === "string" ? record.provider : undefined,
		id: typeof record.id === "string" ? record.id : undefined,
		name: typeof record.name === "string" ? record.name : undefined,
		reasoning: typeof record.reasoning === "boolean" ? record.reasoning : undefined,
		input: Array.isArray(record.input) ? record.input.filter((item): item is string => typeof item === "string") : undefined,
		contextWindow: typeof record.contextWindow === "number" ? record.contextWindow : undefined,
		maxTokens: typeof record.maxTokens === "number" ? record.maxTokens : undefined,
		compat: record.compat && typeof record.compat === "object" && !Array.isArray(record.compat)
			? record.compat as Record<string, unknown>
			: undefined,
	};
}

function findCatalogModel(state: State, id: string | undefined): OmlxModel | undefined {
	return id ? state.catalog.find((model) => model.id === id) : undefined;
}

function applyOmlxNativeThinking(
	pi: ExtensionAPI,
	state: State,
	modelId: string | undefined,
	reason: string,
): Record<string, unknown> | undefined {
	const model = findCatalogModel(state, modelId);
	if (!model?.nativeThinkingLevel) return undefined;
	const before = pi.getThinkingLevel();
	if (before !== model.nativeThinkingLevel) {
		pi.setThinkingLevel(model.nativeThinkingLevel);
	}
	const after = pi.getThinkingLevel();
	const result = {
		modelId: model.id,
		reason,
		source: model.nativeThinkingSource,
		requestedLevel: model.nativeThinkingLevel,
		previousLevel: before,
		effectiveLevel: after,
		changed: before !== after,
	};
	debugLog("native_thinking_applied", result);
	return result;
}

function updateOmlxFooter(ctx: ExtensionContext, state: State, forcedText?: string): void {
	if (forcedText) {
		ctx.ui.setStatus(STATUS_KEY, forcedText);
		return;
	}
	if (state.lastError && (!state.registered || state.catalog.length === 0 || ctx.model?.provider === PROVIDER)) {
		ctx.ui.setStatus(STATUS_KEY, state.catalog.length > 0 ? "omlx: unreachable (cached)" : "omlx: error");
		return;
	}
	if (ctx.model?.provider !== PROVIDER) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const activeModel = findCatalogModel(state, ctx.model.id);
	const name = activeModel?.displayName ?? ctx.model.id;
	const budget = formatTaskBudgetFooter(state.taskBudget);
	ctx.ui.setStatus(STATUS_KEY, budget ? `omlx: ${name} (${budget})` : `omlx: ${name}`);
}

function formatTaskBudgetFooter(taskBudget: TaskBudgetState): string | undefined {
	if (taskBudget.totalTokens === undefined) return undefined;
	const remaining = Math.max(taskBudget.totalTokens - taskBudget.usedOutputTokens, 0);
	const percent = Math.round((remaining / taskBudget.totalTokens) * 100);
	if (percent > 20) return undefined;
	return `${percent}% task budget`;
}

function debugCatalogEvent(event: CatalogDebugEvent): void {
	debugLog(event.kind, event.details);
}
