import { strict as assert } from "node:assert";
import { test } from "node:test";
import { recordPerformanceSample } from "../src/performance.ts";
import { renderOmlxStatus, type OmlxStatusSnapshot } from "../src/status.ts";
import { recordTaskBudgetUsage, resetTaskBudget } from "../src/task-budget.ts";

const baseSnapshot: OmlxStatusSnapshot = {
	apiRoot: "http://127.0.0.1:8008/v1",
	registered: true,
	catalog: [],
	modelSettingsPath: "/tmp/model_settings.json",
	modelSettingsFound: true,
	lastRefreshAt: "2026-04-29T10:00:00.000Z",
	activePiModel: undefined,
	taskBudget: resetTaskBudget(undefined),
	recoveryCounts: { boundaryGarbage: 0, emptyStop: 0, thinkingOnly: 0, toolValidation: 0, toolIntent: 0 },
	debugLogFile: "/tmp/provider-debug.log",
};

test("renderOmlxStatus shows active OMLX model mapping and settings", () => {
	const taskBudget = recordTaskBudgetUsage(resetTaskBudget({ id: "m1", taskBudgetTokens: 1000 }), 250).state;
	const performance = recordPerformanceSample(undefined, "m1", 0, 2000, 100);
	const text = renderOmlxStatus({
		...baseSnapshot,
		catalog: [
			{
				id: "m1",
				displayName: "Model One",
				description: "Local agentic lane",
				modelAlias: "model-one",
				thinkingDefault: true,
				contextWindow: 256000,
				maxTokens: 32768,
				taskBudgetTokens: 1000,
				maxToolResultTokens: 4096,
				thinkingBudgetEnabled: true,
				thinkingBudgetTokens: 8192,
				preserveThinking: true,
				forcedCtKwargs: ["enable_thinking"],
				reasoningParser: "qwen",
				nativeThinkingLevel: "medium",
				nativeThinkingSource: "model_settings.thinking_budget_tokens=8192",
				settingsSummary: {
					identity: { displayName: "Model One", modelAlias: "model-one" },
					limits: { contextWindow: 256000, maxTokens: 32768, maxToolResultTokens: 4096 },
					chatTemplate: { kwargs: { preserve_thinking: true }, forcedKeys: ["enable_thinking"] },
					sampling: { temperature: 0.2 },
					dflash: { enabled: true },
					specprefill: { enabled: false },
					turboquant: { enabled: true, bits: 4 },
					lifecycle: { ttlSeconds: 300 },
					security: { trustRemoteCode: false },
					profile: { activeProfileName: "agentic" },
				},
			},
		],
		activePiModel: {
			provider: "omlx",
			id: "m1",
			name: "Model One",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 256000,
			maxTokens: 32768,
			compat: { thinkingFormat: "qwen-chat-template", maxTokensField: "max_tokens" },
		},
		currentThinkingLevel: "medium",
		performance,
		taskBudget,
		recoveryCounts: { boundaryGarbage: 1, emptyStop: 2, thinkingOnly: 3, toolValidation: 4, toolIntent: 5 },
		recoveryThinkingOverride: {
			attemptedChatTemplateKeys: ["enable_thinking", "preserve_thinking"],
			blockedChatTemplateKeys: ["enable_thinking"],
			requestThinkingBudget: 0,
			canOverrideChatTemplateThinking: false,
		},
	});

	assert.match(text, /display name: Model One/);
	assert.match(text, /raw id: m1/);
	assert.match(text, /API alias: model-one/);
	assert.match(text, /description: Local agentic lane/);
	assert.match(text, /capability: text, image/);
	assert.match(text, /provider name: Model One/);
	assert.match(text, /reasoning enabled: yes/);
	assert.match(text, /Pi thinking level: medium/);
	assert.match(text, /OMLX-derived thinking: medium \(model_settings\.thinking_budget_tokens=8192\)/);
	assert.match(text, /thinking format: qwen-chat-template/);
	assert.match(text, /max tokens field: max_tokens/);
	assert.match(text, /identity: displayName=Model One, modelAlias=model-one/);
	assert.match(text, /limits: contextWindow=256,000, maxTokens=32,768, maxToolResultTokens=4,096/);
	assert.match(text, /Pi bridge task budget: 1,000/);
	assert.match(text, /chat-template kwargs: kwargs=\{"preserve_thinking":true\}, forcedKeys=enable_thinking/);
	assert.match(text, /sampling: temperature=0.2/);
	assert.match(text, /DFlash: enabled=yes/);
	assert.match(text, /TurboQuant: enabled=yes, bits=4/);
	assert.match(text, /lifecycle: ttlSeconds=300/);
	assert.match(text, /security: trustRemoteCode=no/);
	assert.match(text, /profile: activeProfileName=agentic/);
	assert.match(text, /last tokens\/sec: 50.0 tok\/s/);
	assert.match(text, /task budget remaining: 750 of 1,000 \(75%\)/);
	assert.match(text, /tool validation: 4/);
	assert.match(text, /tool intent: 5/);
	assert.match(text, /thinking override: sets thinking_budget=0; chat-template override blocked by forced_ct_kwargs=enable_thinking/);
});

test("renderOmlxStatus handles inactive OMLX model", () => {
	const text = renderOmlxStatus({
		...baseSnapshot,
		activePiModel: { provider: "openai", id: "gpt-5.4", name: "GPT" },
	});

	assert.match(text, /status: not using OMLX \(openai\/gpt-5.4\)/);
	assert.match(text, /provider name: n\/a/);
	assert.match(text, /active settings: n\/a/);
});

test("renderOmlxStatus reports missing settings file", () => {
	const text = renderOmlxStatus({
		...baseSnapshot,
		modelSettingsFound: false,
	});

	assert.match(text, /settings path: \/tmp\/model_settings\.json \(missing\)/);
});

test("renderOmlxStatus reports unreachable server with cached catalog", () => {
	const text = renderOmlxStatus({
		...baseSnapshot,
		registered: true,
		catalog: [{ id: "cached", displayName: "Cached Model" }],
		lastError: "connect ECONNREFUSED 127.0.0.1:8008",
		lastErrorAt: "2026-04-29T10:01:00.000Z",
		activePiModel: { provider: "omlx", id: "cached", name: "Cached Model", input: ["text"] },
	});

	assert.match(text, /model count: 1/);
	assert.match(text, /last error: connect ECONNREFUSED 127\.0\.0\.1:8008 at 2026-04-29T10:01:00\.000Z/);
	assert.match(text, /display name: Cached Model/);
});

test("renderOmlxStatus handles unavailable usage metrics", () => {
	const text = renderOmlxStatus({
		...baseSnapshot,
		catalog: [{ id: "m1" }],
		activePiModel: { provider: "omlx", id: "m1", name: "m1", input: ["text"] },
		performance: { samples: [], totalOutputTokens: 0 },
		taskBudget: recordTaskBudgetUsage(resetTaskBudget(undefined), 42).state,
	});

	assert.match(text, /last tokens\/sec: unavailable/);
	assert.match(text, /rolling tokens\/sec: unavailable/);
	assert.match(text, /output tokens: 0/);
	assert.match(text, /task budget remaining: not configured \(used 42 output tokens\)/);
});

test("renderOmlxStatus includes session trail diagnostics", () => {
	const text = renderOmlxStatus({
		...baseSnapshot,
		catalog: [{
			id: "qwen36-opus",
			displayName: "Qwen3.6 27B Ultra-Thinker",
			contextWindow: 524288,
			maxTokens: 200000,
		}],
		activePiModel: {
			provider: "omlx",
			id: "qwen36-opus",
			name: "Qwen3.6 27B Ultra-Thinker",
			contextWindow: 524288,
			maxTokens: 200000,
			compat: { maxTokensField: "max_tokens" },
		},
		session: {
			sessionFile: "/tmp/session.jsonl",
			sessionId: "019dd8e6",
			leafId: "leaf-1",
			counts: {
				userMessages: 6,
				assistantMessages: 40,
				toolCalls: 77,
				toolResults: 77,
				totalEntries: 126,
			},
			tokens: {
				input: 767024,
				output: 26079,
				cacheRead: 1441792,
				total: 2234895,
			},
			recoveryCounts: {
				boundaryGarbage: 2,
				emptyStop: 1,
				thinkingOnly: 0,
				toolValidation: 0,
				toolIntent: 1,
			},
			lastAssistantStop: {
				timestamp: "2026-04-29T12:35:17.375Z",
				stopReason: "stop",
				inputTokens: 53527,
				outputTokens: 4528,
				cacheReadTokens: 34816,
				totalTokens: 92871,
				hasVisibleText: false,
				hasThinking: true,
				hasToolCalls: false,
				contentTypes: ["thinking", "text"],
				diagnosis: "thinking-only stop before visible answer/tool call",
				thinkingPreview: "Let me write the comprehensive best practices guide.",
			},
			recentAnomalies: [{
				timestamp: "2026-04-29T12:08:57.300Z",
				stopReason: "stop",
				inputTokens: 53399,
				outputTokens: 4478,
				cacheReadTokens: 34816,
				totalTokens: 92693,
				hasVisibleText: true,
				hasThinking: true,
				hasToolCalls: false,
				contentTypes: ["thinking", "text"],
				diagnosis: "tool-intent stop (let me:write)",
				textPreview: "Now I have enough data. Let me write the best practices guide.",
			}],
		},
	});

	assert.match(text, /Session/);
	assert.match(text, /file: \/tmp\/session\.jsonl/);
	assert.match(text, /id: 019dd8e6/);
	assert.match(text, /messages: user=6, assistant=40, tool calls=77, tool results=77, total=126/);
	assert.match(text, /tokens: input=767,024, output=26,079, cache read=1,441,792, total=2,234,895/);
	assert.match(text, /last assistant stop: 2026-04-29T12:35:17\.375Z; thinking-only stop before visible answer\/tool call/);
	assert.match(text, /last stop output\/max tokens: 4,528 of 200,000 \(2%\)/);
	assert.match(text, /last stop context\/window: 92,871 of 524,288 \(18%\)/);
	assert.match(text, /recent anomalies: 2026-04-29T12:08:57\.300Z; tool-intent stop \(let me:write\)/);
	assert.match(text, /session recoveries: boundary=2, empty=1, thinking=0, validation=0, tool intent=1/);
});
