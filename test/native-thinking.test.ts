import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	deriveNativeThinkingProjection,
	normalizePiThinkingLevel,
	piThinkingLevelFromBudgetTokens,
} from "../src/native-thinking.ts";

test("deriveNativeThinkingProjection maps explicit disabled thinking to off", () => {
	assert.deepEqual(deriveNativeThinkingProjection({
		sourcePrefix: "model_settings",
		enableThinking: false,
		enableThinkingSource: "model_settings.chat_template_kwargs.enable_thinking",
		thinkingBudgetTokens: 8192,
	}), {
		level: "off",
		source: "model_settings.chat_template_kwargs.enable_thinking",
		detail: "false",
	});
});

test("deriveNativeThinkingProjection prefers explicit reasoning effort", () => {
	assert.deepEqual(deriveNativeThinkingProjection({
		sourcePrefix: "model_settings",
		enableThinking: true,
		thinkingBudgetTokens: 2048,
		reasoningEffort: "high",
	}), {
		level: "high",
		source: "model_settings.chat_template_kwargs.reasoning_effort",
		detail: "high",
	});
});

test("deriveNativeThinkingProjection maps thinking budget tokens to nearest Pi level", () => {
	assert.equal(piThinkingLevelFromBudgetTokens(1024), "minimal");
	assert.equal(piThinkingLevelFromBudgetTokens(2048), "low");
	assert.equal(piThinkingLevelFromBudgetTokens(8192), "medium");
	assert.equal(piThinkingLevelFromBudgetTokens(16384), "high");
	assert.deepEqual(deriveNativeThinkingProjection({
		sourcePrefix: "model_settings",
		thinkingBudgetTokens: 12000,
	}), {
		level: "medium",
		source: "model_settings.thinking_budget_tokens",
		detail: "12000",
	});
});

test("deriveNativeThinkingProjection uses medium for explicit enablement without a budget", () => {
	assert.deepEqual(deriveNativeThinkingProjection({
		sourcePrefix: "model_settings",
		enableThinking: true,
	}), {
		level: "medium",
		source: "model_settings.enable_thinking",
		detail: "true",
	});
});

test("normalizePiThinkingLevel handles Pi-native aliases only", () => {
	assert.equal(normalizePiThinkingLevel("off"), "off");
	assert.equal(normalizePiThinkingLevel("none"), "off");
	assert.equal(normalizePiThinkingLevel("x-high"), "xhigh");
	assert.equal(normalizePiThinkingLevel("ultra"), undefined);
});
