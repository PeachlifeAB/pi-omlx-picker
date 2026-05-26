import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function parseDotenv(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
		const eq = stripped.indexOf("=");
		if (eq === -1) continue;
		const key = stripped.slice(0, eq).trim();
		if (!key) continue;
		let val = stripped.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		result[key] = val;
	}
	return result;
}

export function mergeDotenv(
	parsed: Record<string, string>,
	env: NodeJS.ProcessEnv = process.env,
): void {
	for (const [key, val] of Object.entries(parsed)) {
		if (env[key] === undefined || env[key] === "") env[key] = val;
	}
}

export function loadDotenvFromExtensionDir(
	importMetaUrl: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	try {
		const dir = dirname(fileURLToPath(importMetaUrl));
		const dotenvPath = join(dir, ".env");
		if (!existsSync(dotenvPath)) return;
		const content = readFileSync(dotenvPath, "utf8");
		mergeDotenv(parseDotenv(content), env);
	} catch {
		// non-fatal
	}
}
