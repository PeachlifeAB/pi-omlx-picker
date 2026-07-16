import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test } from "vitest";
import extension from "../index.ts";
import { _setAuthPathForTesting } from "../src/auth-storage.ts";

const singletonKey = Symbol.for("pi-omlx-picker/loaded");

function callbacksReturning(...values: string[]) {
	const queue = [...values];
	return {
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => queue.shift() ?? "",
		onSelect: async () => undefined,
	};
}

function jsonResponse(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as Response;
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-omlx-picker-index-"));
	_setAuthPathForTesting(join(dir, "auth.json"));
	delete (globalThis as Record<PropertyKey, unknown>)[singletonKey];
});

afterEach(() => {
	_setAuthPathForTesting(undefined);
	rmSync(dir, { recursive: true, force: true });
	delete (globalThis as Record<PropertyKey, unknown>)[singletonKey];
});

test("/login with an API key registers authenticated OMLX models", async () => {
	let registered: ProviderConfig | undefined;
	const handlers = new Map<string, () => void>();
	const pi = {
		registerProvider: (_provider: string, config: ProviderConfig) => {
			registered = config;
		},
		unregisterProvider: () => {},
		on: (event: string, handler: () => void) => {
			handlers.set(event, handler);
		},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		assert.equal(
			init?.headers && (init.headers as Record<string, string>).Authorization,
			"Bearer omlx-key",
		);
		assert.equal(String(url), "https://omlx.home.g33k.top/v1/models/status");
		return jsonResponse({
			models: [
				{
					id: "real-model",
					max_context_window: 32768,
					max_tokens: 4096,
				},
			],
		});
	}) as typeof fetch;

	try {
		await extension(pi);
		await registered?.oauth?.login(
			callbacksReturning("https://omlx.home.g33k.top", "omlx-key"),
		);
		assert.equal(registered?.authHeader, true);
		assert.equal(registered?.apiKey, "$OMLX_API_KEY");
		assert.equal(registered?.models?.[0]?.id, "real-model");
	} finally {
		globalThis.fetch = originalFetch;
		handlers.get("session_shutdown")?.();
	}
});
