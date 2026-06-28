import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Model,
} from "@earendil-works/pi-ai";
import { ZERO_USAGE } from "./pricing.ts";

export function isMeaningfulBodyEvent(event: AssistantMessageEvent): boolean {
	return [
		"text_start",
		"text_delta",
		"thinking_start",
		"thinking_delta",
		"toolcall_start",
		"toolcall_delta",
		"done",
		"error",
	].includes(event.type);
}

export function isThinkingEvent(event: AssistantMessageEvent): boolean {
	return (
		event.type === "thinking_start" ||
		event.type === "thinking_delta" ||
		event.type === "thinking_end"
	);
}

export function eventPartial(
	event: AssistantMessageEvent,
	model: Model<Api>,
): AssistantMessage {
	if ("partial" in event) return event.partial;
	if ("message" in event) return event.message;
	if ("error" in event) return event.error;
	return errorAssistantMessage(
		model,
		"OMLX stream started without a start event",
	);
}

export function errorAssistantMessage(
	model: Model<Api>,
	errorMessage: string,
	stopReason: "error" | "aborted" = "error",
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}
