import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSessionDiagnostics } from "../src/session-diagnostics.ts";

test("buildSessionDiagnostics summarizes counts, tokens, recoveries, and last stop", () => {
	const diagnostics = buildSessionDiagnostics({
		getSessionFile: () => "/tmp/session.jsonl",
		getSessionId: () => "019dd8e6",
		getLeafId: () => "leaf-1",
		getBranch: () => [
			{
				type: "message",
				timestamp: "2026-04-29T11:01:31.918Z",
				message: { role: "user", content: "write the guide" },
			},
			{
				type: "message",
				timestamp: "2026-04-29T12:08:57.300Z",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [
						{ type: "thinking", thinking: "Let me synthesize the material." },
						{ type: "text", text: "Now I have enough data. Let me write the best practices guide." },
					],
					usage: { input: 53399, output: 4478, cacheRead: 34816, totalTokens: 92693 },
				},
			},
			{
				type: "custom_message",
				customType: "omlx-tool-intent-recovery",
				content: "Emit the Pi tool call now.",
			},
			{
				type: "message",
				timestamp: "2026-04-29T12:24:13.872Z",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "thinking", thinking: "Let me write the guide." }],
					usage: { input: 53527, output: 6089, cacheRead: 34816, totalTokens: 94432 },
				},
			},
			{
				type: "custom_message",
				customType: "omlx-empty-stop-recovery",
				content: "Continue normally.",
			},
			{
				type: "message",
				timestamp: "2026-04-29T12:35:17.375Z",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "</tool_response>" }],
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			},
			{
				type: "custom_message",
				customType: "omlx-boundary-recovery",
				content: "Continue from the tool result.",
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "write",
					content: [{ type: "text", text: "ok" }],
				},
			},
		],
	});

	assert.ok(diagnostics);
	assert.equal(diagnostics.sessionFile, "/tmp/session.jsonl");
	assert.equal(diagnostics.sessionId, "019dd8e6");
	assert.equal(diagnostics.leafId, "leaf-1");
	assert.deepEqual(diagnostics.counts, {
		userMessages: 1,
		assistantMessages: 3,
		toolCalls: 0,
		toolResults: 1,
		totalEntries: 8,
	});
	assert.deepEqual(diagnostics.tokens, {
		input: 106927,
		output: 10568,
		cacheRead: 69632,
		total: 187127,
	});
	assert.deepEqual(diagnostics.recoveryCounts, {
		boundaryGarbage: 1,
		emptyStop: 1,
		thinkingOnly: 0,
		toolValidation: 0,
		toolIntent: 1,
	});
	assert.equal(diagnostics.lastAssistantStop?.diagnosis, "protocol-boundary garbage");
	assert.equal(diagnostics.lastAssistantStop?.inputTokens, 1);
	assert.equal(diagnostics.lastAssistantStop?.outputTokens, 1);
	assert.equal(diagnostics.lastAssistantStop?.totalTokens, 2);
	assert.equal(diagnostics.recentAnomalies.length, 3);
	assert.equal(diagnostics.recentAnomalies[0]?.diagnosis, "tool-intent stop (let me:write)");
	assert.equal(diagnostics.recentAnomalies[1]?.diagnosis, "thinking-only stop before visible answer/tool call");
});

test("buildSessionDiagnostics classifies provider length stops", () => {
	const diagnostics = buildSessionDiagnostics({
		getBranch: () => [{
			type: "message",
			message: {
				role: "assistant",
				stopReason: "length",
				content: [{ type: "text", text: "partial" }],
				usage: { input: 100, output: 4096, totalTokens: 4196 },
			},
		}],
	});

	assert.equal(diagnostics?.lastAssistantStop?.diagnosis, "provider length limit");
	assert.equal(diagnostics?.recentAnomalies[0]?.diagnosis, "provider length limit");
});
