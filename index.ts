import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDER_KEY } from "./src/auth-storage.ts";
import { loadDotenvFromExtensionDir } from "./src/dotenv.ts";

loadDotenvFromExtensionDir(import.meta.url);

import {
	fetchModels,
	type OmlxModel,
	readCatalogCache,
	readLastCatalogCache,
	resolveLocalModelSettingsPath,
	writeCatalogCache,
} from "./src/catalog.ts";
import {
	DEFAULT_OMLX_BASE_URL,
	hasOmlxTarget,
	loadConfig,
	type OmlxConfig,
	resolveConfiguredApiKey,
} from "./src/config.ts";
import { toProviderConfig } from "./src/provider.ts";
import { applyOmlxThinkingControls } from "./src/thinking.ts";

const PROVIDER = PROVIDER_KEY;
const EXTENSION_SINGLETON_KEY = Symbol.for("pi-omlx-picker/loaded");

const STARTUP_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 10 * 60 * 1000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

interface State {
	config: OmlxConfig | undefined;
	catalog: OmlxModel[];
	registered: boolean;
	stopped: boolean;
	lastError: string | undefined;
	lastRefreshAt: string | undefined;
	modelSettingsPath: string | undefined;
}

export default function (pi: ExtensionAPI): void {
	const globalState = globalThis as Record<PropertyKey, unknown>;
	if (globalState[EXTENSION_SINGLETON_KEY]) return;
	globalState[EXTENSION_SINGLETON_KEY] = true;

	const state: State = {
		config: undefined,
		catalog: [],
		registered: false,
		stopped: false,
		lastError: undefined,
		lastRefreshAt: undefined,
		modelSettingsPath: undefined,
	};

	registerCachedOrSetupModels(pi, state);
	void startPolling(pi, state).catch((err) => {
		state.lastError = err instanceof Error ? err.message : String(err);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;
		const activeModel = findCatalogModel(state, ctx.model.id);
		return applyOmlxThinkingControls(
			event.payload,
			pi.getThinkingLevel(),
			activeModel?.thinkingDefault,
		);
	});

	pi.on("session_shutdown", () => {
		state.stopped = true;
		delete globalState[EXTENSION_SINGLETON_KEY];
	});
}

async function startPolling(pi: ExtensionAPI, state: State): Promise<void> {
	let backoffMs = BACKOFF_BASE_MS;

	while (!state.stopped) {
		const result = await refreshProvider(pi, state, {
			timeoutMs: STARTUP_TIMEOUT_MS,
		});

		if (result === "registered") {
			backoffMs = BACKOFF_BASE_MS;
			await sleep(POLL_INTERVAL_MS);
		} else {
			registerCachedOrSetupModels(pi, state);
			await sleep(backoffMs);
			backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
		}
	}
}

function tryLoadConfig(): OmlxConfig | undefined {
	try {
		return loadConfig();
	} catch {
		return undefined;
	}
}

function registerModels(
	pi: ExtensionAPI,
	state: State,
	config: OmlxConfig,
	models: OmlxModel[],
	modelSettingsPath?: string,
): void {
	const keyless = !resolveConfiguredApiKey();
	pi.registerProvider(PROVIDER, {
		name: "OMLX",
		...toProviderConfig(
			config.apiRoot,
			config.apiKeyEnvVar,
			models,
			undefined,
			{
				keyless,
			},
		),
	});
	state.config = config;
	state.catalog = models;
	state.registered = true;
	state.lastError = undefined;
	state.lastRefreshAt = new Date().toISOString();
	state.modelSettingsPath = modelSettingsPath;
}

function isRegistrableModel(model: OmlxModel): boolean {
	return (
		typeof model.contextWindow === "number" &&
		model.contextWindow > 0 &&
		typeof model.maxTokens === "number" &&
		model.maxTokens > 0
	);
}

function registrableCachedModels(
	models: OmlxModel[] | undefined,
): OmlxModel[] | undefined {
	const registrable = models?.filter(isRegistrableModel) ?? [];
	return registrable.length > 0 ? registrable : undefined;
}

function missingLimitModelIds(models: OmlxModel[]): string[] {
	return models.filter((model) => !isRegistrableModel(model)).map((m) => m.id);
}

function registerCachedOrSetupModels(pi: ExtensionAPI, state: State): void {
	const config = tryLoadConfig() ?? {
		apiRoot: DEFAULT_OMLX_BASE_URL,
		apiKeyEnvVar: "OMLX_API_KEY",
	};
	const configured = resolveConfiguredApiKey() || hasOmlxTarget();
	const cached = registrableCachedModels(readCatalogCache(config.apiRoot));
	const fallbackCached = configured
		? undefined
		: registrableCachedModels(readLastCatalogCache());
	const models = cached ?? fallbackCached;
	if (!models) {
		state.config = config;
		state.catalog = [];
		state.registered = false;
		state.lastError = configured
			? "No cached OMLX models with real max_context_window/max_tokens; waiting for live catalog refresh."
			: "OMLX credentials are not set. Run /login and choose OMLX.";
		state.lastRefreshAt = new Date().toISOString();
		state.modelSettingsPath = undefined;
		return;
	}

	// A key OR a configured base URL (keyless server) is enough to register the
	// real provider. Pi omits the auth header when the resolved key is empty.
	if (configured) {
		registerModels(pi, state, config, models);
		return;
	}

	pi.registerProvider(PROVIDER, {
		...toProviderConfig(config.apiRoot, config.apiKeyEnvVar, models),
		name: "OMLX",
		authHeader: false,
		streamSimple: streamMissingCredentials,
	});
	state.config = config;
	state.catalog = models;
	state.registered = true;
	state.lastError = "OMLX credentials are not set. Run /login and choose OMLX.";
	state.lastRefreshAt = new Date().toISOString();
	state.modelSettingsPath = undefined;
}

function streamMissingCredentials(model: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage:
			"OMLX credentials are not configured. Run /login, choose API key, select OMLX, then try the model again.",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
		stream.end();
	});
	return stream;
}

type RefreshResult = "registered" | "not_configured" | "failed";

async function refreshProvider(
	pi: ExtensionAPI,
	state: State,
	opts: { timeoutMs?: number } = {},
): Promise<RefreshResult> {
	const config = loadConfig();
	const apiKey = resolveConfiguredApiKey();
	if (!apiKey && !hasOmlxTarget()) {
		state.lastError = "OMLX credentials are not set";
		return "not_configured";
	}

	const modelSettingsPath = resolveLocalModelSettingsPath(
		process.env.OMLX_MODEL_SETTINGS_PATH,
	);

	let models: OmlxModel[];
	try {
		models = await fetchModels(config.apiRoot, apiKey ?? "", {
			modelSettingsPath,
			timeoutMs: opts.timeoutMs,
		});
	} catch (err) {
		state.lastError = err instanceof Error ? err.message : String(err);
		return "failed";
	}

	const missingLimitIds = missingLimitModelIds(models);
	const registrable = models.filter(isRegistrableModel);

	if (registrable.length === 0) {
		state.lastError =
			missingLimitIds.length > 0
				? `No OMLX models have max_context_window and max_tokens (${missingLimitIds.length} models missing limits)`
				: "OMLX returned 0 models";
		return "failed";
	}

	writeCatalogCache(config.apiRoot, registrable);
	registerModels(pi, state, config, registrable, modelSettingsPath);
	return "registered";
}

function findCatalogModel(
	state: State,
	id: string | undefined,
): OmlxModel | undefined {
	return id ? state.catalog.find((model) => model.id === id) : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
