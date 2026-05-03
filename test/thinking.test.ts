import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyOmlxThinkingControls } from "../src/thinking.ts";

test("applyOmlxThinkingControls disables thinking explicitly", () => {
	const payload = applyOmlxThinkingControls({
		model: "Qwen3.6-35B-A3B-4bit-DWQ",
		thinking_budget: 32768,
		chat_template_kwargs: { tools: ["x"] },
	}, "off", true) as Record<string, unknown>;

	assert.equal(payload.thinking_budget, 0);
	assert.deepEqual(payload.chat_template_kwargs, { tools: ["x"], enable_thinking: false });
});

test("applyOmlxThinkingControls preserves Pi-computed thinking budget for capable models", () => {
	const payload = applyOmlxThinkingControls({
		model: "Qwen3.6-35B-A3B-4bit-DWQ",
		thinking_budget: 10240,
		chat_template_kwargs: { enable_thinking: true },
	}, "medium", true) as Record<string, unknown>;

	assert.equal(payload.thinking_budget, 10240);
	assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: true });
});

test("applyOmlxThinkingControls does not manually enable thinking for capable models", () => {
	const payload = applyOmlxThinkingControls({ model: "Qwen3.6-35B-A3B-4bit-DWQ" }, "medium", true) as Record<string, unknown>;

	assert.equal("thinking_budget" in payload, false);
	assert.equal("chat_template_kwargs" in payload, false);
});

test("applyOmlxThinkingControls does not invent an xhigh OMLX budget", () => {
	const payload = applyOmlxThinkingControls({ model: "Qwen3.6-35B-A3B-4bit-DWQ" }, "xhigh", true) as Record<string, unknown>;

	assert.equal("thinking_budget" in payload, false);
	assert.equal("chat_template_kwargs" in payload, false);
});

test("applyOmlxThinkingControls disables thinking when model metadata is false", () => {
	const payload = applyOmlxThinkingControls({ model: "non-thinking", thinking_budget: 32768 }, "high", false) as Record<string, unknown>;

	assert.equal(payload.thinking_budget, 0);
	assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: false });
});

test("applyOmlxThinkingControls disables thinking when model metadata is missing or null", () => {
	for (const metadata of [undefined, null]) {
		const payload = applyOmlxThinkingControls({ model: "unknown" }, "medium", metadata) as Record<string, unknown>;
		assert.equal(payload.thinking_budget, 0);
		assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: false });
	}
});
