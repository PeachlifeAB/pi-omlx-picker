export interface PerformanceSample {
	modelId: string;
	startedAtMs: number;
	endedAtMs: number;
	durationMs: number;
	outputTokens: number;
	tokensPerSecond: number;
}

export interface ModelPerformance {
	last?: PerformanceSample;
	samples: PerformanceSample[];
	totalOutputTokens: number;
}

export type PerformanceByModel = Record<string, ModelPerformance>;

export function extractOutputTokens(source: unknown): number | undefined {
	const usage = extractUsageRecord(source);
	if (!usage) return undefined;
	for (const key of [
		"output",
		"outputTokens",
		"output_tokens",
		"completionTokens",
		"completion_tokens",
	]) {
		const value = usage[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0)
			return value;
	}
	return undefined;
}

export function recordPerformanceSample(
	current: ModelPerformance | undefined,
	modelId: string,
	startedAtMs: number,
	endedAtMs: number,
	outputTokens: number | undefined,
): ModelPerformance {
	if (outputTokens === undefined) {
		return current ?? { samples: [], totalOutputTokens: 0 };
	}
	const durationMs = Math.max(endedAtMs - startedAtMs, 1);
	const sample: PerformanceSample = {
		modelId,
		startedAtMs,
		endedAtMs,
		durationMs,
		outputTokens,
		tokensPerSecond: outputTokens / (durationMs / 1000),
	};
	const samples = [...(current?.samples ?? []), sample].slice(-5);
	return {
		last: sample,
		samples,
		totalOutputTokens: (current?.totalOutputTokens ?? 0) + outputTokens,
	};
}

export function rollingTokensPerSecond(
	performance: ModelPerformance | undefined,
): number | undefined {
	if (!performance || performance.samples.length === 0) return undefined;
	const outputTokens = performance.samples.reduce(
		(sum, sample) => sum + sample.outputTokens,
		0,
	);
	const durationMs = performance.samples.reduce(
		(sum, sample) => sum + sample.durationMs,
		0,
	);
	if (durationMs <= 0) return undefined;
	return outputTokens / (durationMs / 1000);
}

function extractUsageRecord(
	source: unknown,
): Record<string, unknown> | undefined {
	if (!source || typeof source !== "object" || Array.isArray(source))
		return undefined;
	const record = source as Record<string, unknown>;
	const usage = record.usage;
	if (usage && typeof usage === "object" && !Array.isArray(usage)) {
		return usage as Record<string, unknown>;
	}
	return record;
}
