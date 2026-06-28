import type {
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { OmlxModel } from "./catalog.ts";
import { FREE_COST } from "./pricing.ts";
import {
	resolveFirstDeltaTimeoutMs,
	type StreamTimeoutEvent,
	streamOmlxOpenAICompletions,
} from "./stream.ts";
import { thinkingFormatFor } from "./thinking-format.ts";

const BASE_COMPAT = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsLongCacheRetention: true,
	maxTokensField: "max_tokens",
} as const;

export function toProviderConfig(
	apiRoot: string,
	apiKeyEnvVar: string,
	models: OmlxModel[],
	onStreamTimeout?: (event: StreamTimeoutEvent) => void,
	options: { keyless?: boolean } = {},
): ProviderConfig {
	const config: ProviderConfig = {
		baseUrl: apiRoot,
		api: "openai-completions",
		// Keyless server (skip_api_key_verification): no auth header. Pi rejects
		// authHeader:true with no key, and resolveConfigValueOrThrow would throw
		// on an unset $OMLX_API_KEY — so both apiKey and authHeader stay off.
		authHeader: !options.keyless,
		streamSimple: (model, context, streamOptions) =>
			streamOmlxOpenAICompletions(
				model,
				context,
				streamOptions,
				resolveFirstDeltaTimeoutMs(),
				onStreamTimeout,
			),
		models: models.map(toProviderModel),
	};
	if (!options.keyless) config.apiKey = `$${apiKeyEnvVar}`;
	return config;
}

function requirePositive(
	value: number | undefined,
	modelId: string,
	field: string,
): number {
	if (typeof value === "number" && value > 0) return value;
	throw new Error(
		`OMLX model "${modelId}" did not report ${field}; cannot register it without a real value.`,
	);
}

function toProviderModel(m: OmlxModel): ProviderModelConfig {
	const reasoning = m.thinkingDefault === true;
	return {
		id: m.id,
		name: m.displayName ?? m.id,
		reasoning,
		input: m.modelType === "vlm" ? ["text", "image"] : ["text"],
		cost: { ...FREE_COST },
		contextWindow: requirePositive(m.contextWindow, m.id, "max_context_window"),
		maxTokens: requirePositive(m.maxTokens, m.id, "max_tokens"),
		compat: reasoning
			? { ...BASE_COMPAT, thinkingFormat: thinkingFormatFor(m.reasoningParser) }
			: { ...BASE_COMPAT },
	};
}
