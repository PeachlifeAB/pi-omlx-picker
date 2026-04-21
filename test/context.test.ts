import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compactOmlxContext } from "../src/context.ts";

test("compactOmlxContext compacts older inline skill blobs but preserves recent messages", () => {
	const skill = [
		"<skill name=\"gstack-autoplan\" location=\"/tmp/SKILL.md\">",
		"---",
		"description: |",
		"  Auto-review pipeline for plans.",
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
	assert.match(text, /Auto-review pipeline for plans/);
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
		{ role: "user", content: [{ type: "text", text: "Run /autoplan" }] },
		{
			role: "custom",
			customType: "omlx-status",
			content: [{ type: "text", text: "OMLX returned invalid autoplan output." }],
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

test("compactOmlxContext collapses repeated inline skill retries near the latest invocation", () => {
	const skill = [
		"<skill name=\"gstack-autoplan\" location=\"/tmp/SKILL.md\">",
		"---",
		"description: |",
		"  Auto-review pipeline for plans.",
		"---",
		`${"body\n".repeat(2500)}`,
		"</skill>",
	].join("\n");

	const messages = [
		{ role: "user", content: [{ type: "text", text: "go on with the autplan" }] },
		{ role: "assistant", content: [{ type: "text", text: "Running the full pipeline. Starting with base branch detection and context intake." }] },
		{ role: "user", content: [{ type: "text", text: skill }] },
		{ role: "assistant", content: [{ type: "text", text: "I'm still here. Let me run the full `/autoplan` pipeline now. Starting with preamble." }] },
		{ role: "user", content: [{ type: "text", text: skill }] },
	];

	const result = compactOmlxContext(messages);
	assert.ok(result.stats);
	assert.equal(result.stats?.compactedSkillMessages, 1);
	assert.equal(result.stats?.compactedLargeMessages, 1);
	const priorSkillText = ((result.messages[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	const priorAssistantText = ((result.messages[3] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	const latestSkillText = ((result.messages[4] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	assert.match(priorSkillText, /Earlier gstack-autoplan invocation compacted/);
	assert.match(priorAssistantText, /Earlier assistant stub from a failed gstack-autoplan retry compacted/);
	assert.match(latestSkillText, /^<skill name="gstack-autoplan"/);
});

test("compactOmlxContext compacts poisoned autoplan assistant turns inside a retry cluster", () => {
	const skill = [
		"<skill name=\"gstack-autoplan\" location=\"/tmp/SKILL.md\">",
		"---",
		"description: |",
		"  Auto-review pipeline for plans.",
		"---",
		`${"body\n".repeat(2500)}`,
		"</skill>",
	].join("\n");

	const messages = [
		{ role: "user", content: [{ type: "text", text: skill }] },
		{ role: "assistant", content: [{ type: "text", text: "```bash\ngit rev-parse --abbrev-ref HEAD\n```" }] },
		{ role: "assistant", content: [{ type: "text", text: "**You are an autopilot reviewer for gstack projects." }] },
		{ role: "assistant", content: [{ type: "text", text: "[" }] },
		{ role: "user", content: [{ type: "text", text: skill }] },
	];

	const result = compactOmlxContext(messages);
	assert.ok(result.stats);
	assert.equal(result.stats?.compactedLargeMessages, 3);
	for (const index of [1, 2, 3]) {
		const text = ((result.messages[index] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
		assert.match(text, /Earlier assistant stub from a failed gstack-autoplan retry compacted/);
	}
});
