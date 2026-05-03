import { strict as assert } from "node:assert";
import { test } from "node:test";
import { diagnoseBoundaryGarbage, hasProtocolMarkupLeak } from "../src/boundary-garbage.ts";

test("hasProtocolMarkupLeak detects orphan Qwen tool XML tags", () => {
	assert.equal(hasProtocolMarkupLeak("</parameter>\n</function>\n</tool_call>"), true);
	assert.equal(hasProtocolMarkupLeak("</parameter>\n\nLet me read the model.ts file."), true);
	assert.equal(hasProtocolMarkupLeak("Let me read the model.ts file."), false);
});

test("diagnoseBoundaryGarbage treats mixed protocol/prose after tool results as recoverable", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "</parameter>\n</function>\n</tool_call>\n\nLet me read the model.ts file." }],
		},
	);

	assert.equal(diagnosis.hit, true);
	assert.equal(diagnosis.hasProtocolLeak, true);
	assert.equal(diagnosis.inText, false);
});
