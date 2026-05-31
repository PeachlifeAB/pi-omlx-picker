import { describe, expect, it } from "vitest";
import { mergeDotenv, parseDotenv } from "../src/dotenv.ts";

describe("parseDotenv", () => {
	it("parses key=value, strips export prefix, quotes, comments, blank lines, CRLF", () => {
		const input = [
			"# comment",
			"",
			"export FOO=bar",
			'BAZ="hello world"',
			"QUX='single'",
			"EQ=a=b=c",
			"\r\nCRLF=yes",
		].join("\n");
		expect(parseDotenv(input)).toEqual({
			FOO: "bar",
			BAZ: "hello world",
			QUX: "single",
			EQ: "a=b=c",
			CRLF: "yes",
		});
	});
});

describe("mergeDotenv", () => {
	it("sets missing and empty keys but does not overwrite non-empty ones", () => {
		const env: NodeJS.ProcessEnv = { EXISTING: "keep", EMPTY: "" };
		mergeDotenv({ EXISTING: "new", EMPTY: "filled", FRESH: "set" }, env);
		expect(env).toMatchObject({
			EXISTING: "keep",
			EMPTY: "filled",
			FRESH: "set",
		});
	});
});
