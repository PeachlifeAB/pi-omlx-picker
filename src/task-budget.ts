import type { OmlxModel } from "./catalog.ts";

export type TaskBudgetWarning = "20_percent" | "5_percent";

export interface TaskBudgetState {
	modelId?: string;
	totalTokens?: number;
	usedOutputTokens: number;
	warned20Percent: boolean;
	warned5Percent: boolean;
}

export interface TaskBudgetUpdate {
	state: TaskBudgetState;
	warning?: TaskBudgetWarning;
}

export function resetTaskBudget(
	model: Pick<OmlxModel, "id" | "taskBudgetTokens"> | undefined,
): TaskBudgetState {
	const totalTokens =
		typeof model?.taskBudgetTokens === "number" && model.taskBudgetTokens > 0
			? model.taskBudgetTokens
			: undefined;
	return {
		modelId: model?.id,
		totalTokens,
		usedOutputTokens: 0,
		warned20Percent: false,
		warned5Percent: false,
	};
}

export function recordTaskBudgetUsage(
	current: TaskBudgetState,
	outputTokens: number | undefined,
): TaskBudgetUpdate {
	if (outputTokens === undefined || outputTokens <= 0)
		return { state: current };
	const usedOutputTokens = current.usedOutputTokens + outputTokens;
	const next: TaskBudgetState = {
		...current,
		usedOutputTokens,
	};
	const remainingRatio = getTaskBudgetRemainingRatio(next);
	if (remainingRatio === undefined) return { state: next };

	if (remainingRatio <= 0.05 && !next.warned5Percent) {
		next.warned5Percent = true;
		next.warned20Percent = true;
		return { state: next, warning: "5_percent" };
	}
	if (remainingRatio <= 0.2 && !next.warned20Percent) {
		next.warned20Percent = true;
		return { state: next, warning: "20_percent" };
	}
	return { state: next };
}

export function getTaskBudgetRemainingTokens(
	state: TaskBudgetState,
): number | undefined {
	if (state.totalTokens === undefined) return undefined;
	return Math.max(state.totalTokens - state.usedOutputTokens, 0);
}

export function getTaskBudgetRemainingRatio(
	state: TaskBudgetState,
): number | undefined {
	const totalTokens = state.totalTokens;
	if (totalTokens === undefined || totalTokens <= 0) return undefined;
	const remainingTokens = Math.max(totalTokens - state.usedOutputTokens, 0);
	return remainingTokens / totalTokens;
}

export function buildTaskBudgetSteer(
	state: TaskBudgetState,
	warning: TaskBudgetWarning,
): string {
	const remaining = getTaskBudgetRemainingTokens(state);
	const pct = getTaskBudgetRemainingRatio(state);
	const remainingText =
		remaining === undefined || pct === undefined
			? "the configured task budget is nearly exhausted"
			: `${formatInteger(remaining)} tokens remain (${Math.round(pct * 100)}%)`;
	if (warning === "5_percent") {
		return `OMLX task budget critical: ${remainingText}. Prioritize the final answer or the single highest-value next tool call. Avoid broad exploration.`;
	}
	return `OMLX task budget low: ${remainingText}. Tighten the plan, avoid optional exploration, and spend remaining output on the user's requested outcome.`;
}

function formatInteger(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}
