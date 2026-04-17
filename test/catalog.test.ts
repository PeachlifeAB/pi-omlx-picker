import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fetchModels, parseModelsResponse, parseModelsStatusResponse } from "../src/catalog.ts";

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
	assert.deepEqual(parseModelsResponse(json), [{ id: "ok" }, { id: "also-ok" }]);
});

test("parseModelsResponse dedupes", () => {
	const json = { object: "list", data: [{ id: "a" }, { id: "a" }, { id: "b" }] };
	assert.deepEqual(parseModelsResponse(json), [{ id: "a" }, { id: "b" }]);
});

test("parseModelsResponse throws on missing data array", () => {
	assert.throws(() => parseModelsResponse({ object: "list" }), /data/);
	assert.throws(() => parseModelsResponse(null), /data/);
});

test("parseModelsStatusResponse extracts id, contextWindow, maxTokens", () => {
	const json = {
		models: [
			{ id: "m1", max_context_window: 256000, max_tokens: 32768 },
			{ id: "m2", max_context_window: 128000, max_tokens: 8192 },
		],
	};
	assert.deepEqual(parseModelsStatusResponse(json), [
		{ id: "m1", contextWindow: 256000, maxTokens: 32768 },
		{ id: "m2", contextWindow: 128000, maxTokens: 8192 },
	]);
});

test("parseModelsStatusResponse omits missing numeric fields", () => {
	const json = { models: [{ id: "m1" }, { id: "m2", max_context_window: 64000 }] };
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
				JSON.stringify({ models: [{ id: "x", max_context_window: 256000, max_tokens: 32768 }] }),
				{ status: 200 },
			);
		}
		throw new Error(`unexpected url ${url}`);
	}) as typeof fetch;
	try {
		const models = await fetchModels("http://example.test/v1", "k");
		assert.deepEqual(models, [{ id: "x", contextWindow: 256000, maxTokens: 32768 }]);
		assert.deepEqual(calls, ["http://example.test/v1/models/status"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("fetchModels falls back to /models when /models/status fails", async () => {
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (url: string) => {
		calls.push(url);
		if (url.endsWith("/models/status")) {
			return new Response("not found", { status: 404 });
		}
		return new Response(JSON.stringify({ object: "list", data: [{ id: "y" }] }), { status: 200 });
	}) as typeof fetch;
	try {
		const models = await fetchModels("http://example.test/v1", "k");
		assert.deepEqual(models, [{ id: "y" }]);
		assert.deepEqual(calls, [
			"http://example.test/v1/models/status",
			"http://example.test/v1/models",
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
