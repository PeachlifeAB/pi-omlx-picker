import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selectNonThinkingSmokeModel } from "../src/smoke-model-selection.ts";

test("selectNonThinkingSmokeModel prefers loaded chat models", () => {
	const models = [
		{
			id: "small-unloaded",
			thinking_default: false,
			loaded: false,
			engine_type: "batched",
			model_type: "llm",
			estimated_size: 100,
		},
		{
			id: "loaded-chat",
			thinking_default: null,
			loaded: true,
			engine_type: "batched",
			model_type: "llm",
			estimated_size: 10000,
		},
	];

	assert.equal(selectNonThinkingSmokeModel(models), "loaded-chat");
});

test("selectNonThinkingSmokeModel skips large VLM models when a smaller chat model exists", () => {
	const models = [
		{
			id: "Gemma-4-31B-JANG_4M-CRACK",
			thinking_default: false,
			loaded: false,
			engine_type: "vlm",
			model_type: "vlm",
			estimated_size: 23792777517,
		},
		{
			id: "Qwen2.5-0.5B-Instruct-MLX-4bit",
			thinking_default: null,
			loaded: false,
			engine_type: "batched",
			model_type: "llm",
			estimated_size: 291968166,
		},
	];

	assert.equal(selectNonThinkingSmokeModel(models), "Qwen2.5-0.5B-Instruct-MLX-4bit");
});
