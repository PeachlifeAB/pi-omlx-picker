import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

const OMLX_OVERFLOW_RE =
	/prompt too long[:.]?\s*(\d[\d,]*)\s*tokens?\s*exceeds\s*max(?:imum)?\s*context window of\s*(\d[\d,]*)\s*tokens?/i;

export function normalizeOverflowMessage(errorMessage: string): string {
	if (errorMessage.startsWith("prompt is too long:")) return errorMessage;
	const match = OMLX_OVERFLOW_RE.exec(errorMessage);
	if (!match) return errorMessage;
	const used = match[1];
	const limit = match[2];
	return `prompt is too long: ${used} tokens exceeds the context window of ${limit} tokens (${errorMessage})`;
}

export function normalizeErrorEvent(
	event: AssistantMessageEvent,
): AssistantMessageEvent {
	if (event.type !== "error") return event;
	const err = event.error;
	if (!err || typeof err.errorMessage !== "string") return event;
	const normalized = normalizeOverflowMessage(err.errorMessage);
	if (normalized === err.errorMessage) return event;
	return { ...event, error: { ...err, errorMessage: normalized } };
}
