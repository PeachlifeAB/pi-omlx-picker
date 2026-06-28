import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	applyLocalModelSettings,
	fetchModels,
	parseModelsResponse,
	parseModelsStatusResponse,
	resolveArchContextLimits,
} from "../src/catalog.ts";

test("resolveArchContextLimits uses arch ceiling as prio-3 fallback", () => {
	const [m] = resolveArchContextLimits([{ id: "x", archContextWindow: 72099 }]);
	assert.equal(m.contextWindow, 72099);
});

test("resolveArchContextLimits clamps a user value above the arch ceiling", () => {
	const [m] = resolveArchContextLimits([
		{ id: "x", contextWindow: 200000, archContextWindow: 72099 },
	]);
	assert.equal(m.contextWindow, 72099);
});

test("resolveArchContextLimits keeps a user value within the arch ceiling", () => {
	const [m] = resolveArchContextLimits([
		{ id: "x", contextWindow: 32000, archContextWindow: 72099 },
	]);
	assert.equal(m.contextWindow, 32000);
});

test("resolveArchContextLimits leaves models without an arch ceiling untouched", () => {
	const [m] = resolveArchContextLimits([{ id: "x", contextWindow: 200000 }]);
	assert.equal(m.contextWindow, 200000);
});

test("parseModelsResponse extracts ids from OpenAI shape", () => {
	const json = {
		object: "list",
		data: [
			{ id: "Qwen3.5-9B-MLX-4bit", object: "model", owned_by: "omlx" },
			{ id: "gemma-4-26b-a4b-it-4bit", object: "model", owned_by: "omlx" },
		],
	};
	assert.deepEqual(parseModelsResponse(json), [
		{ id: "Qwen3.5-9B-MLX-4bit" },
		{ id: "gemma-4-26b-a4b-it-4bit" },
	]);
});

test("parseModelsResponse drops entries without id", () => {
	const json = {
		object: "list",
		data: [{ id: "ok" }, {}, { id: "" }, { id: "also-ok" }],
	};
	assert.deepEqual(parseModelsResponse(json), [
		{ id: "ok" },
		{ id: "also-ok" },
	]);
});

test("parseModelsResponse captures max_model_len as archContextWindow", () => {
	const json = {
		object: "list",
		data: [
			{ id: "with-len", max_model_len: 72099 },
			{ id: "no-len" },
			{ id: "zero-len", max_model_len: 0 },
			{ id: "null-len", max_model_len: null },
		],
	};
	assert.deepEqual(parseModelsResponse(json), [
		{ id: "with-len", archContextWindow: 72099 },
		{ id: "no-len" },
		{ id: "zero-len" },
		{ id: "null-len" },
	]);
});

test("parseModelsResponse dedupes", () => {
	const json = {
		object: "list",
		data: [{ id: "a" }, { id: "a" }, { id: "b" }],
	};
	assert.deepEqual(parseModelsResponse(json), [{ id: "a" }, { id: "b" }]);
});

test("parseModelsResponse throws on missing data array", () => {
	assert.throws(() => parseModelsResponse({ object: "list" }), /data/);
	assert.throws(() => parseModelsResponse(null), /data/);
});

test("parseModelsStatusResponse extracts Pi-supported fields and OMLX-only metadata", () => {
	const json = {
		models: [
			{
				id: "m1",
				display_name: "Reasoning Model",
				description: "Local reasoning lane",
				model_alias: "reasoning-model",
				max_context_window: 256000,
				max_tokens: 32768,
				thinking_default: true,
				max_tool_result_tokens: 4096,
				thinking_budget_enabled: true,
				thinking_budget_tokens: 8192,
				preserve_thinking: false,
				chat_template_kwargs: { preserve_thinking: true },
				forced_ct_kwargs: ["enable_thinking"],
				is_default: true,
				pinned: true,
				trust_remote_code: false,
				ttl_seconds: 300,
				index_cache_freq: 4,
				reasoning_parser: "qwen",
				active_profile_name: "agentic",
				model_type_override: "vlm",
			},
			{
				id: "m2",
				max_context_window: 128000,
				max_tokens: 8192,
				thinking_default: null,
			},
		],
	};
	assert.deepEqual(parseModelsStatusResponse(json), [
		{
			id: "m1",
			displayName: "Reasoning Model",
			description: "Local reasoning lane",
			modelAlias: "reasoning-model",
			contextWindow: 256000,
			maxTokens: 32768,
			thinkingDefault: true,
			maxToolResultTokens: 4096,
			thinkingBudgetEnabled: true,
			thinkingBudgetTokens: 8192,
			preserveThinking: false,
			chatTemplateKwargs: { preserve_thinking: true },
			forcedCtKwargs: ["enable_thinking"],
			isDefault: true,
			isPinned: true,
			trustRemoteCode: false,
			ttlSeconds: 300,
			indexCacheFreq: 4,
			reasoningParser: "qwen",
			activeProfileName: "agentic",
			modelType: "vlm",
		},
		{ id: "m2", contextWindow: 128000, maxTokens: 8192, thinkingDefault: null },
	]);
});

test("parseModelsStatusResponse omits missing numeric fields", () => {
	const json = {
		models: [{ id: "m1" }, { id: "m2", max_context_window: 64000 }],
	};
	assert.deepEqual(parseModelsStatusResponse(json), [
		{ id: "m1" },
		{ id: "m2", contextWindow: 64000 },
	]);
});

test("parseModelsStatusResponse throws on missing models array", () => {
	assert.throws(() => parseModelsStatusResponse({}), /models/);
});

test("fetchModels prefers /models/status", async () => {
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (url: string) => {
		calls.push(url);
		if (url.endsWith("/models/status")) {
			return new Response(
				JSON.stringify({
					models: [
						{
							id: "x",
							max_context_window: 256000,
							max_tokens: 32768,
							thinking_default: false,
						},
					],
				}),
				{ status: 200 },
			);
		}
		throw new Error(`unexpected url ${url}`);
	}) as typeof fetch;
	try {
		const models = await fetchModels("http://example.test/v1", "k");
		assert.deepEqual(models, [
			{
				id: "x",
				contextWindow: 256000,
				maxTokens: 32768,
				thinkingDefault: false,
			},
		]);
		assert.deepEqual(calls, ["http://example.test/v1/models/status"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("fetchModels omits the Authorization header for keyless servers", async () => {
	const originalFetch = globalThis.fetch;
	let sawAuthHeader: string | null = "unset";
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (url.endsWith("/models/status")) {
			const headers = new Headers(init?.headers);
			sawAuthHeader = headers.get("Authorization");
			return new Response(
				JSON.stringify({
					models: [{ id: "x", max_context_window: 1000, max_tokens: 500 }],
				}),
				{ status: 200 },
			);
		}
		throw new Error(`unexpected url ${url}`);
	}) as typeof fetch;
	try {
		await fetchModels("http://example.test/v1", "");
		assert.equal(sawAuthHeader, null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("fetchModels applies local OMLX model settings for localhost metadata refinement", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-omlx-picker-"));
	const settingsPath = join(dir, "model_settings.json");
	writeFileSync(
		settingsPath,
		JSON.stringify({
			version: 1,
			models: {
				documenter: {
					chat_template_kwargs: {
						enable_thinking: false,
						preserve_thinking: true,
					},
					forced_ct_kwargs: ["enable_thinking"],
					thinking_budget_enabled: false,
					thinking_budget_tokens: 0,
					max_context_window: 262144,
					max_tokens: 81920,
				},
			},
		}),
	);

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		if (url.endsWith("/models/status")) {
			return new Response(
				JSON.stringify({
					models: [
						{
							id: "documenter",
							max_context_window: 128000,
							max_tokens: 32768,
							thinking_default: true,
						},
					],
				}),
				{ status: 200 },
			);
		}
		throw new Error(`unexpected url ${url}`);
	}) as typeof fetch;
	try {
		const models = await fetchModels("http://127.0.0.1:8000/v1", "k", {
			modelSettingsPath: settingsPath,
		});
		assert.equal(models.length, 1);
		const [model] = models;
		assert.equal(model.id, "documenter");
		assert.equal(model.contextWindow, 262144);
		assert.equal(model.maxTokens, 81920);
		assert.equal(model.thinkingDefault, false);
		assert.equal(model.preserveThinking, true);
		assert.deepEqual(model.forcedCtKwargs, ["enable_thinking"]);
		assert.equal(model.thinkingBudgetEnabled, false);
		assert.equal(model.thinkingBudgetTokens, 0);
		assert.deepEqual(model.settingsSummary, {
			thinking: {
				enabled: false,
				budgetEnabled: false,
				budgetTokens: 0,
				preserve: true,
				forcedCtKwargs: ["enable_thinking"],
			},
			chatTemplate: {
				kwargs: { enable_thinking: false, preserve_thinking: true },
				forcedKeys: ["enable_thinking"],
			},
			limits: {
				contextWindow: 262144,
				maxTokens: 81920,
			},
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("applyLocalModelSettings projects full model_settings entry into bridge metadata", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-omlx-picker-"));
	const settingsPath = join(dir, "model_settings.json");
	writeFileSync(
		settingsPath,
		JSON.stringify({
			version: 1,
			models: {
				"vision-lane": {
					display_name: "Vision Lane",
					description: "Useful for screenshots",
					model_alias: "vision",
					enable_thinking: true,
					chat_template_kwargs: {
						enable_thinking: false,
						preserve_thinking: true,
						reasoning_effort: "high",
					},
					forced_ct_kwargs: ["enable_thinking", "preserve_thinking"],
					thinking_budget_enabled: true,
					thinking_budget_tokens: 12000,
					task_budget_tokens: 64000,
					max_tool_result_tokens: 4096,
					max_context_window: 512000,
					max_tokens: 131072,
					model_type_override: "VLM",
					reasoning_parser: "qwen",
					ttl_seconds: 300,
					index_cache_freq: 4,
					temperature: 0.2,
					top_p: 0.95,
					top_k: 40,
					min_p: 0.05,
					repetition_penalty: 1.05,
					presence_penalty: 0.1,
					force_sampling: true,
					dflash_enabled: true,
					dflash_draft_model: "draft-qwen",
					dflash_draft_quant_bits: 4,
					specprefill_enabled: true,
					specprefill_draft_model: "prefill-qwen",
					specprefill_keep_pct: 0.5,
					specprefill_threshold: 256,
					turboquant_kv_enabled: true,
					turboquant_kv_bits: 4,
					turboquant_skip_last: false,
					is_default: true,
					is_pinned: true,
					trust_remote_code: false,
					active_profile_name: "agentic",
				},
			},
		}),
	);

	const [model] = applyLocalModelSettings(
		[{ id: "vision-lane" }],
		"http://127.0.0.1:8000/v1",
		settingsPath,
	);

	assert.equal(model.displayName, "Vision Lane");
	assert.equal(model.description, "Useful for screenshots");
	assert.equal(model.modelAlias, "vision");
	assert.equal(model.thinkingDefault, true);
	assert.equal(model.contextWindow, 512000);
	assert.equal(model.maxTokens, 131072);
	assert.equal(model.taskBudgetTokens, 64000);
	assert.equal(model.maxToolResultTokens, 4096);
	assert.equal(model.thinkingBudgetEnabled, true);
	assert.equal(model.thinkingBudgetTokens, 12000);
	assert.equal(model.preserveThinking, true);
	assert.deepEqual(model.forcedCtKwargs, [
		"enable_thinking",
		"preserve_thinking",
	]);
	assert.equal(model.isDefault, true);
	assert.equal(model.isPinned, true);
	assert.equal(model.trustRemoteCode, false);
	assert.equal(model.ttlSeconds, 300);
	assert.equal(model.indexCacheFreq, 4);
	assert.equal(model.reasoningParser, "qwen");
	assert.equal(model.activeProfileName, "agentic");
	assert.equal(model.modelType, "vlm");
	assert.deepEqual(model.settingsSummary, {
		identity: {
			displayName: "Vision Lane",
			description: "Useful for screenshots",
			modelAlias: "vision",
			modelTypeOverride: "VLM",
		},
		thinking: {
			enabled: true,
			budgetEnabled: true,
			budgetTokens: 12000,
			preserve: true,
			reasoningEffort: "high",
			parser: "qwen",
			forcedCtKwargs: ["enable_thinking", "preserve_thinking"],
		},
		chatTemplate: {
			kwargs: {
				enable_thinking: false,
				preserve_thinking: true,
				reasoning_effort: "high",
			},
			forcedKeys: ["enable_thinking", "preserve_thinking"],
		},
		limits: {
			contextWindow: 512000,
			maxTokens: 131072,
			maxToolResultTokens: 4096,
		},
		sampling: {
			temperature: 0.2,
			topP: 0.95,
			topK: 40,
			minP: 0.05,
			repetitionPenalty: 1.05,
			presencePenalty: 0.1,
			forceSampling: true,
		},
		dflash: {
			enabled: true,
			draftModel: "draft-qwen",
			draftQuantBits: 4,
		},
		specprefill: {
			enabled: true,
			draftModel: "prefill-qwen",
			keepPct: 0.5,
			threshold: 256,
		},
		turboquant: {
			enabled: true,
			bits: 4,
			skipLast: false,
		},
		lifecycle: {
			isDefault: true,
			isPinned: true,
			ttlSeconds: 300,
			indexCacheFreq: 4,
		},
		security: {
			trustRemoteCode: false,
		},
		profile: {
			activeProfileName: "agentic",
		},
		bridge: {
			taskBudgetTokens: 64000,
		},
	});
});

test("fetchModels emits catalog debug events for local settings refinement", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-omlx-picker-"));
	const settingsPath = join(dir, "model_settings.json");
	writeFileSync(
		settingsPath,
		JSON.stringify({
			version: 1,
			models: {
				documenter: {
					chat_template_kwargs: { enable_thinking: false },
					max_context_window: 120000,
					max_tokens: 84000,
				},
			},
		}),
	);
	const events: string[] = [];

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		if (url.endsWith("/models/status")) {
			return new Response(
				JSON.stringify({
					models: [{ id: "documenter", thinking_default: true }],
				}),
				{ status: 200 },
			);
		}
		throw new Error(`unexpected url ${url}`);
	}) as typeof fetch;
	try {
		await fetchModels("http://127.0.0.1:8000/v1", "k", {
			modelSettingsPath: settingsPath,
			onDebug: (event) => events.push(event.kind),
		});
		assert.deepEqual(events, [
			"catalog_status_loaded",
			"catalog_local_settings_considered",
			"catalog_local_model_settings_applied",
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("applyLocalModelSettings honors explicit missing path without changing metadata", () => {
	const models = applyLocalModelSettings(
		[{ id: "documenter", thinkingDefault: true }],
		"https://example.test/v1",
		join(tmpdir(), "pi-omlx-picker-missing-model-settings.json"),
	);
	assert.deepEqual(models, [{ id: "documenter", thinkingDefault: true }]);
});

test("fetchModels falls back to /models when /models/status fails", async () => {
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (url: string) => {
		calls.push(url);
		if (url.endsWith("/models/status")) {
			return new Response("not found", { status: 404 });
		}
		if (url.endsWith("/models")) {
			return new Response(
				JSON.stringify({ object: "list", data: [{ id: "y" }] }),
				{ status: 200 },
			);
		}
		if (url.endsWith("/admin/api/global-settings")) {
			return new Response(
				JSON.stringify({
					sampling: { max_context_window: 120000, max_tokens: 84000 },
				}),
				{ status: 200 },
			);
		}
		throw new Error(`unexpected url ${url}`);
	}) as typeof fetch;
	try {
		const models = await fetchModels("http://example.test/v1", "k");
		assert.deepEqual(models, [
			{ id: "y", contextWindow: 120000, maxTokens: 84000 },
		]);
		assert.deepEqual(calls, [
			"http://example.test/v1/models/status",
			"http://example.test/v1/models",
			"http://example.test/admin/api/global-settings",
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("fetchModels times out", async () => {
	const originalFetch = globalThis.fetch;
	// Simulate a server that never responds.
	globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
		return new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => {
				const err = new Error("aborted");
				err.name = "AbortError";
				reject(err);
			});
		});
	}) as typeof fetch;
	try {
		await assert.rejects(
			fetchModels("http://example.test/v1", "k", { timeoutMs: 25 }),
			/timed out after 25ms/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
