import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	streamSimpleOpenAICompletions,
} from "@mariozechner/pi-ai";
import type {
	ProviderConfig,
	ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";
import type { OmlxModel } from "./catalog.ts";

// Pi's documented defaults when the server doesn't report per-model values.
// Users can override these via modelOverrides in ~/.pi/config.json.
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_FIRST_DELTA_TIMEOUT_MS = 120_000;
const FIRST_DELTA_MAX_ATTEMPTS = 2;
type StreamTimeoutEvent = {
	model: string;
	timeoutMs: number;
	attempt: number;
	maxAttempts: number;
	final: boolean;
};

export function toProviderConfig(
	apiRoot: string,
	apiKeyEnvVar: string,
	models: OmlxModel[],
	onStreamTimeout?: (event: StreamTimeoutEvent) => void,
): ProviderConfig {
	return {
		baseUrl: apiRoot,
		apiKey: apiKeyEnvVar,
		api: "openai-completions",
		authHeader: true,
		streamSimple: (model, context, options) =>
			streamOmlxOpenAICompletions(
				model,
				context,
				options,
				resolveFirstDeltaTimeoutMs(),
				onStreamTimeout,
			),
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

function streamOmlxOpenAICompletions(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	firstDeltaTimeoutMs: number,
	onStreamTimeout: ((event: StreamTimeoutEvent) => void) | undefined,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	let closed = false;
	let startEvent: AssistantMessageEvent | undefined;
	let startPushed = false;

	const pushWithStart = (event: AssistantMessageEvent) => {
		if (!startPushed) {
			stream.push(
				startEvent ?? { type: "start", partial: eventPartial(event, model) },
			);
			startPushed = true;
		}
		stream.push(event);
	};

	(async () => {
		try {
			for (let attempt = 1; attempt <= FIRST_DELTA_MAX_ATTEMPTS; attempt++) {
				const controller = new AbortController();
				const signal = mergeAbortSignals(options?.signal, controller.signal);
				let attemptTimedOut = false;
				let firstMeaningfulEvent = false;
				const timeout = setTimeout(() => {
					if (closed || firstMeaningfulEvent) return;
					attemptTimedOut = true;
					onStreamTimeout?.({
						model: model.id,
						timeoutMs: firstDeltaTimeoutMs,
						attempt,
						maxAttempts: FIRST_DELTA_MAX_ATTEMPTS,
						final: attempt >= FIRST_DELTA_MAX_ATTEMPTS,
					});
					controller.abort();
				}, firstDeltaTimeoutMs);

				const inner = streamSimpleOpenAICompletions(
					model as Model<"openai-completions">,
					context,
					{
						...options,
						signal,
					},
				);
				for await (const event of inner) {
					if (closed || attemptTimedOut) break;
					if (event.type === "start") {
						startEvent ??= event;
						continue;
					}
					if (isMeaningfulBodyEvent(event)) {
						firstMeaningfulEvent = true;
						clearTimeout(timeout);
					}
					if (event.type === "done" || event.type === "error") {
						closed = true;
						clearTimeout(timeout);
					}
					pushWithStart(event);
				}
				clearTimeout(timeout);
				if (closed) return;
				if (!attemptTimedOut) {
					closed = true;
					stream.end();
					return;
				}
				if (attempt < FIRST_DELTA_MAX_ATTEMPTS) continue;
				closed = true;
				pushWithStart({
					type: "error",
					reason: "error",
					error: errorAssistantMessage(
						model,
						`OMLX stream timed out: no text, thinking, or tool delta arrived within ${firstDeltaTimeoutMs}ms after response headers on ${FIRST_DELTA_MAX_ATTEMPTS} attempts.`,
					),
				});
				stream.end();
				return;
			}
		} catch (error) {
			if (closed) return;
			closed = true;
			pushWithStart({
				type: "error",
				reason: options?.signal?.aborted ? "aborted" : "error",
				error: errorAssistantMessage(
					model,
					error instanceof Error ? error.message : String(error),
					options?.signal?.aborted ? "aborted" : "error",
				),
			});
			stream.end();
		}
	})();

	return stream;
}

function isMeaningfulBodyEvent(event: AssistantMessageEvent): boolean {
	return [
		"text_start",
		"text_delta",
		"thinking_start",
		"thinking_delta",
		"toolcall_start",
		"toolcall_delta",
		"done",
		"error",
	].includes(event.type);
}

function mergeAbortSignals(
	parent: AbortSignal | undefined,
	child: AbortSignal,
): AbortSignal {
	if (!parent) return child;
	if (parent.aborted) return parent;
	const controller = new AbortController();
	const abort = () => controller.abort();
	parent.addEventListener("abort", abort, { once: true });
	child.addEventListener("abort", abort, { once: true });
	return controller.signal;
}

function eventPartial(
	event: AssistantMessageEvent,
	model: Model<Api>,
): AssistantMessage {
	if ("partial" in event) return event.partial;
	if ("message" in event) return event.message;
	if ("error" in event) return event.error;
	return errorAssistantMessage(
		model,
		"OMLX stream started without a start event",
	);
}

function errorAssistantMessage(
	model: Model<Api>,
	errorMessage: string,
	stopReason: "error" | "aborted" = "error",
): AssistantMessage {
	return {
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
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function resolveFirstDeltaTimeoutMs(): number {
	const raw = process.env.OMLX_STREAM_FIRST_DELTA_TIMEOUT_MS;
	if (!raw) return DEFAULT_FIRST_DELTA_TIMEOUT_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0
		? value
		: DEFAULT_FIRST_DELTA_TIMEOUT_MS;
}
