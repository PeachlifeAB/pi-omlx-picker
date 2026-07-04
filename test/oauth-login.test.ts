import { strict as assert } from "node:assert";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { test } from "vitest";
import {
	createLoginOmlx,
	getOmlxApiKey,
	refreshOmlxToken,
} from "../src/oauth-login.ts";

function callbacksReturning(...values: string[]): OAuthLoginCallbacks {
	const queue = [...values];
	return {
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => queue.shift() ?? "",
		onSelect: async () => undefined,
	};
}

const registerOk = async () => ({ ok: true as const });

test("loginOmlx prompts for base URL then API key and normalizes the URL", async () => {
	const loginOmlx = createLoginOmlx(registerOk);
	const creds = await loginOmlx(
		callbacksReturning("http://127.0.0.1:8000", "omlx-key"),
	);
	assert.equal(creds.baseUrl, "http://127.0.0.1:8000/v1");
	assert.equal(creds.access, "omlx-key");
	assert.equal(creds.refresh, "");
});

test("loginOmlx accepts an empty API key for a keyless server", async () => {
	const loginOmlx = createLoginOmlx(registerOk);
	const creds = await loginOmlx(
		callbacksReturning("https://omlx.example.com/v1", ""),
	);
	assert.equal(creds.baseUrl, "https://omlx.example.com/v1");
	assert.equal(creds.access, "");
});

test("loginOmlx rejects an empty base URL", async () => {
	const loginOmlx = createLoginOmlx(registerOk);
	await assert.rejects(() => loginOmlx(callbacksReturning("", "key")));
});

test("loginOmlx registers the real catalog before returning credentials", async () => {
	const calls: Array<{ baseUrl: string; apiKey: string }> = [];
	const loginOmlx = createLoginOmlx(async (baseUrl, apiKey) => {
		calls.push({ baseUrl, apiKey });
		return { ok: true };
	});
	await loginOmlx(callbacksReturning("http://127.0.0.1:8000", "omlx-key"));
	assert.deepEqual(calls, [
		{ baseUrl: "http://127.0.0.1:8000/v1", apiKey: "omlx-key" },
	]);
});

test("loginOmlx rejects when the catalog fetch fails, without storing credentials", async () => {
	const loginOmlx = createLoginOmlx(async () => ({
		ok: false,
		error: "connection refused",
	}));
	await assert.rejects(
		() => loginOmlx(callbacksReturning("http://127.0.0.1:8000", "omlx-key")),
		/connection refused/,
	);
});

test("getOmlxApiKey reads the access field", () => {
	assert.equal(
		getOmlxApiKey({ access: "abc", refresh: "", expires: 0 }),
		"abc",
	);
});

test("refreshOmlxToken returns credentials unchanged", async () => {
	const creds = { access: "abc", refresh: "", expires: 0, baseUrl: "u" };
	assert.deepEqual(await refreshOmlxToken(creds), creds);
});
