import { loadOmlxCredential } from "./auth-storage.ts";

export const DEFAULT_OMLX_BASE_URL = "http://127.0.0.1:8000/v1";

export interface OmlxConfig {
	apiRoot: string;
	apiKeyEnvVar: string;
}

export function normalizeBaseUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("OMLX_BASE_URL is empty");
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OmlxConfig {
	const stored = loadOmlxCredential();
	const baseUrl = env.OMLX_BASE_URL
		? env.OMLX_BASE_URL
		: env.OMLX_API_KEY
			? DEFAULT_OMLX_BASE_URL
			: (stored?.baseUrl ?? DEFAULT_OMLX_BASE_URL);
	return {
		apiRoot: normalizeBaseUrl(baseUrl),
		apiKeyEnvVar: "OMLX_API_KEY",
	};
}

export function resolveConfiguredApiKey(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.OMLX_API_KEY) return env.OMLX_API_KEY;
	if (env.OMLX_BASE_URL) return undefined;
	return loadOmlxCredential()?.apiKey;
}

// Legacy helper for older stored api_key credentials. Never fills only one side
// of the env pair; partial shell overrides remain explicit shell state.
export function applyStoredCredentialToEnv(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (env.OMLX_BASE_URL || env.OMLX_API_KEY) return false;
	const stored = loadOmlxCredential();
	if (!stored?.apiKey) return false;
	env.OMLX_BASE_URL = stored.baseUrl ?? DEFAULT_OMLX_BASE_URL;
	env.OMLX_API_KEY = stored.apiKey;
	return true;
}
