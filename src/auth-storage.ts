import type { ApiKeyCredential, OAuthCredential } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

export const PROVIDER_KEY = "omlx";

export interface OmlxStoredCredential {
	baseUrl?: string;
	apiKey: string;
}

type OmlxApiKeyCredential = ApiKeyCredential & { baseUrl?: string };
type OmlxOAuthCredential = OAuthCredential & { baseUrl?: string };

let authPathOverrideForTesting: string | undefined;

export function _setAuthPathForTesting(path: string | undefined): void {
	authPathOverrideForTesting = path;
}

export function loadOmlxCredential(): OmlxStoredCredential | undefined {
	const cred = readStoredCredential(PROVIDER_KEY, authPathOverrideForTesting) as
		| OmlxApiKeyCredential
		| OmlxOAuthCredential
		| undefined;
	if (!cred) return undefined;
	if (cred.type === "api_key") {
		if (!cred.key) return undefined;
		return { baseUrl: cred.baseUrl, apiKey: cred.key };
	}
	if (cred.type === "oauth") {
		// access may be legitimately empty for a keyless OMLX server
		// (skip_api_key_verification) — baseUrl alone still counts as configured.
		if (!cred.access && !cred.baseUrl) return undefined;
		return { baseUrl: cred.baseUrl, apiKey: cred.access ?? "" };
	}
	return undefined;
}
