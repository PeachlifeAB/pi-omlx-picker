export type PiThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export interface NativeThinkingProjection {
	level: PiThinkingLevel;
	source: string;
	detail?: string;
}

interface NativeThinkingFields {
	sourcePrefix: string;
	enableThinking?: boolean;
	enableThinkingSource?: string;
	thinkingDefault?: boolean | null;
	thinkingBudgetEnabled?: boolean;
	thinkingBudgetTokens?: number;
	reasoningEffort?: unknown;
}

const PI_BUDGETS: Array<{
	level: Exclude<PiThinkingLevel, "off" | "xhigh">;
	tokens: number;
}> = [
	{ level: "minimal", tokens: 1024 },
	{ level: "low", tokens: 2048 },
	{ level: "medium", tokens: 8192 },
	{ level: "high", tokens: 16384 },
];

export function deriveNativeThinkingProjection(
	fields: NativeThinkingFields,
): NativeThinkingProjection | undefined {
	if (fields.enableThinking === false) {
		return {
			level: "off",
			source:
				fields.enableThinkingSource ?? `${fields.sourcePrefix}.enable_thinking`,
			detail: "false",
		};
	}

	if (fields.thinkingBudgetTokens === 0) {
		return {
			level: "off",
			source: `${fields.sourcePrefix}.thinking_budget_tokens`,
			detail: "0",
		};
	}

	const effort = normalizePiThinkingLevel(fields.reasoningEffort);
	if (effort) {
		return {
			level: effort,
			source: `${fields.sourcePrefix}.chat_template_kwargs.reasoning_effort`,
			detail: String(fields.reasoningEffort),
		};
	}

	if (
		typeof fields.thinkingBudgetTokens === "number" &&
		fields.thinkingBudgetTokens > 0
	) {
		return {
			level: piThinkingLevelFromBudgetTokens(fields.thinkingBudgetTokens),
			source: `${fields.sourcePrefix}.thinking_budget_tokens`,
			detail: String(fields.thinkingBudgetTokens),
		};
	}

	if (fields.enableThinking === true) {
		return {
			level: "medium",
			source:
				fields.enableThinkingSource ?? `${fields.sourcePrefix}.enable_thinking`,
			detail: "true",
		};
	}

	if (fields.thinkingBudgetEnabled === true) {
		return {
			level: "medium",
			source: `${fields.sourcePrefix}.thinking_budget_enabled`,
			detail: "true",
		};
	}

	if (fields.thinkingDefault === false) {
		return {
			level: "off",
			source: `${fields.sourcePrefix}.thinking_default`,
			detail: "false",
		};
	}

	return undefined;
}

export function normalizePiThinkingLevel(
	value: unknown,
): PiThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[_\s-]+/g, "");
	switch (normalized) {
		case "off":
		case "none":
		case "disabled":
		case "disable":
			return "off";
		case "minimal":
		case "min":
			return "minimal";
		case "low":
			return "low";
		case "medium":
		case "med":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		default:
			return undefined;
	}
}

export function piThinkingLevelFromBudgetTokens(
	tokens: number,
): Exclude<PiThinkingLevel, "off" | "xhigh"> {
	const firstBudget = PI_BUDGETS[0];
	if (!firstBudget) return "medium";
	let nearest = firstBudget;
	let nearestDistance = Math.abs(tokens - nearest.tokens);
	for (const candidate of PI_BUDGETS.slice(1)) {
		const distance = Math.abs(tokens - candidate.tokens);
		if (distance < nearestDistance) {
			nearest = candidate;
			nearestDistance = distance;
		}
	}
	return nearest.level;
}
