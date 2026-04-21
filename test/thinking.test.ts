import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyOmlxThinkingControls } from "../src/thinking.ts";

test("applyOmlxThinkingControls disables thinking explicitly", () => {
	const payload = applyOmlxThinkingControls({
		model: "Qwen3.6-35B-A3B-4bit-DWQ",
		chat_template_kwargs: { tools: ["x"] },
	}, "off") as Record<string, unknown>;

	assert.equal(payload.thinking_budget, 0);
	assert.deepEqual(payload.chat_template_kwargs, { tools: ["x"], enable_thinking: false });
});

test("applyOmlxThinkingControls maps medium thinking to explicit budget", () => {
	const payload = applyOmlxThinkingControls({ model: "Qwen3.6-35B-A3B-4bit-DWQ" }, "medium") as Record<string, unknown>;

	assert.equal(payload.thinking_budget, 4096);
	assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: true });
});
