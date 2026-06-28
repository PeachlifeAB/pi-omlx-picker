import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
} from "@earendil-works/pi-ai";

const REPEAT_THINKING_SIMILARITY = 0.85;
const REPEAT_TEXT_MAX_CHARS = 400;

type AssistantParts = { thinking: string; text: string; toolCount: number };

function extractAssistantParts(message: AssistantMessage): AssistantParts {
	let thinking = "";
	let text = "";
	let toolCount = 0;
	for (const block of message.content) {
		if (block.type === "thinking") thinking += block.thinking;
		else if (block.type === "text") text += block.text;
		else if (block.type === "toolCall") toolCount++;
	}
	return {
		thinking: thinking.trim(),
		text: text.trim(),
		toolCount,
	};
}

function lastAssistantMessage(
	messages: Message[],
): AssistantMessage | undefined {
	const last = messages.at(-1);
	return last?.role === "assistant" ? last : undefined;
}

function bigramCounts(s: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (let i = 0; i < s.length - 1; i++) {
		const g = s.slice(i, i + 2);
		counts.set(g, (counts.get(g) ?? 0) + 1);
	}
	return counts;
}

function textSimilarity(a: string, b: string): number {
	if (a === b) return a ? 1 : 0;
	if (!a || !b) return 0;
	const ma = bigramCounts(a);
	const mb = bigramCounts(b);
	let intersection = 0;
	for (const [g, count] of ma) {
		const other = mb.get(g);
		if (other) intersection += Math.min(count, other);
	}
	const total = a.length - 1 + (b.length - 1);
	return total > 0 ? (2 * intersection) / total : 0;
}

export function isRepeatStop(
	event: AssistantMessageEvent,
	context: Context,
): boolean {
	if (event.type !== "done" || event.reason !== "stop") return false;
	const current = extractAssistantParts(event.message);
	if (current.toolCount > 0) return false;
	if (!current.thinking) return false;
	if (current.text.length > REPEAT_TEXT_MAX_CHARS) return false;

	const prev = lastAssistantMessage(context.messages);
	if (!prev) return false;
	const prevParts = extractAssistantParts(prev);
	if (!prevParts.thinking) return false;

	return (
		textSimilarity(current.thinking, prevParts.thinking) >=
		REPEAT_THINKING_SIMILARITY
	);
}
