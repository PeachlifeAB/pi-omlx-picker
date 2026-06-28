import { strict as assert } from "node:assert";
import { test } from "vitest";
import { thinkingFormatFor } from "../src/thinking-format.ts";

test("maps reported reasoning parsers to the OMLX chat-template format", () => {
	assert.equal(thinkingFormatFor("qwen"), "qwen-chat-template");
	assert.equal(thinkingFormatFor("qwen_3_coder"), "qwen-chat-template");
	assert.equal(thinkingFormatFor("llama"), "qwen-chat-template");
	assert.equal(thinkingFormatFor("harmony"), "qwen-chat-template");
	assert.equal(thinkingFormatFor("deepseek_v4"), "qwen-chat-template");
});

test("is case-insensitive on the parser name", () => {
	assert.equal(thinkingFormatFor("QWEN_3_CODER"), "qwen-chat-template");
});

test("an unknown reported parser falls back to the openai format", () => {
	assert.equal(thinkingFormatFor("some-future-parser"), "openai");
});

test("no reported parser falls back to pi-ai's openai default", () => {
	assert.equal(thinkingFormatFor(undefined), "openai");
	assert.equal(thinkingFormatFor(""), "openai");
});
