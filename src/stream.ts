import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
// Resolve the concrete OpenAI Completions stream once, via the lazy API factory
// re-exported from compat. Calling the compat `streamSimple` dispatcher from
// inside this wrapper would re-resolve through the api-provider registry; and
// because this extension registers itself as the openai-completions handler,
// that routes dispatch -> wrapper -> dispatch -> ... and overflows the stack.
// The lazy factory returns a closure over the concrete implementation that
// loads the module on first call and calls it directly — no registry, no
// re-dispatch. It is captured here at module load, BEFORE the wrapper is
// registered, so it can never be the wrapper itself.
//
// Note: pi's extension loader (jiti) only aliases a fixed set of pi-ai
// subpaths (root, /compat, /oauth). Importing `@earendil-works/pi-ai/api/...`
// is not resolvable there, so the concrete module is reached through compat.
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { PROVIDER_KEY } from "./auth-storage.ts";
import { pickerDebug } from "./debug.ts";
import { normalizeErrorEvent, normalizeOverflowMessage } from "./overflow.ts";
import { isRepeatStop } from "./repeat-stop.ts";
import { isMeaningfulBodyEvent, isThinkingEvent } from "./stream-events.ts";
import { StreamWriter } from "./stream-writer.ts";

const streamOpenAICompletionsImpl = openAICompletionsApi().streamSimple;

const DEFAULT_FIRST_DELTA_TIMEOUT_MS = 120_000;
const FIRST_DELTA_MAX_ATTEMPTS = 2;
const MAX_REISSUES = 1;

export type StreamTimeoutEvent = {
	model: string;
	timeoutMs: number;
	attempt: number;
	maxAttempts: number;
	final: boolean;
};

type OnStreamTimeout = (event: StreamTimeoutEvent) => void;

type AttemptResult = "completed" | "reissue" | "timed-out";

function firstDeltaTimeoutMessage(timeoutMs: number, attempts: number): string {
	return `OMLX stream timed out: no text, thinking, or tool delta arrived within ${timeoutMs}ms after response headers on ${attempts} attempts.`;
}

export function resolveFirstDeltaTimeoutMs(): number {
	const raw = process.env.OMLX_STREAM_FIRST_DELTA_TIMEOUT_MS;
	if (!raw) return DEFAULT_FIRST_DELTA_TIMEOUT_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0
		? value
		: DEFAULT_FIRST_DELTA_TIMEOUT_MS;
}

// Merge the parent (caller) signal with our own timeout signal. We compose the
// raw source signals directly via AbortSignal.any rather than chaining through
// a freshly-created controller per call: chaining previously-merged signals
// accumulates abort listeners across a long session and, when abort fires,
// propagates through N recursive .abort() calls that overflow the stack.
// AbortSignal.any keeps the merged signal detached from either source's
// listener set, and returns an already-aborted signal if either input is
// aborted (so a pre-aborted parent propagates immediately). Node >=22
// guarantees AbortSignal.any is available (engines).
function mergeTimeoutSignal(
	parent: AbortSignal | undefined,
	own: AbortSignal,
): AbortSignal {
	if (!parent) return own;
	return AbortSignal.any([parent, own]) as AbortSignal;
}

// Always flush buffered thinking events before leaving runAttempt, including
// the timed-out and thrown paths. Previously these were dropped silently.
function flushThinking(
	writer: StreamWriter,
	events: AssistantMessageEvent[],
): void {
	for (const held of events) writer.push(held);
}

async function runAttempt(
	writer: StreamWriter,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	firstDeltaTimeoutMs: number,
	attempt: number,
	onTimeout: OnStreamTimeout | undefined,
	allowReissue: boolean,
): Promise<AttemptResult> {
	const controller = new AbortController();
	const signal = mergeTimeoutSignal(options?.signal, controller.signal);
	let timedOut = false;
	let firstMeaningfulEvent = false;

	const timer = setTimeout(() => {
		// clearTimeout below does not stop a callback already queued on the
		// event loop; firstMeaningfulEvent is a load-bearing guard against the
		// timer firing just after the first body event cleared it.
		if (writer.closed || firstMeaningfulEvent) return;
		timedOut = true;
		onTimeout?.({
			model: model.id,
			timeoutMs: firstDeltaTimeoutMs,
			attempt,
			maxAttempts: FIRST_DELTA_MAX_ATTEMPTS,
			final: attempt >= FIRST_DELTA_MAX_ATTEMPTS,
		});
		controller.abort();
	}, firstDeltaTimeoutMs);

	let bufferedThinking: AssistantMessageEvent[] = [];

	try {
		// Direct call into the concrete implementation: no dispatch, so a model
		// whose provider registered this wrapper cannot recurse back into it.
		const inner = streamOpenAICompletionsImpl(
			model as Model<"openai-completions">,
			context,
			{ ...options, signal },
		);
		for await (const event of inner) {
			if (writer.closed || timedOut) break;
			if (event.type === "start") {
				writer.rememberStart(event);
				continue;
			}
			if (isMeaningfulBodyEvent(event)) {
				firstMeaningfulEvent = true;
				clearTimeout(timer);
			}
			if (isThinkingEvent(event)) {
				bufferedThinking.push(event);
				continue;
			}
			if (allowReissue && isRepeatStop(event, context)) {
				// Tear down the inner stream's network connection immediately so it
				// does not drain unpredictably while the caller reissues.
				controller.abort();
				bufferedThinking = [];
				return "reissue";
			}
			flushThinking(writer, bufferedThinking);
			bufferedThinking = [];
			if (event.type === "error") {
				const rawErrorMessage = event.error?.errorMessage;
				const normalized = normalizeErrorEvent(event);
				pickerDebug("stream_error_normalized", {
					model: model.id,
					rawErrorMessage,
					normalizedErrorMessage:
						normalized.type === "error"
							? normalized.error?.errorMessage
							: undefined,
					changed: normalized !== event,
				});
				writer.push(normalized);
			} else {
				writer.push(normalizeErrorEvent(event));
			}
			if (event.type === "done" || event.type === "error") break;
		}
	} catch (err) {
		flushThinking(writer, bufferedThinking);
		if (timedOut) return "timed-out";
		throw err;
	} finally {
		clearTimeout(timer);
	}

	flushThinking(writer, bufferedThinking);

	return timedOut ? "timed-out" : "completed";
}

export function streamOmlxOpenAICompletions(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	firstDeltaTimeoutMs: number,
	onTimeout: OnStreamTimeout | undefined,
): AssistantMessageEventStream {
	// Pi dispatches stream handlers by api id, not provider. Registering this
	// wrapper as the openai-completions streamSimple handler (the mechanism pi
	// exposes) replaces the shared entry, so non-oMLX OpenAI-compatible models
	// (groq, zai, glm, ...) also arrive here. Pass them straight through to the
	// concrete implementation with no oMLX-specific timeout/reissue logic, so the
	// extension cannot perturb unrelated providers.
	pickerDebug("stream_simple_entered", {
		provider: model.provider,
		model: model.id,
		isOmlx: model.provider === PROVIDER_KEY,
		contextMessages: context.messages.length,
	});
	if (model.provider !== PROVIDER_KEY) {
		pickerDebug("stream_simple_bypassed", {
			provider: model.provider,
			model: model.id,
		});
		return streamOpenAICompletionsImpl(
			model as Model<"openai-completions">,
			context,
			options,
		);
	}

	const stream = createAssistantMessageEventStream();
	const writer = new StreamWriter(stream, model);

	(async () => {
		try {
			// Separate budgets so a reissue never consumes a timeout attempt and
			// the loop index is never mutated: timeoutAttemptsLeft governs how
			// many timed-out retries remain, reissueLeft governs reissues.
			let timeoutAttemptsLeft = FIRST_DELTA_MAX_ATTEMPTS;
			let reissueLeft = MAX_REISSUES;
			while (true) {
				const attempt = FIRST_DELTA_MAX_ATTEMPTS - timeoutAttemptsLeft + 1;
				const result = await runAttempt(
					writer,
					model,
					context,
					options,
					firstDeltaTimeoutMs,
					attempt,
					onTimeout,
					reissueLeft > 0,
				);
				if (writer.closed) return;

				if (result === "reissue") {
					reissueLeft--;
					continue;
				}
				if (result === "completed") {
					writer.end();
					return;
				}

				// timed-out
				timeoutAttemptsLeft--;
				if (timeoutAttemptsLeft <= 0) {
					writer.pushError(
						firstDeltaTimeoutMessage(
							firstDeltaTimeoutMs,
							FIRST_DELTA_MAX_ATTEMPTS,
						),
					);
					writer.end();
					return;
				}
			}
		} catch (error) {
			if (writer.closed) return;
			const rawErrorMessage =
				error instanceof Error ? error.message : String(error);
			const normalizedErrorMessage = normalizeOverflowMessage(rawErrorMessage);
			const aborted = options?.signal?.aborted === true;
			pickerDebug("stream_throw_normalized", {
				model: model.id,
				rawErrorMessage,
				normalizedErrorMessage,
				changed: rawErrorMessage !== normalizedErrorMessage,
				aborted,
			});
			writer.pushError(normalizedErrorMessage, aborted ? "aborted" : "error");
			writer.end();
		}
	})();

	return stream;
}
