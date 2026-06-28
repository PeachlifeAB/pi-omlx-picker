import type { AssistantMessage } from "@earendil-works/pi-ai";

export const FREE_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
} as const;

export const ZERO_USAGE: AssistantMessage["usage"] = {
	...FREE_COST,
	totalTokens: 0,
	cost: { ...FREE_COST, total: 0 },
};
