import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamSimpleOpenAICompletions } from "@earendil-works/pi-ai/compat";
import { normalizeErrorEvent } from "./overflow.ts";
import { isRepeatStop } from "./repeat-stop.ts";
import {
	isMeaningfulBodyEvent,
	isThinkingEvent,
	mergeAbortSignals,
} from "./stream-events.ts";
import { StreamWriter } from "./stream-writer.ts";

const DEFAULT_FIRST_DELTA_TIMEOUT_MS = 120_000;
const FIRST_DELTA_MAX_ATTEMPTS = 2;

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
	const signal = mergeAbortSignals(options?.signal, controller.signal);
	let timedOut = false;
	let firstMeaningfulEvent = false;

	const timer = setTimeout(() => {
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
		const inner = streamSimpleOpenAICompletions(
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
				bufferedThinking = [];
				return "reissue";
			}
			for (const held of bufferedThinking) writer.push(held);
			bufferedThinking = [];
			writer.push(normalizeErrorEvent(event));
			if (event.type === "done" || event.type === "error") break;
		}
	} catch (err) {
		if (timedOut) return "timed-out";
		throw err;
	} finally {
		clearTimeout(timer);
	}

	if (!timedOut) {
		for (const held of bufferedThinking) writer.push(held);
	}

	return timedOut ? "timed-out" : "completed";
}

export function streamOmlxOpenAICompletions(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	firstDeltaTimeoutMs: number,
	onTimeout: OnStreamTimeout | undefined,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const writer = new StreamWriter(stream, model);

	(async () => {
		try {
			let reissued = false;
			for (let attempt = 1; attempt <= FIRST_DELTA_MAX_ATTEMPTS; attempt++) {
				const result = await runAttempt(
					writer,
					model,
					context,
					options,
					firstDeltaTimeoutMs,
					attempt,
					onTimeout,
					!reissued,
				);
				if (writer.closed) return;

				if (result === "reissue") {
					reissued = true;
					attempt--; // a re-issue doesn't consume a timeout attempt
					continue;
				}
				if (result === "completed") {
					writer.end();
					return;
				}
				if (attempt >= FIRST_DELTA_MAX_ATTEMPTS) {
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
			const aborted = options?.signal?.aborted === true;
			writer.pushError(
				error instanceof Error ? error.message : String(error),
				aborted ? "aborted" : "error",
			);
			writer.end();
		}
	})();

	return stream;
}
