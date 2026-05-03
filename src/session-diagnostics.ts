import { hasProtocolMarkupLeak } from "./boundary-garbage.ts";
import { detectToolIntentText } from "./recovery.ts";

const PREVIEW_CHARS = 160;

export interface SessionTokenTotals {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
}

export interface SessionMessageCounts {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalEntries: number;
}

export interface SessionRecoveryCounts {
	boundaryGarbage: number;
	emptyStop: number;
	thinkingOnly: number;
	toolValidation: number;
	toolIntent: number;
}

export interface AssistantStopDiagnostic {
	timestamp?: string;
	stopReason?: string;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	totalTokens?: number;
	hasVisibleText: boolean;
	hasThinking: boolean;
	hasToolCalls: boolean;
	contentTypes: string[];
	diagnosis: string;
	textPreview?: string;
	thinkingPreview?: string;
}

export interface SessionDiagnostics {
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	leafId?: string;
	counts: SessionMessageCounts;
	tokens: SessionTokenTotals;
	recoveryCounts: SessionRecoveryCounts;
	lastAssistantStop?: AssistantStopDiagnostic;
	recentAnomalies: AssistantStopDiagnostic[];
}

export function buildSessionDiagnostics(
	sessionManager: unknown,
	opts?: { onUnavailable?: (reason: string) => void },
): SessionDiagnostics | undefined {
	if (!sessionManager || typeof sessionManager !== "object") {
		opts?.onUnavailable?.("sessionManager not an object");
		return undefined;
	}
	const manager = sessionManager as Record<string, unknown>;
	const branch = callUnknownArrayMethod(manager, "getBranch");
	if (!branch) {
		opts?.onUnavailable?.("getBranch method missing or returned non-array");
		return undefined;
	}

	const result: SessionDiagnostics = {
		sessionFile: callStringMethod(manager, "getSessionFile"),
		sessionId: callStringMethod(manager, "getSessionId"),
		sessionName: callStringMethod(manager, "getSessionName"),
		leafId: callStringMethod(manager, "getLeafId"),
		counts: {
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalEntries: branch.length,
		},
		tokens: {},
		recoveryCounts: {
			boundaryGarbage: 0,
			emptyStop: 0,
			thinkingOnly: 0,
			toolValidation: 0,
			toolIntent: 0,
		},
		recentAnomalies: [],
	};

	for (const entry of branch) {
		const record = isRecord(entry) ? entry : undefined;
		recordRecoveryMessage(result.recoveryCounts, record);

		if (!record) continue;
		const message =
			record?.type === "message" && isRecord(record.message)
				? record.message
				: undefined;
		if (!message) continue;

		const role = typeof message.role === "string" ? message.role : undefined;
		if (role === "user") {
			result.counts.userMessages += 1;
			continue;
		}

		if (role === "toolResult" || role === "tool") {
			result.counts.toolResults += 1;
			continue;
		}

		if (role !== "assistant") continue;
		result.counts.assistantMessages += 1;
		result.counts.toolCalls += countToolCalls(message.content);
		addUsage(result.tokens, message.usage);

		const diagnostic = buildAssistantDiagnostic(record, message);
		result.lastAssistantStop = diagnostic;
		if (diagnostic.diagnosis !== "normal") {
			result.recentAnomalies.push(diagnostic);
			if (result.recentAnomalies.length > 5) {
				result.recentAnomalies.shift();
			}
		}
	}

	return result;
}

function recordRecoveryMessage(
	counts: SessionRecoveryCounts,
	entry: Record<string, unknown> | undefined,
): void {
	if (!entry) return;
	if (entry.type !== "custom_message" && entry.type !== "custom") return;
	const customType =
		typeof entry.customType === "string" ? entry.customType : "";
	switch (customType) {
		case "omlx-boundary-recovery":
			counts.boundaryGarbage += 1;
			break;
		case "omlx-empty-stop-recovery":
			counts.emptyStop += 1;
			break;
		case "omlx-thinking-only-recovery":
			counts.thinkingOnly += 1;
			break;
		case "omlx-tool-validation-recovery":
			counts.toolValidation += 1;
			break;
		case "omlx-tool-intent-recovery":
			counts.toolIntent += 1;
			break;
	}
}

function buildAssistantDiagnostic(
	entry: Record<string, unknown>,
	message: Record<string, unknown>,
): AssistantStopDiagnostic {
	const text = extractTextByKind(message.content, "text").trim();
	const thinking = extractTextByKind(message.content, "thinking").trim();
	const toolCalls = countToolCalls(message.content);
	const contentTypes = extractContentTypes(message.content);
	const outputTokens = extractUsageNumber(message.usage, [
		"output",
		"outputTokens",
		"completion_tokens",
	]);
	const inputTokens = extractUsageNumber(message.usage, [
		"input",
		"inputTokens",
		"prompt_tokens",
	]);
	const cacheReadTokens = extractUsageNumber(message.usage, [
		"cacheRead",
		"cache_read",
		"cached_tokens",
	]);
	const cacheWriteTokens = extractUsageNumber(message.usage, [
		"cacheWrite",
		"cache_write",
	]);
	const totalTokens =
		extractUsageNumber(message.usage, [
			"totalTokens",
			"total",
			"total_tokens",
		]) ??
		sumDefined([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]);
	const stopReason =
		typeof message.stopReason === "string" ? message.stopReason : undefined;
	const protocolLeak =
		toolCalls === 0 && hasProtocolMarkupLeak(`${text}\n${thinking}`);
	const toolIntent =
		toolCalls === 0 ? detectToolIntentText(text) : { hit: false };

	let diagnosis = "normal";
	if (stopReason === "length") {
		diagnosis = "provider length limit";
	} else if (stopReason === "error") {
		diagnosis = "provider error stop";
	} else if (stopReason === "stop" && protocolLeak) {
		diagnosis = "protocol-boundary garbage";
	} else if (
		stopReason === "stop" &&
		toolCalls === 0 &&
		text.length === 0 &&
		thinking.length > 0
	) {
		diagnosis = "thinking-only stop before visible answer/tool call";
	} else if (
		stopReason === "stop" &&
		toolCalls === 0 &&
		text.length === 0 &&
		thinking.length === 0
	) {
		diagnosis = "empty assistant stop";
	} else if (stopReason === "stop" && toolIntent.hit) {
		diagnosis = `tool-intent stop${toolIntent.reason ? ` (${toolIntent.reason})` : ""}`;
	}

	return {
		timestamp: normalizeTimestamp(entry.timestamp ?? message.timestamp),
		stopReason,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		totalTokens,
		hasVisibleText: text.length > 0,
		hasThinking: thinking.length > 0,
		hasToolCalls: toolCalls > 0,
		contentTypes,
		diagnosis,
		textPreview: text ? text.slice(0, PREVIEW_CHARS) : undefined,
		thinkingPreview: thinking ? thinking.slice(0, PREVIEW_CHARS) : undefined,
	};
}

function addUsage(totals: SessionTokenTotals, usage: unknown): void {
	if (!isRecord(usage)) return;
	addToken(
		totals,
		"input",
		extractUsageNumber(usage, ["input", "inputTokens", "prompt_tokens"]),
	);
	addToken(
		totals,
		"output",
		extractUsageNumber(usage, ["output", "outputTokens", "completion_tokens"]),
	);
	addToken(
		totals,
		"cacheRead",
		extractUsageNumber(usage, ["cacheRead", "cache_read", "cached_tokens"]),
	);
	addToken(
		totals,
		"cacheWrite",
		extractUsageNumber(usage, ["cacheWrite", "cache_write"]),
	);
	const total = extractUsageNumber(usage, [
		"totalTokens",
		"total",
		"total_tokens",
	]);
	addToken(
		totals,
		"total",
		total ??
			sumDefined([
				extractUsageNumber(usage, ["input", "inputTokens", "prompt_tokens"]),
				extractUsageNumber(usage, [
					"output",
					"outputTokens",
					"completion_tokens",
				]),
				extractUsageNumber(usage, ["cacheRead", "cache_read", "cached_tokens"]),
				extractUsageNumber(usage, ["cacheWrite", "cache_write"]),
			]),
	);
}

function addToken(
	totals: SessionTokenTotals,
	key: keyof SessionTokenTotals,
	value: number | undefined,
): void {
	if (value === undefined) return;
	totals[key] = (totals[key] ?? 0) + value;
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

function extractUsageNumber(
	usage: unknown,
	keys: string[],
): number | undefined {
	if (!isRecord(usage)) return undefined;
	for (const key of keys) {
		const value = usage[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function extractTextByKind(
	content: unknown,
	kind: "text" | "thinking",
): string {
	if (typeof content === "string") return kind === "text" ? content : "";
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!isRecord(item) || item.type !== kind) return "";
			if (kind === "text" && typeof item.text === "string") return item.text;
			if (kind === "thinking" && typeof item.thinking === "string")
				return item.thinking;
			return "";
		})
		.filter((value) => value.length > 0)
		.join("\n");
}

function extractContentTypes(content: unknown): string[] {
	if (typeof content === "string") return ["text"];
	if (!Array.isArray(content)) return [];
	return content
		.map((item) =>
			isRecord(item) && typeof item.type === "string" ? item.type : undefined,
		)
		.filter((value): value is string => typeof value === "string");
}

function countToolCalls(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.filter((item) => isRecord(item) && item.type === "toolCall")
		.length;
}

function normalizeTimestamp(value: unknown): string | undefined {
	if (typeof value === "string" && value) return value;
	if (typeof value === "number" && Number.isFinite(value)) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
	}
	return undefined;
}

function callStringMethod(
	record: Record<string, unknown>,
	name: string,
): string | undefined {
	const value = callMethod(record, name);
	return typeof value === "string" && value ? value : undefined;
}

function callUnknownArrayMethod(
	record: Record<string, unknown>,
	name: string,
): unknown[] | undefined {
	const value = callMethod(record, name);
	return Array.isArray(value) ? value : undefined;
}

function callMethod(record: Record<string, unknown>, name: string): unknown {
	const method = record[name];
	if (typeof method !== "function") return undefined;
	try {
		return method.call(record);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
