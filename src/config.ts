import { loadOmlxCredential } from "./auth-storage.ts";

export interface OmlxConfig {
	apiRoot: string;
	apiKeyEnvVar: string;
}

export class MissingEnvError extends Error {
	constructor(public readonly varName: string) {
		super(`${varName} is not set`);
		this.name = "MissingEnvError";
	}
}

export function normalizeBaseUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("OMLX_BASE_URL is empty");
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OmlxConfig {
	const baseUrl = env.OMLX_BASE_URL;
	if (!baseUrl) throw new MissingEnvError("OMLX_BASE_URL");
	if (!env.OMLX_API_KEY) throw new MissingEnvError("OMLX_API_KEY");
	return {
		apiRoot: normalizeBaseUrl(baseUrl),
		apiKeyEnvVar: "OMLX_API_KEY",
	};
}

// Env vars win over stored creds so CI and per-shell overrides work.
export function applyStoredCredentialToEnv(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (env.OMLX_BASE_URL && env.OMLX_API_KEY) return false;
	const stored = loadOmlxCredential();
	if (!stored) return false;
	let applied = false;
	if (!env.OMLX_BASE_URL) {
		env.OMLX_BASE_URL = stored.baseUrl;
		applied = true;
	}
	if (!env.OMLX_API_KEY) {
		env.OMLX_API_KEY = stored.apiKey;
		applied = true;
	}
	return applied;
}
