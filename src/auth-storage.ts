import {
	type ApiKeyCredential,
	AuthStorage,
} from "@mariozechner/pi-coding-agent";

export const PROVIDER_KEY = "omlx";

export interface OmlxStoredCredential {
	baseUrl: string;
	apiKey: string;
}

type OmlxApiKeyCredential = ApiKeyCredential & { baseUrl?: string };

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
		| undefined;
	if (!cred || cred.type !== "api_key") return undefined;
	if (!cred.baseUrl || !cred.key) return undefined;
	return { baseUrl: cred.baseUrl, apiKey: cred.key };
}

export function saveOmlxCredential(baseUrl: string, apiKey: string): void {
	const cred: OmlxApiKeyCredential = { type: "api_key", key: apiKey, baseUrl };
	getStorage().set(PROVIDER_KEY, cred);
}

export function deleteOmlxCredential(): void {
	getStorage().remove(PROVIDER_KEY);
}
