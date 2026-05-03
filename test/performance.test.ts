import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractOutputTokens, type ModelPerformance, recordPerformanceSample, rollingTokensPerSecond } from "../src/performance.ts";

test("extractOutputTokens supports common usage shapes", () => {
	assert.equal(extractOutputTokens({ usage: { output: 12 } }), 12);
	assert.equal(extractOutputTokens({ usage: { outputTokens: 13 } }), 13);
	assert.equal(extractOutputTokens({ usage: { output_tokens: 14 } }), 14);
	assert.equal(extractOutputTokens({ usage: { completionTokens: 15 } }), 15);
	assert.equal(extractOutputTokens({ usage: { completion_tokens: 16 } }), 16);
	assert.equal(extractOutputTokens({ completion_tokens: 17 }), 17);
});

test("extractOutputTokens returns undefined when usage is unavailable", () => {
	assert.equal(extractOutputTokens({}), undefined);
	assert.equal(extractOutputTokens({ usage: {} }), undefined);
	assert.equal(extractOutputTokens({ usage: { output_tokens: "18" } }), undefined);
	assert.equal(extractOutputTokens(undefined), undefined);
});

test("recordPerformanceSample keeps a rolling last-five sample window", () => {
	let current: ModelPerformance | undefined = undefined;
	for (let i = 0; i < 6; i++) {
		current = recordPerformanceSample(current, "m", i * 1000, i * 1000 + 1000, (i + 1) * 10);
	}
	assert.ok(current);

	assert.equal(current.samples.length, 5);
	assert.equal(current.samples[0]?.outputTokens, 20);
	assert.equal(current.last?.outputTokens, 60);
	assert.equal(current.totalOutputTokens, 210);
	assert.equal(rollingTokensPerSecond(current), 40);
});

test("recordPerformanceSample preserves empty metrics when output token usage is missing", () => {
	const current = recordPerformanceSample(undefined, "m", 0, 1000, undefined);

	assert.deepEqual(current, { samples: [], totalOutputTokens: 0 });
	assert.equal(rollingTokensPerSecond(current), undefined);
});
