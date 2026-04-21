import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	getAutoplanFailureMessage,
	getAutoplanInvalidTurnReason,
	getLatestAutoplanInvocationKey,
} from "../src/recovery.ts";

test("getAutoplanInvalidTurnReason matches autoplan start stub after inline skill invocation", () => {
	const branchMessages = [
		{ role: "user", content: [{ type: "text", text: "<skill name=\"gstack-autoplan\" location=\"/tmp/SKILL.md\">\nbody\n</skill>" }] },
	];
	const assistant = {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "Let me run the full autoplan pipeline on `feat/x`. Starting with preamble and context intake." }],
	};

	assert.equal(getAutoplanInvalidTurnReason(assistant, 0, branchMessages), "stub");
	assert.match(getAutoplanFailureMessage("stub"), /preamble text instead of executing/);
});

test("getAutoplanInvalidTurnReason matches bash narration after inline skill invocation", () => {
	const branchMessages = [
		{ role: "user", content: [{ type: "text", text: "<skill name=\"gstack-autoplan\" location=\"/tmp/SKILL.md\">\nbody\n</skill>" }] },
	];
	const assistant = {
		role: "assistant",
		stopReason: "stop",
		content: [
			{
				type: "text",
				text: [
					"Running full `/autoplan` pipeline on feat/x. Starting preamble.",
					"",
					"```bash",
					"git log -20 --oneline",
					"git diff $BASE --stat",
					"```",
				].join("\n"),
			},
		],
	};

	assert.equal(getAutoplanInvalidTurnReason(assistant, 0, branchMessages), "narration");
	assert.match(getAutoplanFailureMessage("narration"), /narrated shell commands/);
});

test("getAutoplanInvalidTurnReason detects empty completion", () => {
	const branchMessages = [
		{ role: "user", content: [{ type: "text", text: "<skill name=\"gstack-autoplan\" location=\"/tmp/SKILL.md\">\nbody\n</skill>" }] },
	];

	assert.equal(
		getAutoplanInvalidTurnReason(
			{
				role: "assistant",
				stopReason: "stop",
				content: [],
			},
			0,
			branchMessages,
		),
		"empty",
	);
	assert.match(getAutoplanFailureMessage("empty"), /returned no usable output/);
});

test("getAutoplanInvalidTurnReason ignores messages with tool calls or unrelated text", () => {
	const branchMessages = [
		{ role: "user", content: [{ type: "text", text: "<skill name=\"gstack-autoplan\" location=\"/tmp/SKILL.md\">\nbody\n</skill>" }] },
	];

	assert.equal(
		getAutoplanInvalidTurnReason(
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "toolCall", name: "read" }],
			},
			0,
			branchMessages,
		),
		undefined,
	);

	assert.equal(
		getAutoplanInvalidTurnReason(
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Actual review output" }],
			},
			0,
			branchMessages,
		),
		undefined,
	);
});

test("getAutoplanInvalidTurnReason treats leaked overlay control text as invalid autoplan output", () => {
	const branchMessages = [
		{ role: "user", content: [{ type: "text", text: "<skill name=\"gstack-autoplan\" location=\"/tmp/SKILL.md\">\nbody\n</skill>" }] },
	];

	assert.equal(
		getAutoplanInvalidTurnReason(
			{
				role: "assistant",
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: "Continue /autoplan now. Do not narrate shell commands. You are an autopilot reviewer for gstack projects.",
					},
				],
			},
			0,
			branchMessages,
		),
		"stub",
	);
});

test("getLatestAutoplanInvocationKey tracks the latest autoplan user invocation", () => {
	const branchMessages = [
		{ role: "user", content: [{ type: "text", text: "plain user message" }] },
		{ role: "assistant", content: [{ type: "text", text: "plain assistant message" }] },
		{ role: "user", content: [{ type: "text", text: "<skill name=\"gstack-autoplan\" location=\"/tmp/a.md\">\nbody\n</skill>" }] },
		{ role: "assistant", content: [{ type: "text", text: "bad autoplan turn" }] },
		{ role: "user", content: [{ type: "text", text: "<skill name=\"gstack-autoplan\" location=\"/tmp/b.md\">\nbody body\n</skill>" }] },
	];

	assert.equal(getLatestAutoplanInvocationKey(branchMessages), `4:${"<skill name=\"gstack-autoplan\" location=\"/tmp/b.md\">\nbody body\n</skill>".length}`);
	assert.equal(getLatestAutoplanInvocationKey([{ role: "user", content: [{ type: "text", text: "hello" }] }]), undefined);
});
