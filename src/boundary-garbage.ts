type ContentItem = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
};

export type MessageLike = {
	role?: string;
	stopReason?: string;
	customType?: string;
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

// Matches any of the known protocol/chat-template markers.
const PROTOCOL_TAG_RE =
	/<\/?(?:tool_call|tool_response)>|<\/?(?:function|parameter)(?:=[^>\s]+)?\s*>|<\|im_(?:start|end)\|>/i;

// Matches a fenced code block (``` ... ```) — used to detect explanation context.
const FENCED_CODE_RE = /```[\s\S]*?```/g;

// Matches a protocol tag standing alone on its own line (possibly with whitespace).
const TAG_ALONE_ON_LINE_RE =
	/^[ \t]*(?:<\/?(?:tool_call|tool_response)>|<\/?(?:function|parameter)(?:=[^>\s]+)?\s*>|<\|im_(?:start|end)\|>)[ \t]*$/im;

// Words in surrounding *prose* that indicate an explanation context.
// Matched against text with protocol tags stripped, so tag names themselves
// don't trigger this (e.g. </parameter> should not match "parameter").
const EXPLANATION_CONTEXT_RE =
	/\b(?:tag|tags|template|marker|token|tokens|syntax|Qwen|chat.template|chat template|delimiter|format|im_start|im_end)\b/i;

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
	return PROTOCOL_TAG_RE.test(value);
}

// True when the text is entirely made up of protocol tags (no meaningful prose).
function isProtocolOnlyGarbage(value: string): boolean {
	const normalized = normalizeProtocolText(value);

	if (!normalized) {
		return false;
	}

	const stripped = normalized
		.replace(/<\/?tool_response>/gi, "")
		.replace(/<\/?tool_call>/gi, "")
		.replace(/<\/function>/gi, "")
		.replace(/<\/parameter>/gi, "")
		.replace(/<function=[^>]*>/gi, "")
		.replace(/<parameter=[^>]*>/gi, "")
		.replace(/<\|im_(?:start|end)\|>/gi, "")
		.trim();

	return stripped.length === 0;
}

// True when the text begins immediately with a protocol tag (no prose before it),
// indicating syntax-shaped corruption rather than an explanation.
const STARTS_WITH_TAG_RE =
	/^[ \t\n\r]*(?:<\/?(?:tool_call|tool_response)>|<\/?(?:function|parameter)(?:=[^>\s]+)?\s*>|<\|im_(?:start|end)\|>)/i;

function startsWithOrphanProtocolTag(value: string): boolean {
	return STARTS_WITH_TAG_RE.test(value);
}

// True when the text is explanation-shaped: protocol markers appear inside code
// fences, wrapped in backticks, or in prose that explicitly discusses protocol syntax.
function isExplanationShapedProtocolText(value: string): boolean {
	if (!hasProtocolMarkupLeak(value)) return false;

	// Markers only inside fenced code blocks → explanation.
	const withoutFences = value.replace(FENCED_CODE_RE, "");
	if (!hasProtocolMarkupLeak(withoutFences)) return true;

	// Marker wrapped in backticks inline → explanation.
	if (
		/`[^`]*(?:<\/?(?:tool_call|tool_response|function|parameter)[^>]*>|<\|im_(?:start|end)\|>)[^`]*`/i.test(
			value,
		)
	) {
		return true;
	}

	// Surrounding prose explicitly discusses protocol syntax → explanation.
	// Strip tags first so tag names like "parameter" or "function" don't match.
	const prose = value
		.replace(/<\/?(?:tool_call|tool_response)>/gi, "")
		.replace(/<\/?(?:function|parameter)(?:=[^>\s]+)?\s*>/gi, "")
		.replace(/<\|im_(?:start|end)\|>/gi, "");
	if (EXPLANATION_CONTEXT_RE.test(prose)) return true;

	return false;
}

// True when a tag appears alone on its own line — strong corruption signal.
function isSyntaxShapedProtocolText(value: string): boolean {
	if (!hasProtocolMarkupLeak(value)) return false;
	return TAG_ALONE_ON_LINE_RE.test(value) || startsWithOrphanProtocolTag(value);
}

export function previousTurnWasToolResult(
	previousMessage: MessageLike | undefined,
): boolean {
	if (!previousMessage) return false;
	return (
		previousMessage.role === "toolResult" || previousMessage.role === "tool"
	);
}

// True when the previous message was an OMLX boundary-recovery steer, which
// means we are already in a recovery episode and mixed protocol/prose should
// be treated as continued corruption.
function previousTurnWasRecoverySteer(
	previousMessage: MessageLike | undefined,
): boolean {
	if (!previousMessage) return false;
	return previousMessage.customType === "omlx-boundary-recovery";
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

export function diagnoseBoundaryGarbage(
	previousMessage: MessageLike | undefined,
	assistantMessage: MessageLike | undefined,
): BoundaryGarbageDiagnosis {
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

	// Rule 1: protocol-only visible text → always corrupt.
	const inText = isProtocolOnlyGarbage(text);

	// Rule 2: protocol markers in thinking → always corrupt (reasoning never
	// looks like </tool_call>; this is a chat-template leak).
	const inThinking = hasProtocolMarkupLeak(thinking);

	const hasProtocolLeak =
		hasProtocolMarkupLeak(text) || hasProtocolMarkupLeak(thinking);

	let hit = inText || inThinking;

	if (!hit && hasProtocolMarkupLeak(text)) {
		// Rule 3: visible text starts with orphan closing tags → syntax-shaped
		// corruption regardless of previous turn or later prose.
		if (startsWithOrphanProtocolTag(text)) {
			hit = true;
		}
		// Rule 4: explanation-shaped content → pass through before lower-confidence
		// corruption checks. The assistant is discussing protocol syntax, not
		// leaking it. Checked before generic tag-alone detection so fenced code
		// examples can contain tags on their own lines.
		else if (isExplanationShapedProtocolText(text)) {
			hit = false;
		}
		// Rule 5: remaining syntax-shaped text, such as a tag alone on a line →
		// corruption regardless of previous turn.
		else if (isSyntaxShapedProtocolText(text)) {
			hit = true;
		}
		// Rule 6: mixed protocol/prose after a boundary-sensitive previous turn →
		// high-confidence corruption even with surrounding prose.
		else if (
			previousTurnWasToolResult(previousMessage) ||
			previousTurnWasRecoverySteer(previousMessage)
		) {
			hit = true;
		}
		// Rule 7: unrecognized mixed case → treat as corruption to be safe.
		else {
			hit = true;
		}
	}

	return {
		hit,
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
