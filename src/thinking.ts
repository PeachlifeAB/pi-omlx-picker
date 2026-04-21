type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const THINKING_BUDGETS: Record<ThinkingLevel, number> = {
	off: 0,
	minimal: 1024,
	low: 2048,
	medium: 4096,
	high: 8192,
	xhigh: 16384,
};

export function applyOmlxThinkingControls(payload: unknown, level: ThinkingLevel): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

	const current = payload as Record<string, unknown>;
	const enabled = level !== "off";
	const chatTemplateKwargs = current.chat_template_kwargs;

	return {
		...current,
		thinking_budget: THINKING_BUDGETS[level],
		chat_template_kwargs: {
			...(chatTemplateKwargs && typeof chatTemplateKwargs === "object" && !Array.isArray(chatTemplateKwargs)
				? (chatTemplateKwargs as Record<string, unknown>)
				: {}),
			enable_thinking: enabled,
		},
	};
}
