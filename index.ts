import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { fetchModels, resolveLocalModelSettingsPath, type OmlxModel } from "./src/catalog.ts";
import { loadConfig, MissingEnvError, type OmlxConfig } from "./src/config.ts";
import { toProviderConfig } from "./src/provider.ts";
import { applyOmlxThinkingControls } from "./src/thinking.ts";

const PROVIDER = "omlx";
const EXTENSION_SINGLETON_KEY = Symbol.for("pi-omlx-picker/loaded");

interface State {
	config: OmlxConfig | undefined;
	catalog: OmlxModel[];
	registered: boolean;
	lastError: string | undefined;
	lastRefreshAt: string | undefined;
	modelSettingsPath: string | undefined;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const globalState = globalThis as Record<PropertyKey, unknown>;
	if (globalState[EXTENSION_SINGLETON_KEY]) return;
	globalState[EXTENSION_SINGLETON_KEY] = true;

	const state: State = {
		config: undefined,
		catalog: [],
		registered: false,
		lastError: undefined,
		lastRefreshAt: undefined,
		modelSettingsPath: undefined,
	};

	await refreshProvider(pi, state);

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;
		const activeModel = findCatalogModel(state, ctx.model.id);
		return applyOmlxThinkingControls(event.payload, pi.getThinkingLevel(), activeModel?.thinkingDefault);
	});
}

function clearRegisteredProvider(pi: ExtensionAPI, state: State): void {
	if (state.registered) {
		pi.unregisterProvider(PROVIDER);
	}
	state.catalog = [];
	state.registered = false;
	state.config = undefined;
	state.modelSettingsPath = undefined;
}

async function refreshProvider(pi: ExtensionAPI, state: State): Promise<void> {
	let config: OmlxConfig;
	try {
		config = loadConfig();
	} catch (err) {
		state.lastError =
			err instanceof MissingEnvError
				? `${err.varName} is not set`
				: err instanceof Error
					? err.message
					: String(err);
		clearRegisteredProvider(pi, state);
		return;
	}

	const modelSettingsPath = resolveLocalModelSettingsPath(process.env.OMLX_MODEL_SETTINGS_PATH);

	let models: OmlxModel[];
	try {
		models = await fetchModels(config.apiRoot, process.env.OMLX_API_KEY!, { modelSettingsPath });
	} catch (err) {
		state.lastError = err instanceof Error ? err.message : String(err);
		return;
	}

	if (models.length === 0) {
		state.lastError = "OMLX returned 0 models";
		clearRegisteredProvider(pi, state);
		return;
	}

	pi.registerProvider(PROVIDER, toProviderConfig(config.apiRoot, config.apiKeyEnvVar, models));
	state.config = config;
	state.catalog = models;
	state.registered = true;
	state.lastError = undefined;
	state.lastRefreshAt = new Date().toISOString();
	state.modelSettingsPath = modelSettingsPath;
}

function findCatalogModel(state: State, id: string | undefined): OmlxModel | undefined {
	return id ? state.catalog.find((model) => model.id === id) : undefined;
}
