import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyOmlxCompatibilityOverlay } from "../src/overlay.ts";

test("applyOmlxCompatibilityOverlay adds provider-neutral contract to latest inline skill", () => {
	const skill = [
		"<skill name=\"example-writing\" location=\"/tmp/SKILL.md\">",
		"---",
		"description: |",
		"  Write a project document.",
		"---",
		"## Phase 0",
		"```bash",
		"$GSTACK_ROOT/bin/gstack-preamble",
		"```",
		`${"body\n".repeat(2000)}`,
		"</skill>",
	].join("\n");

	const messages = [
		{ role: "user", content: [{ type: "text", text: "hello" }] },
		{ role: "user", content: [{ type: "text", text: skill }] },
	];

	const result = applyOmlxCompatibilityOverlay(messages);
	assert.ok(result.stats);
	assert.equal(result.stats?.overlay, "inline-skill-agent-contract");
	assert.equal(result.stats?.replacedMessages, 1);
	assert.ok((result.stats?.afterChars ?? 0) > (result.stats?.beforeChars ?? 0));
	const text = ((result.messages[1] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	assert.match(text, /body/);
	assert.match(text, /<skill name="example-writing"/);
	assert.match(text, /\[OMLX agent contract applied by pi-omlx-picker\.\]/);
	assert.match(text, /If an action requires a tool, emit the Pi tool call/);
	assert.match(text, /not protocol tags alone/);
	assert.doesNotMatch(text, /\/no_think/);
	assert.doesNotMatch(text, /Run the actual/);
});

test("applyOmlxCompatibilityOverlay leaves messages without inline skills unchanged", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "plain request" }] },
	];

	const result = applyOmlxCompatibilityOverlay(messages);
	assert.equal(result.stats, undefined);
	assert.equal(result.messages, messages);
});

test("applyOmlxCompatibilityOverlay is a no-op when no tools are available", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "<skill name=\"example\" location=\"/tmp/SKILL.md\">\nbody\n</skill>" }] },
	];

	const result = applyOmlxCompatibilityOverlay(messages, { toolsAvailable: false });

	assert.equal(result.stats, undefined);
	assert.equal(result.messages, messages);
});

test("applyOmlxCompatibilityOverlay is idempotent", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "<skill name=\"example\" location=\"/tmp/SKILL.md\">\nbody\n</skill>" }] },
	];
	const once = applyOmlxCompatibilityOverlay(messages);
	const twice = applyOmlxCompatibilityOverlay(once.messages);

	assert.ok(once.stats);
	assert.equal(twice.stats, undefined);
	assert.deepEqual(twice.messages, once.messages);
});
