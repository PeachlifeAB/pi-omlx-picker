import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import { _setStorageForTesting, saveOmlxCredential } from "../src/auth-storage.ts";
import { applyStoredCredentialToEnv, loadConfig, MissingEnvError, normalizeBaseUrl } from "../src/config.ts";

test("normalizeBaseUrl appends /v1 when missing", () => {
	assert.equal(normalizeBaseUrl("https://omlx.example.com"), "https://omlx.example.com/v1");
});

test("normalizeBaseUrl keeps /v1 when present", () => {
	assert.equal(normalizeBaseUrl("https://omlx.example.com/v1"), "https://omlx.example.com/v1");
});

test("normalizeBaseUrl strips trailing slashes", () => {
	assert.equal(normalizeBaseUrl("https://omlx.example.com/v1/"), "https://omlx.example.com/v1");
	assert.equal(normalizeBaseUrl("https://omlx.example.com///"), "https://omlx.example.com/v1");
});

test("normalizeBaseUrl rejects empty string", () => {
	assert.throws(() => normalizeBaseUrl("   "), /empty/);
});

test("loadConfig throws MissingEnvError when OMLX_BASE_URL missing", () => {
	assert.throws(() => loadConfig({ OMLX_API_KEY: "k" }), (err: Error) => {
		return err instanceof MissingEnvError && err.varName === "OMLX_BASE_URL";
	});
});

test("loadConfig throws MissingEnvError when OMLX_API_KEY missing", () => {
	assert.throws(() => loadConfig({ OMLX_BASE_URL: "https://x" }), (err: Error) => {
		return err instanceof MissingEnvError && err.varName === "OMLX_API_KEY";
	});
});

test("loadConfig returns normalized apiRoot and env var name", () => {
	const cfg = loadConfig({ OMLX_BASE_URL: "https://omlx.example.com", OMLX_API_KEY: "k" });
	assert.equal(cfg.apiRoot, "https://omlx.example.com/v1");
	assert.equal(cfg.apiKeyEnvVar, "OMLX_API_KEY");
});

beforeEach(() => {
	_setStorageForTesting(AuthStorage.inMemory());
});
afterEach(() => {
	_setStorageForTesting(undefined);
});

test("applyStoredCredentialToEnv returns false when no stored creds", () => {
	const env: NodeJS.ProcessEnv = {};
	assert.equal(applyStoredCredentialToEnv(env), false);
	assert.equal(env.OMLX_BASE_URL, undefined);
	assert.equal(env.OMLX_API_KEY, undefined);
});

test("applyStoredCredentialToEnv populates env when stored creds exist", () => {
	saveOmlxCredential("https://stored/v1", "stored-k");
	const env: NodeJS.ProcessEnv = {};
	assert.equal(applyStoredCredentialToEnv(env), true);
	assert.equal(env.OMLX_BASE_URL, "https://stored/v1");
	assert.equal(env.OMLX_API_KEY, "stored-k");
});

test("applyStoredCredentialToEnv yields to explicit env vars and returns false when nothing was set", () => {
	saveOmlxCredential("https://stored/v1", "stored-k");
	const env: NodeJS.ProcessEnv = { OMLX_BASE_URL: "https://shell/v1", OMLX_API_KEY: "shell-k" };
	assert.equal(applyStoredCredentialToEnv(env), false);
	assert.equal(env.OMLX_BASE_URL, "https://shell/v1");
	assert.equal(env.OMLX_API_KEY, "shell-k");
});

test("applyStoredCredentialToEnv reports true when only one env var is missing", () => {
	saveOmlxCredential("https://stored/v1", "stored-k");
	const env: NodeJS.ProcessEnv = { OMLX_BASE_URL: "https://shell/v1" };
	assert.equal(applyStoredCredentialToEnv(env), true);
	assert.equal(env.OMLX_BASE_URL, "https://shell/v1");
	assert.equal(env.OMLX_API_KEY, "stored-k");
});
