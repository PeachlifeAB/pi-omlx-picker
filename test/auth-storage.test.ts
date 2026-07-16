import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	_setAuthPathForTesting,
	loadOmlxCredential,
	PROVIDER_KEY,
} from "../src/auth-storage.ts";

let dir: string;
let authPath: string;

function writeAuth(data: Record<string, unknown>): void {
	writeFileSync(authPath, JSON.stringify(data, null, 2));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-omlx-picker-auth-"));
	authPath = join(dir, "auth.json");
	_setAuthPathForTesting(authPath);
});
afterEach(() => {
	_setAuthPathForTesting(undefined);
	rmSync(dir, { recursive: true, force: true });
});

test("loadOmlxCredential returns undefined when nothing is stored", () => {
	assert.equal(loadOmlxCredential(), undefined);
});

test("load reads normal /login api-key credential without base URL", () => {
	writeAuth({ [PROVIDER_KEY]: { type: "api_key", key: "omlx-key" } });
	assert.deepEqual(loadOmlxCredential(), {
		baseUrl: undefined,
		apiKey: "omlx-key",
	});
});

test("load reads legacy oauth-shaped OMLX credential", () => {
	writeAuth({
		[PROVIDER_KEY]: {
			type: "oauth",
			access: "omlx-key",
			refresh: "omlx-key",
			expires: Date.now() + 1000,
			baseUrl: "https://omlx.example.com/v1",
		},
	});
	assert.deepEqual(loadOmlxCredential(), {
		baseUrl: "https://omlx.example.com/v1",
		apiKey: "omlx-key",
	});
});

test("load reads keyless oauth-shaped credential (baseUrl only, empty access)", () => {
	writeAuth({
		[PROVIDER_KEY]: {
			type: "oauth",
			access: "",
			refresh: "",
			expires: Number.POSITIVE_INFINITY,
			baseUrl: "https://omlx.example.com/v1",
		},
	});
	assert.deepEqual(loadOmlxCredential(), {
		baseUrl: "https://omlx.example.com/v1",
		apiKey: "",
	});
});

test("load ignores sibling provider entries", () => {
	writeAuth({
		anthropic: { type: "oauth", access: "x", refresh: "r", expires: 0 },
		[PROVIDER_KEY]: { type: "api_key", key: "k" },
	});
	assert.deepEqual(loadOmlxCredential(), { baseUrl: undefined, apiKey: "k" });
});

test("load returns undefined when auth.json does not exist", () => {
	assert.equal(loadOmlxCredential(), undefined);
});

test("load ignores entries missing key", () => {
	writeAuth({ [PROVIDER_KEY]: { type: "api_key", key: "" } });
	assert.equal(loadOmlxCredential(), undefined);
});
