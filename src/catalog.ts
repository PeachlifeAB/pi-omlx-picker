import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface OmlxModel {
	id: string;
	displayName?: string;
	description?: string;
	modelAlias?: string;
	contextWindow?: number;
	maxTokens?: number;
	/** Model architectural ceiling (`max_model_len`). Prio-3 fallback and clamp limit. */
	archContextWindow?: number;
	thinkingDefault?: boolean | null;
	taskBudgetTokens?: number;
	maxToolResultTokens?: number;
	thinkingBudgetTokens?: number;
	thinkingBudgetEnabled?: boolean;
	preserveThinking?: boolean;
	chatTemplateKwargs?: Record<string, unknown>;
	forcedCtKwargs?: string[];
	isDefault?: boolean;
	isPinned?: boolean;
	trustRemoteCode?: boolean;
	ttlSeconds?: number;
	indexCacheFreq?: number;
	reasoningParser?: string;
	activeProfileName?: string;
	modelType?: string | null;
	settingsSummary?: Record<string, unknown>;
}

export interface CatalogDebugEvent {
	kind: string;
	details: Record<string, unknown>;
}

interface OpenAIModelsResponse {
	object: string;
	data: Array<{ id: string; object?: string; max_model_len?: number | null }>;
}

interface OmlxModelsStatusResponse {
	models: Array<{
		id: string;
		display_name?: string | null;
		description?: string | null;
		model_alias?: string | null;
		max_context_window?: number;
		max_tokens?: number;
		thinking_default?: boolean | null;
		enable_thinking?: boolean | null;
		max_tool_result_tokens?: number;
		thinking_budget_tokens?: number;
		thinking_budget_enabled?: boolean;
		preserve_thinking?: boolean | null;
		chat_template_kwargs?: Record<string, unknown> | null;
		forced_ct_kwargs?: string[];
		is_default?: boolean;
		is_pinned?: boolean;
		pinned?: boolean;
		trust_remote_code?: boolean;
		ttl_seconds?: number;
		index_cache_freq?: number;
		reasoning_parser?: string | null;
		active_profile_name?: string | null;
		model_type?: string | null;
		engine_type?: string | null;
		model_type_override?: string | null;
	}>;
}

interface OmlxGlobalSettingsResponse {
	sampling?: {
		max_context_window?: number;
		max_tokens?: number;
	};
}

interface OmlxGlobalDefaults {
	contextWindow?: number;
	maxTokens?: number;
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
		const m: OmlxModel = { id: entry.id };
		if (typeof entry.max_model_len === "number" && entry.max_model_len > 0)
			m.archContextWindow = entry.max_model_len;
		out.push(m);
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
		if (typeof entry.display_name === "string" && entry.display_name.trim())
			m.displayName = entry.display_name;
		if (typeof entry.description === "string" && entry.description.trim())
			m.description = entry.description;
		if (typeof entry.model_alias === "string" && entry.model_alias.trim())
			m.modelAlias = entry.model_alias;
		if (typeof entry.max_context_window === "number")
			m.contextWindow = entry.max_context_window;
		if (typeof entry.max_tokens === "number") m.maxTokens = entry.max_tokens;
		const chatTemplateKwargs = asRecord(entry.chat_template_kwargs);
		if (chatTemplateKwargs) m.chatTemplateKwargs = chatTemplateKwargs;
		if (typeof entry.enable_thinking === "boolean") {
			m.thinkingDefault = entry.enable_thinking;
		} else if (
			chatTemplateKwargs &&
			typeof chatTemplateKwargs.enable_thinking === "boolean"
		) {
			m.thinkingDefault = chatTemplateKwargs.enable_thinking;
		} else if ("thinking_default" in entry) {
			m.thinkingDefault = entry.thinking_default ?? null;
		}
		if (typeof entry.max_tool_result_tokens === "number")
			m.maxToolResultTokens = entry.max_tool_result_tokens;
		if (typeof entry.thinking_budget_tokens === "number")
			m.thinkingBudgetTokens = entry.thinking_budget_tokens;
		if (typeof entry.thinking_budget_enabled === "boolean")
			m.thinkingBudgetEnabled = entry.thinking_budget_enabled;
		if (typeof entry.preserve_thinking === "boolean")
			m.preserveThinking = entry.preserve_thinking;
		else if (typeof chatTemplateKwargs?.preserve_thinking === "boolean")
			m.preserveThinking = chatTemplateKwargs.preserve_thinking;
		if (Array.isArray(entry.forced_ct_kwargs)) {
			m.forcedCtKwargs = entry.forced_ct_kwargs.filter(
				(item): item is string => typeof item === "string",
			);
		}
		if (typeof entry.is_default === "boolean") m.isDefault = entry.is_default;
		if (typeof entry.is_pinned === "boolean") m.isPinned = entry.is_pinned;
		else if (typeof entry.pinned === "boolean") m.isPinned = entry.pinned;
		if (typeof entry.trust_remote_code === "boolean")
			m.trustRemoteCode = entry.trust_remote_code;
		if (typeof entry.ttl_seconds === "number") m.ttlSeconds = entry.ttl_seconds;
		if (typeof entry.index_cache_freq === "number")
			m.indexCacheFreq = entry.index_cache_freq;
		if (
			typeof entry.reasoning_parser === "string" &&
			entry.reasoning_parser.trim()
		)
			m.reasoningParser = entry.reasoning_parser;
		if (
			typeof entry.active_profile_name === "string" &&
			entry.active_profile_name.trim()
		)
			m.activeProfileName = entry.active_profile_name;
		const type =
			entry.model_type_override ?? entry.model_type ?? entry.engine_type;
		if (typeof type === "string") m.modelType = type.toLowerCase();
		out.push(m);
	}
	return out;
}

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export async function fetchModels(
	apiRoot: string,
	apiKey: string,
	opts: {
		signal?: AbortSignal;
		timeoutMs?: number;
		modelSettingsPath?: string;
		onDebug?: (event: CatalogDebugEvent) => void;
	} = {},
): Promise<OmlxModel[]> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	let models: OmlxModel[];

	try {
		const json = await getJson(
			`${apiRoot}/models/status`,
			apiKey,
			opts.signal,
			timeoutMs,
		);
		models = parseModelsStatusResponse(json);
		opts.onDebug?.({
			kind: "catalog_status_loaded",
			details: {
				apiRoot,
				count: models.length,
				documenter: models.find((m) => m.id === "qwen3.6-8b-documenter"),
			},
		});
		models = applyLocalModelSettings(
			models,
			apiRoot,
			opts.modelSettingsPath,
			opts.onDebug,
		);
		return resolveArchContextLimits(
			await applyApiGlobalDefaultsIfNeeded(
				models,
				apiRoot,
				apiKey,
				opts.signal,
				timeoutMs,
				opts.onDebug,
			),
		);
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") throw err;
		opts.onDebug?.({
			kind: "catalog_status_failed",
			details: {
				apiRoot,
				error: err instanceof Error ? err.message : String(err),
			},
		});
		// Fall through to /models for servers without /models/status.
	}

	const json = await getJson(
		`${apiRoot}/models`,
		apiKey,
		opts.signal,
		timeoutMs,
	);
	models = parseModelsResponse(json);
	opts.onDebug?.({
		kind: "catalog_models_loaded",
		details: { apiRoot, count: models.length },
	});
	models = applyLocalModelSettings(
		models,
		apiRoot,
		opts.modelSettingsPath,
		opts.onDebug,
	);
	return resolveArchContextLimits(
		await applyApiGlobalDefaultsIfNeeded(
			models,
			apiRoot,
			apiKey,
			opts.signal,
			timeoutMs,
			opts.onDebug,
		),
	);
}

/**
 * Final context-window resolution, applied after model-specific (prio 1) and
 * global (prio 2) settings. The model's architectural ceiling
 * (`archContextWindow`, from `max_model_len`) is the prio-3 fallback when no
 * user setting exists, and the hard clamp when a user setting exceeds it.
 */
export function resolveArchContextLimits(models: OmlxModel[]): OmlxModel[] {
	return models.map((model) => {
		const arch = model.archContextWindow;
		if (arch == null) return model;
		const next: OmlxModel = { ...model };
		if (next.contextWindow == null) next.contextWindow = arch;
		else if (next.contextWindow > arch) next.contextWindow = arch;
		return next;
	});
}

async function applyApiGlobalDefaultsIfNeeded(
	models: OmlxModel[],
	apiRoot: string,
	apiKey: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	onDebug?: (event: CatalogDebugEvent) => void,
): Promise<OmlxModel[]> {
	if (!models.some((m) => m.contextWindow == null || m.maxTokens == null))
		return models;
	let defaults: OmlxGlobalDefaults | undefined;
	try {
		defaults = await fetchGlobalDefaults(apiRoot, apiKey, signal, timeoutMs);
		onDebug?.({
			kind: "catalog_global_settings_loaded",
			details: { apiRoot, defaults },
		});
	} catch (err) {
		if (signal?.aborted) throw err;
		onDebug?.({
			kind: "catalog_global_settings_failed",
			details: {
				apiRoot,
				error: err instanceof Error ? err.message : String(err),
			},
		});
		return models;
	}
	if (defaults.contextWindow == null && defaults.maxTokens == null)
		return models;
	return models.map((model) => {
		const next: OmlxModel = { ...model };
		if (next.contextWindow == null && defaults.contextWindow != null)
			next.contextWindow = defaults.contextWindow;
		if (next.maxTokens == null && defaults.maxTokens != null)
			next.maxTokens = defaults.maxTokens;
		return next;
	});
}

async function fetchGlobalDefaults(
	apiRoot: string,
	apiKey: string,
	parent: AbortSignal | undefined,
	timeoutMs: number,
): Promise<OmlxGlobalDefaults> {
	const base = apiRoot.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
	const json = (await getJson(
		`${base}/admin/api/global-settings`,
		apiKey,
		parent,
		timeoutMs,
	)) as OmlxGlobalSettingsResponse;
	const sampling = asRecord(json?.sampling);
	return {
		contextWindow:
			typeof sampling?.max_context_window === "number"
				? sampling.max_context_window
				: undefined,
		maxTokens:
			typeof sampling?.max_tokens === "number"
				? sampling.max_tokens
				: undefined,
	};
}

async function getJson(
	url: string,
	apiKey: string,
	parent: AbortSignal | undefined,
	timeoutMs: number,
): Promise<unknown> {
	const signal = withTimeout(parent, timeoutMs);
	// Empty key => keyless server (skip_api_key_verification): omit the header.
	const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
	const res = await fetch(url, {
		headers,
		signal,
	}).catch((err) => {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(`GET ${url} timed out after ${timeoutMs}ms`);
		}
		throw err;
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(
			`GET ${url} -> ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`,
		);
	}
	return res.json();
}

function withTimeout(
	parent: AbortSignal | undefined,
	timeoutMs: number,
): AbortSignal {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	if (parent) {
		if (parent.aborted) ctl.abort();
		else parent.addEventListener("abort", () => ctl.abort(), { once: true });
	}
	ctl.signal.addEventListener("abort", () => clearTimeout(timer), {
		once: true,
	});
	return ctl.signal;
}

export function applyLocalModelSettings(
	models: OmlxModel[],
	apiRoot: string,
	modelSettingsPath = process.env.OMLX_MODEL_SETTINGS_PATH,
	onDebug?: (event: CatalogDebugEvent) => void,
): OmlxModel[] {
	const path = resolveLocalModelSettingsPath(modelSettingsPath);
	onDebug?.({
		kind: "catalog_local_settings_considered",
		details: {
			apiRoot,
			path,
			explicitPath: !!modelSettingsPath,
			exists: path ? existsSync(path) : false,
		},
	});
	if (!path || !existsSync(path)) return models;

	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		onDebug?.({
			kind: "catalog_local_settings_read_failed",
			details: { path },
		});
		return models;
	}

	const byModel = settings.models;
	if (!byModel || typeof byModel !== "object" || Array.isArray(byModel)) {
		onDebug?.({
			kind: "catalog_local_settings_invalid",
			details: { path, reason: "models object missing" },
		});
		return models;
	}

	return models.map((model) => {
		const entry = (byModel as Record<string, unknown>)[model.id];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			if (model.id === "qwen3.6-8b-documenter") {
				onDebug?.({
					kind: "catalog_local_model_settings_missing",
					details: { path, modelId: model.id },
				});
			}
			return model;
		}
		const next = applyModelSettingsEntry(
			model,
			entry as Record<string, unknown>,
		);
		if (
			next.thinkingDefault !== model.thinkingDefault ||
			next.contextWindow !== model.contextWindow ||
			next.maxTokens !== model.maxTokens ||
			next.displayName !== model.displayName ||
			next.description !== model.description ||
			next.modelAlias !== model.modelAlias ||
			next.taskBudgetTokens !== model.taskBudgetTokens ||
			next.maxToolResultTokens !== model.maxToolResultTokens ||
			next.thinkingBudgetTokens !== model.thinkingBudgetTokens ||
			next.thinkingBudgetEnabled !== model.thinkingBudgetEnabled ||
			next.preserveThinking !== model.preserveThinking ||
			JSON.stringify(next.chatTemplateKwargs) !==
				JSON.stringify(model.chatTemplateKwargs) ||
			JSON.stringify(next.forcedCtKwargs) !==
				JSON.stringify(model.forcedCtKwargs) ||
			next.isDefault !== model.isDefault ||
			next.isPinned !== model.isPinned ||
			next.trustRemoteCode !== model.trustRemoteCode ||
			next.ttlSeconds !== model.ttlSeconds ||
			next.indexCacheFreq !== model.indexCacheFreq ||
			next.reasoningParser !== model.reasoningParser ||
			next.activeProfileName !== model.activeProfileName ||
			next.modelType !== model.modelType ||
			JSON.stringify(next.settingsSummary) !==
				JSON.stringify(model.settingsSummary)
		) {
			onDebug?.({
				kind: "catalog_local_model_settings_applied",
				details: {
					path,
					modelId: model.id,
					before: model,
					after: next,
					entrySummary: summarizeModelSettingsEntry(
						entry as Record<string, unknown>,
					),
				},
			});
		}
		return next;
	});
}

function applyModelSettingsEntry(
	model: OmlxModel,
	entry: Record<string, unknown>,
): OmlxModel {
	const next: OmlxModel = { ...model };
	const chatTemplateKwargs = asRecord(entry.chat_template_kwargs);

	if (typeof entry.display_name === "string" && entry.display_name.trim())
		next.displayName = entry.display_name;
	if (typeof entry.description === "string" && entry.description.trim())
		next.description = entry.description;
	if (typeof entry.model_alias === "string" && entry.model_alias.trim())
		next.modelAlias = entry.model_alias;
	if (typeof entry.enable_thinking === "boolean") {
		next.thinkingDefault = entry.enable_thinking;
	}
	if (chatTemplateKwargs) {
		next.chatTemplateKwargs = chatTemplateKwargs;
		const enableThinking = chatTemplateKwargs.enable_thinking;
		if (
			typeof enableThinking === "boolean" &&
			typeof entry.enable_thinking !== "boolean"
		) {
			next.thinkingDefault = enableThinking;
		}
	}
	if (typeof entry.max_context_window === "number")
		next.contextWindow = entry.max_context_window;
	if (typeof entry.max_tokens === "number") next.maxTokens = entry.max_tokens;
	if (typeof entry.task_budget_tokens === "number")
		next.taskBudgetTokens = entry.task_budget_tokens;
	if (typeof entry.max_tool_result_tokens === "number")
		next.maxToolResultTokens = entry.max_tool_result_tokens;
	if (typeof entry.thinking_budget_tokens === "number")
		next.thinkingBudgetTokens = entry.thinking_budget_tokens;
	if (typeof entry.thinking_budget_enabled === "boolean")
		next.thinkingBudgetEnabled = entry.thinking_budget_enabled;
	// preserve_thinking: top branch handles OmlxModelsStatusResponse (server path).
	// Local model_settings.json always places this inside chat_template_kwargs,
	// so the else-if branch is the active path for local files.
	if (typeof entry.preserve_thinking === "boolean") {
		next.preserveThinking = entry.preserve_thinking;
	} else if (typeof chatTemplateKwargs?.preserve_thinking === "boolean") {
		next.preserveThinking = chatTemplateKwargs.preserve_thinking;
	}
	if (Array.isArray(entry.forced_ct_kwargs)) {
		next.forcedCtKwargs = entry.forced_ct_kwargs.filter(
			(item): item is string => typeof item === "string",
		);
	}
	if (typeof entry.is_default === "boolean") next.isDefault = entry.is_default;
	if (typeof entry.is_pinned === "boolean") next.isPinned = entry.is_pinned;
	if (typeof entry.trust_remote_code === "boolean")
		next.trustRemoteCode = entry.trust_remote_code;
	if (typeof entry.ttl_seconds === "number")
		next.ttlSeconds = entry.ttl_seconds;
	if (typeof entry.index_cache_freq === "number")
		next.indexCacheFreq = entry.index_cache_freq;
	if (
		typeof entry.reasoning_parser === "string" &&
		entry.reasoning_parser.trim()
	)
		next.reasoningParser = entry.reasoning_parser;
	if (
		typeof entry.active_profile_name === "string" &&
		entry.active_profile_name.trim()
	)
		next.activeProfileName = entry.active_profile_name;
	if (typeof entry.model_type_override === "string")
		next.modelType = entry.model_type_override.toLowerCase();
	next.settingsSummary = summarizeModelSettingsEntry(entry);
	return next;
}

const CACHE_FILE = join(getAgentDir(), "cache", "omlx-models.json");

interface CachedCatalog {
	apiRoot: string;
	models: OmlxModel[];
	savedAt: number;
}

export function readCatalogCache(apiRoot: string): OmlxModel[] | undefined {
	const data = readCatalogCacheFile();
	if (!data || data.apiRoot !== apiRoot) return undefined;
	return data.models;
}

export function readLastCatalogCache(): OmlxModel[] | undefined {
	return readCatalogCacheFile()?.models;
}

function readCatalogCacheFile(): CachedCatalog | undefined {
	try {
		const raw = readFileSync(CACHE_FILE, "utf-8");
		const data = JSON.parse(raw) as CachedCatalog;
		if (!Array.isArray(data.models)) return undefined;
		return data;
	} catch {
		return undefined;
	}
}

export function writeCatalogCache(apiRoot: string, models: OmlxModel[]): void {
	try {
		mkdirSync(join(getAgentDir(), "cache"), { recursive: true });
		const data: CachedCatalog = { apiRoot, models, savedAt: Date.now() };
		writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
	} catch {
		// Ignore write errors — cache is best-effort
	}
}

export function resolveLocalModelSettingsPath(
	modelSettingsPath: string | undefined,
): string | undefined {
	if (modelSettingsPath) return modelSettingsPath;
	return join(homedir(), ".omlx", "model_settings.json");
}

function summarizeModelSettingsEntry(
	entry: Record<string, unknown>,
): Record<string, unknown> {
	const chatTemplateKwargs = asRecord(entry.chat_template_kwargs);
	return (
		compactObject({
			identity: compactObject({
				displayName: entry.display_name,
				description: entry.description,
				modelAlias: entry.model_alias,
				modelTypeOverride: entry.model_type_override,
			}),
			thinking: compactObject({
				enabled: entry.enable_thinking ?? chatTemplateKwargs?.enable_thinking,
				budgetEnabled: entry.thinking_budget_enabled,
				budgetTokens: entry.thinking_budget_tokens,
				preserve:
					entry.preserve_thinking ?? chatTemplateKwargs?.preserve_thinking,
				reasoningEffort: chatTemplateKwargs?.reasoning_effort,
				parser: entry.reasoning_parser,
				forcedCtKwargs: entry.forced_ct_kwargs,
			}),
			chatTemplate: compactObject({
				kwargs: chatTemplateKwargs,
				forcedKeys: entry.forced_ct_kwargs,
			}),
			limits: compactObject({
				contextWindow: entry.max_context_window,
				maxTokens: entry.max_tokens,
				maxToolResultTokens: entry.max_tool_result_tokens,
			}),
			sampling: compactObject({
				temperature: entry.temperature,
				topP: entry.top_p,
				topK: entry.top_k,
				minP: entry.min_p,
				repetitionPenalty: entry.repetition_penalty,
				presencePenalty: entry.presence_penalty,
				forceSampling: entry.force_sampling,
			}),
			dflash: compactObject({
				enabled: entry.dflash_enabled,
				draftModel: entry.dflash_draft_model,
				draftQuantBits: entry.dflash_draft_quant_bits,
			}),
			specprefill: compactObject({
				enabled: entry.specprefill_enabled,
				draftModel: entry.specprefill_draft_model,
				keepPct: entry.specprefill_keep_pct,
				threshold: entry.specprefill_threshold,
			}),
			turboquant: compactObject({
				enabled: entry.turboquant_kv_enabled,
				bits: entry.turboquant_kv_bits,
				skipLast: entry.turboquant_skip_last,
			}),
			lifecycle: compactObject({
				isDefault: entry.is_default,
				isPinned: entry.is_pinned,
				ttlSeconds: entry.ttl_seconds,
				indexCacheFreq: entry.index_cache_freq,
			}),
			security: compactObject({
				trustRemoteCode: entry.trust_remote_code,
			}),
			profile: compactObject({
				activeProfileName: entry.active_profile_name,
			}),
			bridge: compactObject({
				taskBudgetTokens: entry.task_budget_tokens,
			}),
		}) ?? {}
	);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function compactObject(
	record: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const entries = Object.entries(record).filter(([, value]) => {
		if (value === undefined) return false;
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).length === 0
		)
			return false;
		return true;
	});
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
