import type { BoundaryGarbageDiagnosis } from "./boundary-garbage.ts";

const PREVIEW_CHARS = 240;

export const OMLX_INCOMPLETE_STOP_EVENT = "pi-omlx-picker:incomplete-stop";

export interface RepeatedToolCallFacts {
	hit: boolean;
	toolName?: string;
	count?: number;
}

export interface ToolIntentStopFacts {
	hit: boolean;
	reason?: string;
}

export interface IncompleteStopFacts {
	version: 1;
	provider: "omlx";
	modelId?: string;
	turnIndex?: number;
	stopReason?: string;
	toolResultCount: number;
	toolsAvailable: boolean;
	hasVisibleText: boolean;
	hasThinking: boolean;
	hasToolCalls: boolean;
	textPreview?: string;
	thinkingPreview?: string;
	boundaryGarbage: {
		hit: boolean;
		inText: boolean;
		inThinking: boolean;
		hasProtocolLeak: boolean;
	};
	repeatedToolCall: RepeatedToolCallFacts;
	toolIntentStop: ToolIntentStopFacts;
	emptyStop: boolean;
	autoRetryEligible: boolean;
	turnKey: string;
}

export interface ToolValidationErrorFacts {
	hit: boolean;
	toolName?: string;
	preview?: string;
}

export interface BuildIncompleteStopFactsInput {
	message: unknown;
	modelId?: string;
	turnIndex?: number;
	toolResultCount: number;
	toolsAvailable?: boolean;
	boundaryGarbage?: BoundaryGarbageDiagnosis;
	repeatedToolCall?: RepeatedToolCallFacts;
}

export interface IncompleteStopEventTarget {
	emit?: (event: string, facts: IncompleteStopFacts) => unknown;
}

export function buildIncompleteStopFacts(
	input: BuildIncompleteStopFactsInput,
): IncompleteStopFacts | undefined {
	if (!input.message || typeof input.message !== "object") return undefined;
	const message = input.message as Record<string, unknown>;
	if (message.role !== "assistant") return undefined;
	if (message.stopReason !== "stop") return undefined;

	const visibleText = extractTextByKinds(message.content, ["text"]).trim();
	const thinkingText = extractTextByKinds(message.content, [
		"thinking",
		"reasoning",
	]).trim();
	const toolCalls = extractToolCalls(message.content);
	const emptyStop =
		visibleText.length === 0 &&
		thinkingText.length === 0 &&
		toolCalls.length === 0;
	const toolsAvailable = input.toolsAvailable === true;
	const actionlessStop =
		emptyStop ||
		(toolsAvailable &&
			visibleText.length === 0 &&
			toolCalls.length === 0 &&
			thinkingText.length > 0);
	const toolIntentStop =
		toolsAvailable && toolCalls.length === 0
			? detectToolIntentText(visibleText)
			: { hit: false };
	const boundaryGarbage = input.boundaryGarbage ?? {
		hit: false,
		inText: false,
		inThinking: false,
		hasProtocolLeak: false,
	};
	const repeatedToolCall = input.repeatedToolCall ?? { hit: false };

	return {
		version: 1,
		provider: "omlx",
		modelId: input.modelId,
		turnIndex: input.turnIndex,
		stopReason:
			typeof message.stopReason === "string" ? message.stopReason : undefined,
		toolResultCount: input.toolResultCount,
		toolsAvailable,
		hasVisibleText: visibleText.length > 0,
		hasThinking: thinkingText.length > 0,
		hasToolCalls: toolCalls.length > 0,
		textPreview: visibleText ? visibleText.slice(0, PREVIEW_CHARS) : undefined,
		thinkingPreview: thinkingText
			? thinkingText.slice(0, PREVIEW_CHARS)
			: undefined,
		boundaryGarbage,
		repeatedToolCall,
		toolIntentStop,
		emptyStop,
		autoRetryEligible:
			boundaryGarbage.hit || actionlessStop || toolIntentStop.hit,
		turnKey: buildTurnKey({
			modelId: input.modelId,
			turnIndex: input.turnIndex,
			stopReason:
				typeof message.stopReason === "string" ? message.stopReason : undefined,
			toolResultCount: input.toolResultCount,
			hasVisibleText: visibleText.length > 0,
			hasThinking: thinkingText.length > 0,
			hasToolCalls: toolCalls.length > 0,
			textPreview: visibleText.slice(0, 80),
			thinkingPreview: thinkingText.slice(0, 80),
		}),
	};
}

export function isEmptyUnusableAssistantStop(
	facts: IncompleteStopFacts,
): boolean {
	return (
		facts.emptyStop &&
		!facts.hasVisibleText &&
		!facts.hasThinking &&
		!facts.hasToolCalls
	);
}

export function isActionlessUnusableAssistantStop(
	facts: IncompleteStopFacts,
): boolean {
	return (
		facts.emptyStop ||
		(facts.toolsAvailable &&
			!facts.hasVisibleText &&
			!facts.hasToolCalls &&
			facts.hasThinking)
	);
}

export function detectToolIntentText(text: string): ToolIntentStopFacts {
	const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
	if (!normalized || normalized.length > 600) return { hit: false };

	const intent = normalized.match(
		/\b(let me|now let me|i(?:'ll| will| need to| am going to|'m going to)|i should)\b/,
	);
	if (!intent) return { hit: false };

	const action = normalized.match(
		/\b(write|edit|create|save|update|modify|inspect|read|run|execute|check|verify|search|fetch|open|delete|remove|add|patch)\b/,
	);
	if (!action) return { hit: false };

	return {
		hit: true,
		reason: `${intent[1]}:${action[1]}`,
	};
}

export function classifyActionlessStopRecovery(
	facts: IncompleteStopFacts,
	retryInFlight: boolean,
): "none" | "retry" | "failed" {
	if (!isActionlessUnusableAssistantStop(facts)) return "none";
	return retryInFlight ? "failed" : "retry";
}

// Classify truly empty stop: no text, no thinking, no tool calls whatsoever.
// A truly empty stop means the model produced zero output tokens.
export function classifyTrulyEmptyStopRecovery(
	facts: IncompleteStopFacts,
	retryInFlight: boolean,
): "none" | "retry" | "failed" {
	if (!facts.emptyStop) return "none";
	if (facts.hasVisibleText || facts.hasThinking || facts.hasToolCalls)
		return "none";
	return retryInFlight ? "failed" : "retry";
}

// Classify thinking-only stop: model produced thinking but stopped before visible text or tool call.
// Unlike truly empty stops, these have N tokens of reasoning output — the model is
// still active, just incomplete. Be patient, do NOT disable thinking in the steer.
export function classifyThinkingOnlyStopRecovery(
	facts: IncompleteStopFacts,
	retryCount: number,
	maxRetries = 16,
): "none" | "retry" | "failed" {
	if (!facts.toolsAvailable) return "none";
	if (!facts.hasThinking) return "none";
	if (facts.hasVisibleText || facts.hasToolCalls) return "none";
	return retryCount >= maxRetries ? "failed" : "retry";
}

// Keep classifyEmptyStopRecovery as backward compat alias (same as classifyActionlessStopRecovery).
export const classifyEmptyStopRecovery = classifyActionlessStopRecovery;

export function classifyToolIntentStopRecovery(
	facts: IncompleteStopFacts,
	retryCount: number,
	maxRetries = 2,
): "none" | "retry" | "failed" {
	if (!facts.toolIntentStop.hit) return "none";
	if (!facts.toolsAvailable) return "none";
	if (facts.hasToolCalls) return "none";
	return retryCount >= maxRetries ? "failed" : "retry";
}

export function extractToolValidationError(
	toolResults: unknown[],
): ToolValidationErrorFacts {
	for (const result of toolResults) {
		if (!result || typeof result !== "object") continue;
		const record = result as Record<string, unknown>;
		if (record.isError !== true) continue;

		const text = extractToolResultText(record);
		const validationHit =
			/\bValidation failed for tool\b/i.test(text) ||
			/\bReceived arguments:\b/i.test(text) ||
			/\bmust have required properties\b/i.test(text);
		if (!validationHit) continue;

		const toolName =
			typeof record.toolName === "string"
				? record.toolName
				: parseToolNameFromValidationText(text);
		return {
			hit: true,
			toolName,
			preview: text.slice(0, PREVIEW_CHARS),
		};
	}
	return { hit: false };
}

export function classifyToolValidationRecovery(
	facts: IncompleteStopFacts,
	validationError: ToolValidationErrorFacts | undefined,
	retryCount: number,
	maxRetries = 2,
): "none" | "retry" | "failed" {
	if (!validationError?.hit) return "none";
	if (facts.toolResultCount > 0) return "none";
	if (facts.hasToolCalls || facts.hasVisibleText) return "none";
	if (!facts.emptyStop && !facts.hasThinking) return "none";
	return retryCount >= maxRetries ? "failed" : "retry";
}

export function emitIncompleteStopFactsEvent(
	events: IncompleteStopEventTarget | undefined,
	facts: IncompleteStopFacts,
	onError?: (err: unknown) => void,
): boolean {
	if (typeof events?.emit !== "function") return false;
	try {
		const result = events.emit(OMLX_INCOMPLETE_STOP_EVENT, facts);
		if (result && typeof (result as Promise<unknown>).then === "function") {
			(result as Promise<unknown>).catch((err) => onError?.(err));
		}
		return true;
	} catch (err) {
		onError?.(err);
		return false;
	}
}

function extractToolResultText(record: Record<string, unknown>): string {
	const content = record.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (typeof item === "string") return item;
			if (!item || typeof item !== "object") return "";
			const itemRecord = item as Record<string, unknown>;
			if (typeof itemRecord.text === "string") return itemRecord.text;
			if (typeof itemRecord.content === "string") return itemRecord.content;
			return "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

function parseToolNameFromValidationText(text: string): string | undefined {
	const match = text.match(/Validation failed for tool "([^"]+)"/i);
	return match?.[1];
}

function buildTurnKey(parts: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(parts)).toString("base64url").slice(0, 96);
}

function extractTextByKinds(content: unknown, kinds: string[]): string {
	if (typeof content === "string") return kinds.includes("text") ? content : "";
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const record = item as Record<string, unknown>;
			if (typeof record.type !== "string" || !kinds.includes(record.type))
				return "";
			if (typeof record.text === "string") return record.text;
			if (
				(record.type === "thinking" || record.type === "reasoning") &&
				typeof record.thinking === "string"
			) {
				return record.thinking;
			}
			return "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

function extractToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.map((item) => {
			if (!item || typeof item !== "object") return undefined;
			const record = item as Record<string, unknown>;
			return record.type === "toolCall" && typeof record.name === "string"
				? record.name
				: undefined;
		})
		.filter((item): item is string => typeof item === "string");
}
