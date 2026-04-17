import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadConfig, MissingEnvError, normalizeBaseUrl } from "../src/config.ts";

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
