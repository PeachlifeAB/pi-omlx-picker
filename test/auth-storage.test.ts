import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import {
	_setStorageForTesting,
	deleteOmlxCredential,
	loadOmlxCredential,
	PROVIDER_KEY,
	saveOmlxCredential,
} from "../src/auth-storage.ts";

let inMemory: AuthStorage;
beforeEach(() => {
	inMemory = AuthStorage.inMemory();
	_setStorageForTesting(inMemory);
});
afterEach(() => {
	_setStorageForTesting(undefined);
});

test("loadOmlxCredential returns undefined when nothing is stored", () => {
	assert.equal(loadOmlxCredential(), undefined);
});

test("save then load round-trip", () => {
	saveOmlxCredential("http://127.0.0.1:8000/v1", "omlx-key");
	assert.deepEqual(loadOmlxCredential(), { baseUrl: "http://127.0.0.1:8000/v1", apiKey: "omlx-key" });
});

test("save preserves sibling provider entries", () => {
	inMemory.set("anthropic", { type: "oauth", access: "x", refresh: "r", expires: 0 });
	saveOmlxCredential("https://omlx.example.com/v1", "k");
	assert.deepEqual(inMemory.get("anthropic"), { type: "oauth", access: "x", refresh: "r", expires: 0 });
	const omlx = inMemory.get(PROVIDER_KEY) as { type: string; key: string; baseUrl: string };
	assert.equal(omlx.type, "api_key");
	assert.equal(omlx.key, "k");
	assert.equal(omlx.baseUrl, "https://omlx.example.com/v1");
});

test("delete leaves sibling providers intact", () => {
	inMemory.set("anthropic", { type: "oauth", access: "x", refresh: "r", expires: 0 });
	saveOmlxCredential("u", "k");
	deleteOmlxCredential();
	assert.equal(inMemory.has(PROVIDER_KEY), false);
	assert.equal(inMemory.has("anthropic"), true);
});

test("delete is a no-op when nothing is stored", () => {
	deleteOmlxCredential();
	assert.equal(loadOmlxCredential(), undefined);
});

test("load ignores entries missing baseUrl or key", () => {
	inMemory.set(PROVIDER_KEY, { type: "api_key", key: "" });
	assert.equal(loadOmlxCredential(), undefined);
});
