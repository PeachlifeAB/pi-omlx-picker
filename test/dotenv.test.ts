import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mergeDotenv, parseDotenv } from "../src/dotenv.ts";

test("parseDotenv handles bare KEY=value", () => {
	assert.deepEqual(parseDotenv("FOO=bar\nBAZ=qux"), { FOO: "bar", BAZ: "qux" });
});

test("parseDotenv strips matched surrounding double quotes", () => {
	assert.deepEqual(parseDotenv('FOO="bar baz"'), { FOO: "bar baz" });
});

test("parseDotenv strips matched surrounding single quotes", () => {
	assert.deepEqual(parseDotenv("FOO='bar baz'"), { FOO: "bar baz" });
});

test("parseDotenv leaves mismatched quotes intact", () => {
	assert.deepEqual(parseDotenv(`FOO="bar`), { FOO: '"bar' });
});

test("parseDotenv ignores blank lines and comments", () => {
	const src = `
# leading comment
FOO=bar

  # indented comment
BAZ=qux
`;
	assert.deepEqual(parseDotenv(src), { FOO: "bar", BAZ: "qux" });
});

test("parseDotenv strips 'export ' prefix", () => {
	assert.deepEqual(parseDotenv("export FOO=bar"), { FOO: "bar" });
});

test("parseDotenv preserves '=' inside the value", () => {
	assert.deepEqual(parseDotenv("URL=https://x.example?a=1&b=2"), { URL: "https://x.example?a=1&b=2" });
});

test("parseDotenv skips lines without '='", () => {
	assert.deepEqual(parseDotenv("FOO=bar\nNOT_A_PAIR\nBAZ=qux"), { FOO: "bar", BAZ: "qux" });
});

test("parseDotenv handles CRLF line endings", () => {
	assert.deepEqual(parseDotenv("FOO=bar\r\nBAZ=qux\r\n"), { FOO: "bar", BAZ: "qux" });
});

test("mergeDotenv sets unset keys", () => {
	const env: NodeJS.ProcessEnv = { EXISTING: "keep" };
	mergeDotenv({ NEW_KEY: "added", EXISTING: "ignored" }, env);
	assert.equal(env.NEW_KEY, "added");
	assert.equal(env.EXISTING, "keep");
});

test("mergeDotenv treats empty-string env vars as unset and overwrites", () => {
	const env: NodeJS.ProcessEnv = { BLANK: "" };
	mergeDotenv({ BLANK: "filled" }, env);
	assert.equal(env.BLANK, "filled");
});
