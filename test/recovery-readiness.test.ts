import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getRecoveryThinkingOverrideStatus } from "../src/recovery-readiness.ts";

test("getRecoveryThinkingOverrideStatus reports available chat-template overrides", () => {
	assert.deepEqual(getRecoveryThinkingOverrideStatus({ forcedCtKwargs: ["reasoning_effort"] }), {
		attemptedChatTemplateKeys: ["enable_thinking", "preserve_thinking"],
		blockedChatTemplateKeys: [],
		requestThinkingBudget: 0,
		canOverrideChatTemplateThinking: true,
	});
});

test("getRecoveryThinkingOverrideStatus reports forced OMLX chat-template keys", () => {
	assert.deepEqual(getRecoveryThinkingOverrideStatus({ forcedCtKwargs: ["enable_thinking", "preserve_thinking"] }), {
		attemptedChatTemplateKeys: ["enable_thinking", "preserve_thinking"],
		blockedChatTemplateKeys: ["enable_thinking", "preserve_thinking"],
		requestThinkingBudget: 0,
		canOverrideChatTemplateThinking: false,
	});
});
