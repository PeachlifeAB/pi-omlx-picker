export function applyOmlxThinkingControls(
	payload: unknown,
	level: string,
	modelThinkingDefault?: boolean | null,
): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return payload;

	const current = payload as Record<string, unknown>;
	const enabled = modelThinkingDefault === true && level !== "off";
	const chatTemplateKwargs = current.chat_template_kwargs;
	const existingChatTemplateKwargs =
		chatTemplateKwargs &&
		typeof chatTemplateKwargs === "object" &&
		!Array.isArray(chatTemplateKwargs)
			? (chatTemplateKwargs as Record<string, unknown>)
			: {};

	if (enabled) return current;

	return {
		...current,
		thinking_budget: 0,
		chat_template_kwargs: {
			...existingChatTemplateKwargs,
			enable_thinking: false,
		},
	};
}
