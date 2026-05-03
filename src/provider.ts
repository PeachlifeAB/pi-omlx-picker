import type {
	ProviderConfig,
	ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";
import type { OmlxModel } from "./catalog.ts";

// Pi's documented defaults when the server doesn't report per-model values.
// Users can override these via modelOverrides in ~/.pi/config.json.
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

export function toProviderConfig(
	apiRoot: string,
	apiKeyEnvVar: string,
	models: OmlxModel[],
): ProviderConfig {
	return {
		baseUrl: apiRoot,
		apiKey: apiKeyEnvVar,
		api: "openai-completions",
		authHeader: true,
		models: models.map(toProviderModel),
	};
}

function toProviderModel(m: OmlxModel): ProviderModelConfig {
	const input: ("text" | "image")[] =
		m.modelType === "vlm" ? ["text", "image"] : ["text"];
	const reasoning = m.thinkingDefault === true;
	const compat = {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens" as const,
		...(reasoning ? { thinkingFormat: "qwen-chat-template" as const } : {}),
	};
	return {
		id: m.id,
		name: m.displayName ?? m.id,
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
		compat,
	};
}
