import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	buildIncompleteStopFacts,
	classifyEmptyStopRecovery,
	classifyToolIntentStopRecovery,
	classifyToolValidationRecovery,
	detectToolIntentText,
	emitIncompleteStopFactsEvent,
	extractToolValidationError,
	isActionlessUnusableAssistantStop,
	isEmptyUnusableAssistantStop,
	OMLX_INCOMPLETE_STOP_EVENT,
} from "../src/recovery.ts";

test("incomplete stop event name is namespaced", () => {
	assert.equal(OMLX_INCOMPLETE_STOP_EVENT, "pi-omlx-picker:incomplete-stop");
});

test("buildIncompleteStopFacts emits compact normalized facts", () => {
	const facts = buildIncompleteStopFacts({
		modelId: "qwen",
		turnIndex: 7,
		toolResultCount: 0,
		toolsAvailable: true,
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "private reasoning ".repeat(40) },
				{ type: "text", text: "I will inspect the files now." },
			],
		},
		repeatedToolCall: { hit: true, toolName: "exec_command", count: 3 },
	});

	assert.ok(facts);
	assert.equal(facts.version, 1);
	assert.equal(facts.provider, "omlx");
	assert.equal(facts.modelId, "qwen");
	assert.equal(facts.turnIndex, 7);
	assert.equal(facts.hasVisibleText, true);
	assert.equal(facts.hasThinking, true);
	assert.equal(facts.hasToolCalls, false);
	assert.equal(facts.emptyStop, false);
	assert.equal(facts.toolsAvailable, true);
	assert.equal(facts.autoRetryEligible, true);
	assert.equal(facts.repeatedToolCall.toolName, "exec_command");
	assert.equal(facts.toolIntentStop.hit, true);
	assert.equal(facts.toolIntentStop.reason, "i will:inspect");
	assert.equal(facts.textPreview, "I will inspect the files now.");
	assert.ok((facts.thinkingPreview?.length ?? 0) <= 240);
	assert.equal(typeof facts.turnKey, "string");
});

test("buildIncompleteStopFacts does not treat thinking-only content as empty", () => {
	const facts = buildIncompleteStopFacts({
		modelId: "qwen",
		turnIndex: 8,
		toolResultCount: 0,
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "I should continue with a tool call." }],
		},
	});

	assert.ok(facts);
	assert.equal(facts.hasThinking, true);
	assert.equal(facts.emptyStop, false);
	assert.equal(facts.autoRetryEligible, false);
	assert.equal(isActionlessUnusableAssistantStop(facts), false);
	assert.equal(isEmptyUnusableAssistantStop(facts), false);
});

test("thinking-only stop with tools available is actionless and retryable", () => {
	const facts = buildIncompleteStopFacts({
		modelId: "qwen",
		turnIndex: 8,
		toolResultCount: 0,
		toolsAvailable: true,
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "I should continue with a tool call." }],
		},
	});

	assert.ok(facts);
	assert.equal(facts.hasThinking, true);
	assert.equal(facts.hasVisibleText, false);
	assert.equal(facts.hasToolCalls, false);
	assert.equal(facts.emptyStop, false);
	assert.equal(facts.autoRetryEligible, true);
	assert.equal(isEmptyUnusableAssistantStop(facts), false);
	assert.equal(isActionlessUnusableAssistantStop(facts), true);
	assert.equal(classifyEmptyStopRecovery(facts, false), "retry");
	assert.equal(classifyEmptyStopRecovery({ ...facts, turnIndex: 9, turnKey: `${facts.turnKey}-new-turn` }, true), "failed");
});

test("visible tool-intent stop is retryable when tools are available", () => {
	const facts = buildIncompleteStopFacts({
		modelId: "qwen",
		turnIndex: 15,
		toolResultCount: 0,
		toolsAvailable: true,
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "I have enough data." },
				{ type: "text", text: "Now I have enough data. Let me write the best practices guide." },
			],
		},
	});

	assert.ok(facts);
	assert.equal(facts.toolIntentStop.hit, true);
	assert.equal(facts.toolIntentStop.reason, "let me:write");
	assert.equal(facts.autoRetryEligible, true);
	assert.equal(classifyToolIntentStopRecovery(facts, 0), "retry");
	assert.equal(classifyToolIntentStopRecovery(facts, 1), "retry");
	assert.equal(classifyToolIntentStopRecovery(facts, 2), "failed");
});

test("tool-intent detection ignores long normal answers and missing action verbs", () => {
	assert.deepEqual(detectToolIntentText("I will be concise."), { hit: false });
	assert.deepEqual(detectToolIntentText(`${"details ".repeat(90)} I will write later.`), { hit: false });
});

test("buildIncompleteStopFacts detects empty unusable assistant stop", () => {
	const facts = buildIncompleteStopFacts({
		modelId: "non-thinking",
		turnIndex: 2,
		toolResultCount: 0,
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [],
		},
	});

	assert.ok(facts);
	assert.equal(facts.emptyStop, true);
	assert.equal(facts.autoRetryEligible, true);
	assert.equal(isEmptyUnusableAssistantStop(facts), true);
});

test("classifyEmptyStopRecovery bounds empty-stop retry across recovery turns", () => {
	const facts = buildIncompleteStopFacts({
		modelId: "non-thinking",
		turnIndex: 2,
		toolResultCount: 0,
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [],
		},
	});

	assert.ok(facts);
	assert.equal(classifyEmptyStopRecovery(facts, false), "retry");
	assert.equal(classifyEmptyStopRecovery({ ...facts, turnIndex: 3, turnKey: `${facts.turnKey}-new-turn` }, true), "failed");
});

test("extractToolValidationError detects Pi schema validation tool results", () => {
	const validation = extractToolValidationError([
		{
			role: "toolResult",
			toolName: "write",
			isError: true,
			content: [{
				type: "text",
				text: "Validation failed for tool \"write\":\n  - path: must have required properties path, content\n\nReceived arguments:\n{}",
			}],
		},
	]);

	assert.equal(validation.hit, true);
	assert.equal(validation.toolName, "write");
	assert.match(validation.preview ?? "", /Received arguments/);
});

test("classifyToolValidationRecovery prefers validation recovery after empty stop", () => {
	const empty = buildIncompleteStopFacts({
		modelId: "documenter",
		turnIndex: 22,
		toolResultCount: 0,
		toolsAvailable: true,
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [],
		},
	});
	const validation = {
		hit: true,
		toolName: "write",
		preview: "Validation failed for tool \"write\": Received arguments: {}",
	};

	assert.ok(empty);
	assert.equal(classifyToolValidationRecovery(empty, validation, 0), "retry");
	assert.equal(classifyToolValidationRecovery({ ...empty, turnIndex: 23, turnKey: `${empty.turnKey}-next` }, validation, 1), "retry");
	assert.equal(classifyToolValidationRecovery({ ...empty, turnIndex: 24, turnKey: `${empty.turnKey}-third` }, validation, 2), "failed");
});

test("classifyToolValidationRecovery retries when model produces only thinking after validation error", () => {
	const thinkingOnly = buildIncompleteStopFacts({
		modelId: "opus",
		turnIndex: 22,
		toolResultCount: 0,
		toolsAvailable: true,
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "I need to call the read tool with the correct path argument." }],
		},
	});
	const validation = {
		hit: true,
		toolName: "read",
		preview: "Validation failed for tool \"read\":\n  - path: must have required properties path\n\nReceived arguments:\n{\"file\": \"/some/path\"}",
	};

	assert.ok(thinkingOnly);
	assert.equal(thinkingOnly.hasThinking, true);
	assert.equal(thinkingOnly.hasVisibleText, false);
	assert.equal(thinkingOnly.hasToolCalls, false);
	assert.equal(classifyToolValidationRecovery(thinkingOnly, validation, 0), "retry");
	assert.equal(classifyToolValidationRecovery({ ...thinkingOnly, turnIndex: 23, turnKey: `${thinkingOnly.turnKey}-next` }, validation, 1), "retry");
	assert.equal(classifyToolValidationRecovery({ ...thinkingOnly, turnIndex: 24, turnKey: `${thinkingOnly.turnKey}-third` }, validation, 2), "failed");
});

test("classifyToolValidationRecovery ignores normal stops and tool-result turns", () => {
	const finalFacts = buildIncompleteStopFacts({
		toolResultCount: 0,
		toolsAvailable: true,
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "Done." }],
		},
	});
	const sameTurnToolResult = buildIncompleteStopFacts({
		toolResultCount: 1,
		toolsAvailable: true,
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [],
		},
	});
	const validation = { hit: true, toolName: "write" };

	assert.ok(finalFacts);
	assert.ok(sameTurnToolResult);
	assert.equal(classifyToolValidationRecovery(finalFacts, validation, 0), "none");
	assert.equal(classifyToolValidationRecovery(sameTurnToolResult, validation, 0), "none");
	assert.equal(classifyToolValidationRecovery(finalFacts, { hit: false }, 0), "none");
});

test("buildIncompleteStopFacts ignores non-stop and non-assistant messages", () => {
	assert.equal(buildIncompleteStopFacts({
		toolResultCount: 0,
		message: { role: "user", stopReason: "stop", content: [{ type: "text", text: "hi" }] },
	}), undefined);
	assert.equal(buildIncompleteStopFacts({
		toolResultCount: 0,
		message: { role: "assistant", stopReason: "tool_calls", content: [] },
	}), undefined);
});

test("emitIncompleteStopFactsEvent catches listener failures", () => {
	const facts = buildIncompleteStopFacts({
		toolResultCount: 0,
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
	});
	const errors: unknown[] = [];

	assert.ok(facts);
	const emitted = emitIncompleteStopFactsEvent({
		emit() {
			throw new Error("listener failed");
		},
	}, facts, (err) => errors.push(err));

	assert.equal(emitted, false);
	assert.equal(errors.length, 1);
	assert.equal((errors[0] as Error).message, "listener failed");
});

test("emitIncompleteStopFactsEvent isolates async listener failures", async () => {
	const facts = buildIncompleteStopFacts({
		toolResultCount: 0,
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
	});
	const errors: unknown[] = [];

	assert.ok(facts);
	const emitted = emitIncompleteStopFactsEvent({
		emit() {
			return Promise.reject(new Error("async listener failed"));
		},
	}, facts, (err) => errors.push(err));

	assert.equal(emitted, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(errors.length, 1);
	assert.equal((errors[0] as Error).message, "async listener failed");
});
