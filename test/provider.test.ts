import { strict as assert } from "node:assert";
import { test } from "vitest";
import { toProviderConfig } from "../src/provider.ts";

test("toProviderConfig marks only explicit thinking_default true as reasoning capable", () => {
	const config = toProviderConfig("http://example.test/v1", "OMLX_API_KEY", [
		{ id: "qwen", thinkingDefault: true },
		{ id: "gemma", thinkingDefault: false },
		{ id: "plain" },
		{ id: "no-toggle", thinkingDefault: null },
	]);

	assert.equal(config.models?.[0]?.reasoning, true);
	assert.equal(config.models?.[1]?.reasoning, false);
	assert.equal(config.models?.[2]?.reasoning, false);
	assert.equal(config.models?.[3]?.reasoning, false);
	assert.deepEqual(config.models?.[0]?.compat, {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsLongCacheRetention: true,
		maxTokensField: "max_tokens",
		thinkingFormat: "qwen-chat-template",
	});
	assert.deepEqual(config.models?.[1]?.compat, {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsLongCacheRetention: true,
		maxTokensField: "max_tokens",
	});
	assert.deepEqual(config.models?.[2]?.compat, {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsLongCacheRetention: true,
		maxTokensField: "max_tokens",
	});
	assert.deepEqual(config.models?.[3]?.compat, {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsLongCacheRetention: true,
		maxTokensField: "max_tokens",
	});
});

test("toProviderConfig maps displayName to Pi name and keeps OMLX-only settings out of provider model", () => {
	const config = toProviderConfig("http://example.test/v1", "OMLX_API_KEY", [
		{
			id: "raw-model-id",
			displayName: "Human Model Name",
			description: "Shown in /omlx-status only",
			taskBudgetTokens: 64000,
			maxToolResultTokens: 4096,
			settingsSummary: { sampling: { temperature: 0.2 } },
		},
	]);

	const model = config.models?.[0] as unknown as Record<string, unknown>;
	assert.equal(model.name, "Human Model Name");
	assert.equal(model.id, "raw-model-id");
	assert.equal("description" in model, false);
	assert.equal("taskBudgetTokens" in model, false);
	assert.equal("maxToolResultTokens" in model, false);
	assert.equal("settingsSummary" in model, false);
});
