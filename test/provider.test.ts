import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toProviderConfig } from "../src/provider.ts";

test("toProviderConfig marks models with thinking_default as reasoning capable", () => {
	const config = toProviderConfig("http://example.test/v1", "OMLX_API_KEY", [
		{ id: "qwen", thinkingDefault: true },
		{ id: "gemma", thinkingDefault: false },
		{ id: "plain" },
		{ id: "no-toggle", thinkingDefault: null },
	]);

	assert.equal(config.models?.[0]?.reasoning, true);
	assert.equal(config.models?.[1]?.reasoning, true);
	assert.equal(config.models?.[2]?.reasoning, false);
	assert.equal(config.models?.[3]?.reasoning, false);
});
