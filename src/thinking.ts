import type { PiThinkingLevel } from "./native-thinking.ts";

export type { PiThinkingLevel } from "./native-thinking.ts";

export function applyOmlxThinkingControls(
	payload: unknown,
	level: PiThinkingLevel,
	modelThinkingDefault?: boolean | null,
): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return payload;

	const current = payload as Record<string, unknown>;
	// OMLX metadata is treated conservatively: only an explicit true is thinking-capable.
	const enabled = modelThinkingDefault === true && level !== "off";
	const chatTemplateKwargs = current.chat_template_kwargs;
	const existingChatTemplateKwargs =
		chatTemplateKwargs &&
		typeof chatTemplateKwargs === "object" &&
		!Array.isArray(chatTemplateKwargs)
			? (chatTemplateKwargs as Record<string, unknown>)
			: {};

	if (enabled) {
		return current;
	}

	return {
		...current,
		thinking_budget: 0,
		chat_template_kwargs: {
			...existingChatTemplateKwargs,
			enable_thinking: false,
		},
	};
}
