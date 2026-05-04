import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compactOmlxContext } from "../src/context.ts";

test("compactOmlxContext compacts older inline skill blobs but preserves recent messages", () => {
	const skill = [
		"<skill name=\"example-writing\" location=\"/tmp/SKILL.md\">",
		"---",
		"description: |",
		"  Write a project document.",
		"---",
		"## Important Rules",
		"- Never abort.",
		"- Log every decision.",
		"- Sequential order.",
		`${"body\n".repeat(5000)}`,
		"</skill>",
	].join("\n");

	const messages = [
		{ role: "user", content: [{ type: "text", text: skill }] },
		...Array.from({ length: 8 }, (_, index) => ({
			role: index % 2 === 0 ? "assistant" : "user",
			content: [{ type: "text", text: `recent-${index}` }],
		})),
	];

	const result = compactOmlxContext(messages);
	assert.ok(result.stats);
	assert.equal(result.stats?.compactedSkillMessages, 1);
	assert.equal(result.stats?.compactedLargeMessages, 0);
	const text = ((result.messages[0] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	assert.match(text, /Compacted by pi-omlx-picker for OMLX/);
	assert.match(text, /Treat the referenced skill file as authoritative/);
	assert.match(text, /Write a project document/);
	assert.doesNotMatch(text, /Never abort/);
	assert.doesNotMatch(text, /Log every decision/);
	assert.equal((((result.messages.at(-1) as Record<string, unknown>).content as Array<Record<string, string>>)[0].text), "recent-7");
});

test("compactOmlxContext compacts oversized older messages only when total context is pathological", () => {
	const huge = `intro\n${"x".repeat(30_000)}\noutro`;
	const messages = [
		{ role: "user", content: [{ type: "text", text: huge.repeat(8) }] },
		{ role: "assistant", content: [{ type: "text", text: huge }] },
		...Array.from({ length: 8 }, (_, index) => ({
			role: index % 2 === 0 ? "assistant" : "user",
			content: [{ type: "text", text: `tail-${index}` }],
		})),
	];

	const result = compactOmlxContext(messages);
	assert.ok(result.stats);
	assert.equal(result.stats?.compactedLargeMessages, 2);
	assert.equal(result.stats?.compactedSkillMessages, 0);
	const firstText = ((result.messages[0] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	assert.match(firstText, /Earlier oversized message compacted/);
	assert.ok((result.stats?.afterChars ?? 0) < (result.stats?.beforeChars ?? 0));
});

test("compactOmlxContext leaves smaller contexts unchanged", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "hello" }] },
		{ role: "assistant", content: [{ type: "text", text: "world" }] },
	];

	const result = compactOmlxContext(messages);
	assert.equal(result.stats, undefined);
	assert.equal(result.messages, messages);
});

test("compactOmlxContext strips visible OMLX status messages from provider context", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "Run the local workflow" }] },
		{
			role: "custom",
			customType: "omlx-status",
			content: [{ type: "text", text: "OMLX returned an empty completion." }],
			display: true,
		},
		{ role: "assistant", content: [{ type: "text", text: "world" }] },
	];

	const result = compactOmlxContext(messages);
	assert.equal(result.messages.length, 2);
	assert.equal((result.messages[0] as Record<string, unknown>).role, "user");
	assert.equal((result.messages[1] as Record<string, unknown>).role, "assistant");
	assert.equal(result.stats, undefined);
});

test("compactOmlxContext removes assistant protocol leaks before provider retry", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "continue" }] },
		{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
		{
			role: "assistant",
			content: [{ type: "text", text: "</parameter>\n</function>\n</tool_call>" }],
		},
		{
			role: "custom",
			customType: "omlx-boundary-recovery",
			content: [{ type: "text", text: "Continue from the tool result." }],
		},
	];

	const result = compactOmlxContext(messages);
	assert.ok(result.stats);
	assert.equal(result.stats?.sanitizedProtocolMessages, 1);
	assert.equal(result.messages.length, 3);
	assert.equal((result.messages[0] as Record<string, unknown>).role, "user");
	assert.equal((result.messages[1] as Record<string, unknown>).role, "toolResult");
	assert.equal((result.messages[2] as Record<string, unknown>).customType, "omlx-boundary-recovery");
});

test("compactOmlxContext removes aborted assistant fragments before provider retry", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "continue" }] },
		{
			role: "assistant",
			stopReason: "aborted",
			content: [
				{ type: "thinking", thinking: "I was halfway through the previous model's plan." },
				{ type: "text", text: "Partial visible answer" },
			],
		},
		{ role: "user", content: [{ type: "text", text: "take over from here" }] },
	];

	const result = compactOmlxContext(messages);
	assert.ok(result.stats);
	assert.equal(result.stats?.sanitizedAbortedMessages, 1);
	assert.equal(result.messages.length, 2);
	assert.equal((result.messages[0] as Record<string, unknown>).role, "user");
	assert.equal((result.messages[1] as Record<string, unknown>).role, "user");
});

test("compactOmlxContext keeps aborted assistant messages that contain tool calls", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "continue" }] },
		{
			role: "assistant",
			stopReason: "aborted",
			content: [{ type: "toolCall", name: "read", id: "call-1", arguments: { path: "README.md" } }],
		},
	];

	const result = compactOmlxContext(messages);
	assert.equal(result.stats, undefined);
	assert.equal(result.messages, messages);
});

test("compactOmlxContext truncates oversized tool results using OMLX max_tool_result_tokens", () => {
	const longToolResult = `start ${"x".repeat(1000)} end`;
	const messages = [
		{ role: "user", content: [{ type: "text", text: "inspect" }] },
		{ role: "toolResult", content: [{ type: "text", text: longToolResult }] },
		{ role: "assistant", content: [{ type: "text", text: "done" }] },
	];

	const result = compactOmlxContext(messages, { maxToolResultTokens: 200 });
	assert.ok(result.stats);
	assert.equal(result.stats?.truncatedToolResultMessages, 1);
	assert.equal(result.stats?.modifiedMessages, 1);
	const text = ((result.messages[1] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	assert.match(text, /Tool result truncated by pi-omlx-picker for OMLX/);
	assert.match(text, /max_tool_result_tokens=200/);
	assert.match(text, /Start:/);
	assert.match(text, /End:/);
});

test("compactOmlxContext keeps very small tool result truncation under the max chars", () => {
	const longToolResult = `start ${"x".repeat(1000)} end`;
	const messages = [
		{ role: "user", content: [{ type: "text", text: "inspect" }] },
		{ role: "toolResult", content: [{ type: "text", text: longToolResult }] },
	];

	const result = compactOmlxContext(messages, { maxToolResultTokens: 10 });
	assert.ok(result.stats);
	const text = ((result.messages[1] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	assert.ok(text.length <= 40);
});

test("compactOmlxContext collapses repeated inline skill retries and empty assistant stubs near the latest invocation", () => {
	const skill = [
		"<skill name=\"example-review\" location=\"/tmp/SKILL.md\">",
		"---",
		"description: |",
		"  Review a project plan.",
		"---",
		`${"body\n".repeat(2500)}`,
		"</skill>",
	].join("\n");

	const messages = [
		{ role: "user", content: [{ type: "text", text: "go on with the review" }] },
		{ role: "assistant", content: [{ type: "text", text: "Running the full pipeline. Starting with base branch detection and context intake." }] },
		{ role: "user", content: [{ type: "text", text: skill }] },
		{ role: "assistant", content: [{ type: "text", text: "" }] },
		{ role: "user", content: [{ type: "text", text: skill }] },
	];

	const result = compactOmlxContext(messages);
	assert.ok(result.stats);
	assert.equal(result.stats?.compactedSkillMessages, 1);
	assert.equal(result.stats?.compactedLargeMessages, 1);
	const priorSkillText = ((result.messages[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	const priorAssistantText = ((result.messages[3] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	const latestSkillText = ((result.messages[4] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	assert.match(priorSkillText, /Earlier example-review invocation compacted/);
	assert.match(priorAssistantText, /Earlier assistant stub from a failed example-review retry compacted/);
	assert.match(latestSkillText, /^<skill name="example-review"/);
});

test("compactOmlxContext compacts only empty assistant stubs inside a retry cluster", () => {
	const skill = [
		"<skill name=\"example-review\" location=\"/tmp/SKILL.md\">",
		"---",
		"description: |",
		"  Review a project plan.",
		"---",
		`${"body\n".repeat(2500)}`,
		"</skill>",
	].join("\n");

	const messages = [
		{ role: "user", content: [{ type: "text", text: skill }] },
		{ role: "assistant", content: [{ type: "text", text: "" }] },
		{ role: "assistant", content: [{ type: "text", text: "Running the full pipeline." }] },
		{ role: "assistant", content: [{ type: "text", text: "Let me run the full `/example-review` pipeline now." }] },
		{ role: "user", content: [{ type: "text", text: skill }] },
	];

	const result = compactOmlxContext(messages);
	assert.ok(result.stats);
	assert.equal(result.stats?.compactedLargeMessages, 1);
	const emptyStub = ((result.messages[1] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	assert.match(emptyStub, /Earlier assistant stub from a failed example-review retry compacted/);
	const prose = ((result.messages[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	const slashCommandProse = ((result.messages[3] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	assert.equal(prose, "Running the full pipeline.");
	assert.equal(slashCommandProse, "Let me run the full `/example-review` pipeline now.");
});
