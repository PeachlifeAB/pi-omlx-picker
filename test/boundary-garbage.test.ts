import { strict as assert } from "node:assert";
import { test } from "node:test";
import { diagnoseBoundaryGarbage, hasProtocolMarkupLeak } from "../src/boundary-garbage.ts";

// ── hasProtocolMarkupLeak ────────────────────────────────────────────────────

test("hasProtocolMarkupLeak detects orphan Qwen tool XML tags", () => {
	assert.equal(hasProtocolMarkupLeak("</parameter>\n</function>\n</tool_call>"), true);
	assert.equal(hasProtocolMarkupLeak("</parameter>\n\nLet me read the model.ts file."), true);
	assert.equal(hasProtocolMarkupLeak("Let me read the model.ts file."), false);
});

// ── Always recover: protocol-only visible text ───────────────────────────────

test("diagnoseBoundaryGarbage recovers protocol-only visible text after any turn", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "user", content: [{ type: "text", text: "continue" }] },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "</parameter>\n</function>\n</tool_call>" }],
		},
	);

	assert.equal(diagnosis.hit, true);
	assert.equal(diagnosis.inText, true);
});

test("diagnoseBoundaryGarbage recovers visible text that starts with orphan closing tags before prose", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "user", content: [{ type: "text", text: "continue" }] },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "</parameter>\n</function>\n</tool_call>\n\nLet me read the file." }],
		},
	);

	assert.equal(diagnosis.hit, true);
	assert.equal(diagnosis.hasProtocolLeak, true);
});

test("diagnoseBoundaryGarbage recovers orphan closing tags even when following prose says template", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "user", content: [{ type: "text", text: "continue" }] },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "</parameter>\n</function>\n</tool_call>\n\nNow let me update the template." }],
		},
	);

	assert.equal(diagnosis.hit, true);
	assert.equal(diagnosis.hasProtocolLeak, true);
});

// ── Always recover: thinking contains protocol markers ───────────────────────

test("diagnoseBoundaryGarbage recovers protocol leaks in thinking after a user message", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "user", content: [{ type: "text", text: "continue where you left off" }] },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "</parameter>\n</function>\n</tool_call>" }],
		},
	);

	assert.equal(diagnosis.hit, true);
	assert.equal(diagnosis.inThinking, true);
});

test("diagnoseBoundaryGarbage recovers chat-template token leaks in thinking regardless of prior turn", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		undefined,
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "<|im_start|>assistant\n\nI have enough data now." }],
		},
	);

	assert.equal(diagnosis.hit, true);
	assert.equal(diagnosis.hasProtocolLeak, true);
	assert.equal(diagnosis.inThinking, true);
});

// ── Recover with context: mixed visible protocol/prose after tool result ──────

test("diagnoseBoundaryGarbage recovers mixed protocol/prose after a tool result", () => {
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
});

test("diagnoseBoundaryGarbage recovers mixed protocol/prose after an OMLX boundary-recovery steer", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "user", customType: "omlx-boundary-recovery", content: [{ type: "text", text: "Continue normally." }] },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "</parameter>\n</tool_call>\n\nNow let me check the file." }],
		},
	);

	assert.equal(diagnosis.hit, true);
	assert.equal(diagnosis.hasProtocolLeak, true);
});

// ── Pass through: explanation-shaped content ─────────────────────────────────

test("diagnoseBoundaryGarbage passes through an answer explaining im_start after a user message", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "user", content: [{ type: "text", text: "What does <|im_start|> mean?" }] },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "The `<|im_start|>` token is a chat-template marker used by Qwen models to delimit conversation roles." }],
		},
	);

	assert.equal(diagnosis.hit, false);
});

test("diagnoseBoundaryGarbage passes through an answer explaining </tool_call> after a user message", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "user", content: [{ type: "text", text: "explain </tool_call>" }] },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "The </tool_call> tag closes a tool invocation block in Qwen's chat template format." }],
		},
	);

	assert.equal(diagnosis.hit, false);
});

test("diagnoseBoundaryGarbage passes through protocol tags inside a fenced code block", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "user", content: [{ type: "text", text: "show me an example" }] },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "Here is how it looks:\n\n```\n</tool_call>\n</parameter>\n```\n\nThese close the tool call block." }],
		},
	);

	assert.equal(diagnosis.hit, false);
});

// ── Pass through: clean thinking ─────────────────────────────────────────────

test("diagnoseBoundaryGarbage does not flag clean thinking content", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "user", content: [{ type: "text", text: "what's next?" }] },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "I should call the search tool next." }],
		},
	);

	assert.equal(diagnosis.hit, false);
	assert.equal(diagnosis.hasProtocolLeak, false);
});

// ── Edge cases ───────────────────────────────────────────────────────────────

test("diagnoseBoundaryGarbage does not hit on toolUse stop reason", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		{
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "text", text: "</tool_call>" }],
		},
	);

	assert.equal(diagnosis.hit, false);
});

test("diagnoseBoundaryGarbage does not hit when content has tool calls", () => {
	const diagnosis = diagnoseBoundaryGarbage(
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		{
			role: "assistant",
			stopReason: "stop",
			content: [
				{ type: "text", text: "</tool_call>" },
				{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
			],
		},
	);

	assert.equal(diagnosis.hit, false);
});
