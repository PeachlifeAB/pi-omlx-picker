import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyOmlxCompatibilityOverlay } from "../src/overlay.ts";

test("applyOmlxCompatibilityOverlay rewrites latest inline gstack-autoplan skill for OMLX", () => {
	const skill = [
		"<skill name=\"gstack-autoplan\" location=\"/tmp/SKILL.md\">",
		"---",
		"description: |",
		"  Auto-review pipeline for plans.",
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
	assert.equal(result.stats?.overlay, "gstack-autoplan");
	assert.equal(result.stats?.replacedMessages, 1);
	assert.ok((result.stats?.afterChars ?? 0) < (result.stats?.beforeChars ?? 0));
	const text = ((result.messages[1] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
	assert.match(text, /\[OMLX compatibility overlay applied by pi-omlx-picker\.\]/);
	assert.match(text, /Treat this turn as \/no_think/);
	assert.match(text, /Do not print the preamble/);
	assert.match(text, /Use Pi tool calls/);
	assert.match(text, /\/no_think/);
});

test("applyOmlxCompatibilityOverlay leaves non-autoplan messages unchanged", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "plain request" }] },
	];

	const result = applyOmlxCompatibilityOverlay(messages);
	assert.equal(result.stats, undefined);
	assert.equal(result.messages, messages);
});
