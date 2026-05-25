import {
	type ApiKeyCredential,
	AuthStorage,
	type OAuthCredential,
} from "@earendil-works/pi-coding-agent";

export const PROVIDER_KEY = "omlx";

export interface OmlxStoredCredential {
	baseUrl?: string;
	apiKey: string;
}

type OmlxApiKeyCredential = ApiKeyCredential & { baseUrl?: string };
type OmlxOAuthCredential = OAuthCredential & { baseUrl?: string };

let storage: AuthStorage | undefined;
function getStorage(): AuthStorage {
	if (!storage) storage = AuthStorage.create();
	return storage;
}

export function _setStorageForTesting(s: AuthStorage | undefined): void {
	storage = s;
}

export function loadOmlxCredential(): OmlxStoredCredential | undefined {
	const cred = getStorage().get(PROVIDER_KEY) as
		| OmlxApiKeyCredential
		| OmlxOAuthCredential
		| undefined;
	if (!cred) return undefined;
	if (cred.type === "api_key") {
		if (!cred.key) return undefined;
		return { baseUrl: cred.baseUrl, apiKey: cred.key };
	}
	if (cred.type === "oauth") {
		if (!cred.access) return undefined;
		return { baseUrl: cred.baseUrl, apiKey: cred.access };
	}
	return undefined;
}

export function saveOmlxCredential(baseUrl: string, apiKey: string): void {
	const cred: OmlxApiKeyCredential = { type: "api_key", key: apiKey, baseUrl };
	getStorage().set(PROVIDER_KEY, cred);
}

export function deleteOmlxCredential(): void {
	getStorage().remove(PROVIDER_KEY);
}
