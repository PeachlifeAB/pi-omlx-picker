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
