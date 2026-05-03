type ContentItem = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
};

type MessageLike = {
	role?: string;
	stopReason?: string;
	content?: string | ContentItem[];
};

export type BoundaryGarbageDiagnosis = {
	hit: boolean;
	inText: boolean;
	inThinking: boolean;
	hasProtocolLeak: boolean;
	normalizedText: string;
	normalizedThinking: string;
};

function joinContentByType(
	content: string | ContentItem[] | undefined,
	wantedType: string,
): string {
	if (typeof content === "string") {
		return wantedType === "text" ? content : "";
	}

	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];

	for (const item of content) {
		if (!item || typeof item !== "object") continue;

		if (
			wantedType === "text" &&
			item.type === "text" &&
			typeof item.text === "string"
		) {
			parts.push(item.text);
		}

		if (
			wantedType === "thinking" &&
			item.type === "thinking" &&
			typeof item.thinking === "string"
		) {
			parts.push(item.thinking);
		}
	}

	return parts.join("\n").trim();
}

function countToolCalls(content: string | ContentItem[] | undefined): number {
	if (!Array.isArray(content)) {
		return 0;
	}

	let count = 0;

	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		if (item.type === "toolCall") count += 1;
	}

	return count;
}

function normalizeProtocolText(value: string): string {
	return value.replace(/\s+/g, "").trim();
}

export function hasProtocolMarkupLeak(value: string): boolean {
	return /<\/?(?:tool_call|tool_response)>|<\/?(?:function|parameter)(?:=[^>\s]+)?\s*>|<\|im_(?:start|end)\|>/i.test(
		value,
	);
}

function isProtocolOnlyGarbage(value: string): boolean {
	const normalized = normalizeProtocolText(value);

	if (!normalized) {
		return false;
	}

	const exactBad = new Set([
		"</tool_response>",
		"<tool_response>",
		"</tool_call>",
		"<tool_call>",
		"</function>",
		"</parameter>",
	]);

	if (exactBad.has(normalized)) {
		return true;
	}

	const stripped = normalized
		.replace(/<\/?tool_response>/g, "")
		.replace(/<\/?tool_call>/g, "")
		.replace(/<\/function>/g, "")
		.replace(/<\/parameter>/g, "")
		.replace(/<function=[^>]*>/g, "")
		.replace(/<parameter=[^>]*>/g, "")
		.trim();

	return stripped.length === 0;
}

function buildNoHitDiagnosis(): BoundaryGarbageDiagnosis {
	return {
		hit: false,
		inText: false,
		inThinking: false,
		hasProtocolLeak: false,
		normalizedText: "",
		normalizedThinking: "",
	};
}

function previousTurnWasToolResult(
	previousMessage: MessageLike | undefined,
): boolean {
	if (!previousMessage) return false;
	return (
		previousMessage.role === "toolResult" || previousMessage.role === "tool"
	);
}

export function diagnoseBoundaryGarbage(
	previousMessage: MessageLike | undefined,
	assistantMessage: MessageLike | undefined,
): BoundaryGarbageDiagnosis {
	if (!previousTurnWasToolResult(previousMessage)) {
		return buildNoHitDiagnosis();
	}

	if (!assistantMessage || assistantMessage.role !== "assistant") {
		return buildNoHitDiagnosis();
	}

	const stopReason = assistantMessage.stopReason ?? "";
	if (stopReason !== "stop") {
		return buildNoHitDiagnosis();
	}

	const toolCallCount = countToolCalls(assistantMessage.content);
	if (toolCallCount > 0) {
		return buildNoHitDiagnosis();
	}

	const text = joinContentByType(assistantMessage.content, "text");
	const thinking = joinContentByType(assistantMessage.content, "thinking");

	const normalizedText = normalizeProtocolText(text);
	const normalizedThinking = normalizeProtocolText(thinking);

	const inText = isProtocolOnlyGarbage(text);
	const inThinking = isProtocolOnlyGarbage(thinking);
	const hasProtocolLeak =
		hasProtocolMarkupLeak(text) || hasProtocolMarkupLeak(thinking);

	return {
		hit: inText || inThinking || hasProtocolLeak,
		inText,
		inThinking,
		hasProtocolLeak,
		normalizedText,
		normalizedThinking,
	};
}

export function shouldRetryBoundaryGarbage(
	previousMessage: MessageLike | undefined,
	assistantMessage: MessageLike | undefined,
): boolean {
	return diagnoseBoundaryGarbage(previousMessage, assistantMessage).hit;
}
