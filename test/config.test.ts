import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { _setAuthPathForTesting, PROVIDER_KEY } from "../src/auth-storage.ts";
import {
	applyStoredCredentialToEnv,
	DEFAULT_OMLX_BASE_URL,
	hasOmlxTarget,
	loadConfig,
	normalizeBaseUrl,
	resolveConfiguredApiKey,
} from "../src/config.ts";

test("normalizeBaseUrl appends /v1 when missing", () => {
	assert.equal(
		normalizeBaseUrl("https://omlx.example.com"),
		"https://omlx.example.com/v1",
	);
});

test("normalizeBaseUrl keeps /v1 when present", () => {
	assert.equal(
		normalizeBaseUrl("https://omlx.example.com/v1"),
		"https://omlx.example.com/v1",
	);
});

test("normalizeBaseUrl strips trailing slashes", () => {
	assert.equal(
		normalizeBaseUrl("https://omlx.example.com/v1/"),
		"https://omlx.example.com/v1",
	);
	assert.equal(
		normalizeBaseUrl("https://omlx.example.com///"),
		"https://omlx.example.com/v1",
	);
});

test("normalizeBaseUrl rejects empty string", () => {
	assert.throws(() => normalizeBaseUrl("   "), /empty/);
});

let dir: string;
let authPath: string;

function storeCredential(baseUrl: string, apiKey: string): void {
	writeFileSync(
		authPath,
		JSON.stringify(
			{ [PROVIDER_KEY]: { type: "api_key", key: apiKey, baseUrl } },
			null,
			2,
		),
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-omlx-picker-config-"));
	authPath = join(dir, "auth.json");
	_setAuthPathForTesting(authPath);
});
afterEach(() => {
	_setAuthPathForTesting(undefined);
	rmSync(dir, { recursive: true, force: true });
});

test("loadConfig defaults to local OMLX base URL", () => {
	const cfg = loadConfig({});
	assert.equal(cfg.apiRoot, DEFAULT_OMLX_BASE_URL);
	assert.equal(cfg.apiKeyEnvVar, "OMLX_API_KEY");
});

test("loadConfig returns normalized explicit apiRoot and env var name", () => {
	const cfg = loadConfig({ OMLX_BASE_URL: "https://omlx.example.com" });
	assert.equal(cfg.apiRoot, "https://omlx.example.com/v1");
	assert.equal(cfg.apiKeyEnvVar, "OMLX_API_KEY");
});

test("loadConfig uses stored base URL when env is absent", () => {
	storeCredential("https://stored/v1", "stored-k");
	assert.equal(loadConfig({}).apiRoot, "https://stored/v1");
});

test("loadConfig does not mix env API key with stored base URL", () => {
	storeCredential("https://stored/v1", "stored-k");
	assert.equal(
		loadConfig({ OMLX_API_KEY: "shell-k" }).apiRoot,
		DEFAULT_OMLX_BASE_URL,
	);
});

test("resolveConfiguredApiKey prefers explicit env var", () => {
	storeCredential("https://stored/v1", "stored-k");
	assert.equal(resolveConfiguredApiKey({ OMLX_API_KEY: "shell-k" }), "shell-k");
});

test("resolveConfiguredApiKey falls back to stored credential", () => {
	storeCredential("https://stored/v1", "stored-k");
	assert.equal(resolveConfiguredApiKey({}), "stored-k");
});

test("resolveConfiguredApiKey does not mix env base URL with stored key", () => {
	storeCredential("https://stored/v1", "stored-k");
	assert.equal(
		resolveConfiguredApiKey({ OMLX_BASE_URL: "https://shell/v1" }),
		undefined,
	);
});

test("hasOmlxTarget is true with an env API key", () => {
	assert.equal(hasOmlxTarget({ OMLX_API_KEY: "shell-k" }), true);
});

test("hasOmlxTarget is true with an env base URL but no key (keyless)", () => {
	assert.equal(hasOmlxTarget({ OMLX_BASE_URL: "http://localhost:8000" }), true);
});

test("hasOmlxTarget is true when only a stored credential exists", () => {
	storeCredential("https://stored/v1", "stored-k");
	assert.equal(hasOmlxTarget({}), true);
});

test("hasOmlxTarget is false with no key, no base URL, no stored creds", () => {
	assert.equal(hasOmlxTarget({}), false);
});

test("applyStoredCredentialToEnv returns false when no stored creds", () => {
	const env: NodeJS.ProcessEnv = {};
	assert.equal(applyStoredCredentialToEnv(env), false);
	assert.equal(env.OMLX_BASE_URL, undefined);
	assert.equal(env.OMLX_API_KEY, undefined);
});

test("applyStoredCredentialToEnv populates env when stored creds exist", () => {
	storeCredential("https://stored/v1", "stored-k");
	const env: NodeJS.ProcessEnv = {};
	assert.equal(applyStoredCredentialToEnv(env), true);
	assert.equal(env.OMLX_BASE_URL, "https://stored/v1");
	assert.equal(env.OMLX_API_KEY, "stored-k");
});

test("applyStoredCredentialToEnv yields to explicit env pair", () => {
	storeCredential("https://stored/v1", "stored-k");
	const env: NodeJS.ProcessEnv = {
		OMLX_BASE_URL: "https://shell/v1",
		OMLX_API_KEY: "shell-k",
	};
	assert.equal(applyStoredCredentialToEnv(env), false);
	assert.equal(env.OMLX_BASE_URL, "https://shell/v1");
	assert.equal(env.OMLX_API_KEY, "shell-k");
});

test("applyStoredCredentialToEnv does not mix partial env with stored creds", () => {
	storeCredential("https://stored/v1", "stored-k");
	const env: NodeJS.ProcessEnv = { OMLX_BASE_URL: "https://shell/v1" };
	assert.equal(applyStoredCredentialToEnv(env), false);
	assert.equal(env.OMLX_BASE_URL, "https://shell/v1");
	assert.equal(env.OMLX_API_KEY, undefined);
});
