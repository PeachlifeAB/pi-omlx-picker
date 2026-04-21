export interface OmlxModel {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	thinkingDefault?: boolean | null;
}

interface OpenAIModelsResponse {
	object: string;
	data: Array<{ id: string; object?: string }>;
}

interface OmlxModelsStatusResponse {
	models: Array<{
		id: string;
		max_context_window?: number;
		max_tokens?: number;
		thinking_default?: boolean | null;
	}>;
}

export function parseModelsResponse(json: unknown): OmlxModel[] {
	const r = json as OpenAIModelsResponse | undefined;
	if (!r || !Array.isArray(r.data)) {
		throw new Error("OMLX /models response is missing `data` array");
	}
	const seen = new Set<string>();
	const out: OmlxModel[] = [];
	for (const entry of r.data) {
		if (!entry || typeof entry.id !== "string" || !entry.id) continue;
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		out.push({ id: entry.id });
	}
	return out;
}

export function parseModelsStatusResponse(json: unknown): OmlxModel[] {
	const r = json as OmlxModelsStatusResponse | undefined;
	if (!r || !Array.isArray(r.models)) {
		throw new Error("OMLX /models/status response is missing `models` array");
	}
	const seen = new Set<string>();
	const out: OmlxModel[] = [];
	for (const entry of r.models) {
		if (!entry || typeof entry.id !== "string" || !entry.id) continue;
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		const m: OmlxModel = { id: entry.id };
		if (typeof entry.max_context_window === "number") m.contextWindow = entry.max_context_window;
		if (typeof entry.max_tokens === "number") m.maxTokens = entry.max_tokens;
		if ("thinking_default" in entry) m.thinkingDefault = entry.thinking_default ?? null;
		out.push(m);
	}
	return out;
}

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export async function fetchModels(
	apiRoot: string,
	apiKey: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OmlxModel[]> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

	try {
		const json = await getJson(`${apiRoot}/models/status`, apiKey, opts.signal, timeoutMs);
		return parseModelsStatusResponse(json);
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") throw err;
		// Fall through to /models for servers without /models/status.
	}

	const json = await getJson(`${apiRoot}/models`, apiKey, opts.signal, timeoutMs);
	return parseModelsResponse(json);
}

async function getJson(url: string, apiKey: string, parent: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
	const signal = withTimeout(parent, timeoutMs);
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal,
	}).catch((err) => {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(`GET ${url} timed out after ${timeoutMs}ms`);
		}
		throw err;
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`GET ${url} → ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
	}
	return res.json();
}

function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	if (parent) {
		if (parent.aborted) ctl.abort();
		else parent.addEventListener("abort", () => ctl.abort(), { once: true });
	}
	ctl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
	return ctl.signal;
}
