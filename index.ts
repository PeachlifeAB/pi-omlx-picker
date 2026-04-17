import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { fetchModels, type OmlxModel } from "./src/catalog.ts";
import { loadConfig, MissingEnvError, type OmlxConfig } from "./src/config.ts";
import { buildLabels } from "./src/labels.ts";
import { toProviderConfig } from "./src/provider.ts";

const PROVIDER = "omlx";
const STATUS_KEY = "omlx";

interface State {
	config: OmlxConfig | undefined;
	catalog: OmlxModel[];
	registered: boolean;
	lastError: string | undefined;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const state: State = { config: undefined, catalog: [], registered: false, lastError: undefined };

	await initialRegister(pi, state);

	pi.registerCommand("omlx", {
		description: "Pick an OMLX model",
		handler: async (_args, ctx) => {
			await handlePick(pi, ctx, state);
		},
	});

	pi.registerCommand("omlx-refresh", {
		description: "Refresh the OMLX model list",
		handler: async (_args, ctx) => {
			await refresh(pi, ctx, state, { silent: false });
		},
	});
}

async function initialRegister(pi: ExtensionAPI, state: State): Promise<void> {
	let config: OmlxConfig;
	try {
		config = loadConfig();
	} catch (err) {
		if (err instanceof MissingEnvError) {
			console.error(`[pi-omlx-picker] ${err.varName} is not set — provider 'omlx' not registered.`);
			return;
		}
		throw err;
	}
	state.config = config;

	let models: OmlxModel[];
	try {
		models = await fetchModels(config.apiRoot, process.env.OMLX_API_KEY!);
	} catch (err) {
		state.lastError = err instanceof Error ? err.message : String(err);
		console.error(`[pi-omlx-picker] unable to reach ${config.apiRoot}/models: ${state.lastError}`);
		console.error(`[pi-omlx-picker] provider 'omlx' not registered. Run /omlx-refresh once the server is reachable.`);
		return;
	}

	if (models.length === 0) {
		console.error(`[pi-omlx-picker] OMLX returned 0 models — provider 'omlx' not registered.`);
		return;
	}

	state.catalog = models;
	pi.registerProvider(PROVIDER, toProviderConfig(config.apiRoot, config.apiKeyEnvVar, models));
	state.registered = true;
}

async function refresh(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: State,
	opts: { silent: boolean },
): Promise<void> {
	let config: OmlxConfig;
	try {
		config = loadConfig();
	} catch (err) {
		if (err instanceof MissingEnvError) {
			const msg = `omlx: set ${err.varName}`;
			ctx.ui.setStatus(STATUS_KEY, msg);
			if (!opts.silent) ctx.ui.notify(msg, "error");
			if (state.registered) {
				pi.unregisterProvider(PROVIDER);
				state.registered = false;
			}
			state.config = undefined;
			return;
		}
		throw err;
	}
	state.config = config;

	let models: OmlxModel[];
	try {
		models = await fetchModels(config.apiRoot, process.env.OMLX_API_KEY!);
	} catch (err) {
		state.lastError = err instanceof Error ? err.message : String(err);
		const keepCount = state.catalog.length;
		const msg = keepCount > 0
			? `omlx: unreachable (keeping last ${keepCount})`
			: "omlx: unreachable";
		ctx.ui.setStatus(STATUS_KEY, msg);
		if (!opts.silent) ctx.ui.notify(`${msg} — ${state.lastError}`, "error");
		return;
	}

	state.catalog = models;
	state.lastError = undefined;

	if (models.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, "omlx: 0 models, unregistered");
		if (state.registered) {
			pi.unregisterProvider(PROVIDER);
			state.registered = false;
		}
		if (!opts.silent) ctx.ui.notify("omlx: no models returned", "warning");
		return;
	}

	pi.registerProvider(PROVIDER, toProviderConfig(config.apiRoot, config.apiKeyEnvVar, models));
	state.registered = true;

	const msg = `omlx: ${models.length} model${models.length === 1 ? "" : "s"}`;
	ctx.ui.setStatus(STATUS_KEY, msg);
	if (!opts.silent) ctx.ui.notify(msg, "info");
}

async function handlePick(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: State): Promise<void> {
	if (!state.registered || state.catalog.length === 0) {
		await refresh(pi, ctx, state, { silent: true });
	}
	if (!state.registered || state.catalog.length === 0) {
		ctx.ui.notify("omlx: no catalog available", "error");
		return;
	}

	const activeId = ctx.model?.provider === PROVIDER ? ctx.model.id : undefined;
	const labelled = buildLabels(state.catalog, activeId);
	const choice = await ctx.ui.select("Pick OMLX model", labelled.map((l) => l.label));
	if (!choice) return;

	const picked = labelled.find((l) => l.label === choice);
	if (!picked) {
		ctx.ui.notify(`omlx: could not resolve selection`, "error");
		return;
	}
	if (picked.id === activeId) return;

	const model = ctx.modelRegistry.find(PROVIDER, picked.id);
	if (!model) {
		ctx.ui.notify(`omlx: model ${picked.id} not in registry`, "error");
		return;
	}

	if (!ctx.isIdle()) {
		ctx.ui.setStatus(STATUS_KEY, `omlx: queued → ${picked.id}`);
		ctx.ui.notify(`omlx: queued switch to ${picked.id}`, "info");
		await ctx.waitForIdle();
	}

	const ok = await pi.setModel(model);
	if (!ok) {
		ctx.ui.notify(`omlx: failed to switch to ${picked.id} (no API key?)`, "error");
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, `omlx: ${state.catalog.length} models`);
	ctx.ui.notify(`omlx: now using ${picked.id}`, "info");
}
