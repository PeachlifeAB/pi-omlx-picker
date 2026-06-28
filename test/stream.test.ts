import { strict as assert } from "node:assert";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { test, vi } from "vitest";

// Inject a controlled inner stream so runAttempt/streamOmlxOpenAICompletions
// can be exercised deterministically without a real OpenAI client. The wrapper
// imports the concrete implementation module by specifier, so the mock must
// target that exact module — which is also how we assert the P0 recursion fix
// (the wrapper must call the concrete impl, not the compat dispatcher).
const innerStreamModule = vi.hoisted(() => {
	let lastArgs:
		| {
				model: Model<"openai-completions">;
				context: Context;
				options: SimpleStreamOptions | undefined;
		  }
		| undefined;
	// Each queued value is a FACTORY so a fresh event iterable is built on every
	// streamSimple call (mirrors the real impl, which the wrapper may invoke
	// repeatedly across reissue/timeout attempts).
	let factory: () => AsyncIterable<AssistantMessageEvent> = () =>
		arrayIterator([]);
	return {
		lastArgs: () => lastArgs,
		queue(events: AssistantMessageEvent[]): void {
			factory = () => arrayIterator(events);
		},
		queueFactory(fn: () => AsyncIterable<AssistantMessageEvent>): void {
			factory = fn;
		},
		streamSimple(
			model: Model<"openai-completions">,
			context: Context,
			options: SimpleStreamOptions | undefined,
		): AssistantMessageEventStream {
			lastArgs = { model, context, options };
			return makeMockStream(factory(), options?.signal);
		},
	};
});

vi.mock("@earendil-works/pi-ai/compat", () => ({
	openAICompletionsApi: () => ({
		streamSimple: innerStreamModule.streamSimple,
	}),
}));

import { PROVIDER_KEY } from "../src/auth-storage.ts";
import { streamOmlxOpenAICompletions } from "../src/stream.ts";

async function* arrayIterator<T>(items: T[]): AsyncIterable<T> {
	for (const item of items) yield item;
}

// Mimic a real network stream: yield the supplied events, then — if a signal is
// present — block waiting for more data until the signal aborts, at which point
// throw an abort error (as the OpenAI SDK does when fetch is aborted). This is
// load-bearing: timeout/reissue tests rely on the stream NOT self-completing,
// so the wrapper's timer/controller is what terminates it.
function makeMockStream(
	source: AsyncIterable<AssistantMessageEvent>,
	signal: AbortSignal | undefined,
): AssistantMessageEventStream {
	const srcIter = source[Symbol.asyncIterator]();
	const stream = {
		push(): void {},
		end(): void {},
		result(): Promise<AssistantMessage> {
			return Promise.resolve({} as AssistantMessage);
		},
		async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
			// A real fetch rejects immediately when handed an already-aborted signal;
			// mirror that so pre-aborted parent signals surface as errors, not as a
			// silently completed stream.
			if (signal?.aborted) throw new Error("aborted");
			while (true) {
				const { value, done } = await srcIter.next();
				if (done) break;
				yield value;
			}
			// Source events exhausted: stand in for an idle network connection.
			if (signal) await waitForAbort(signal);
			else await new Promise<void>(() => {});
		},
	};
	return stream as unknown as AssistantMessageEventStream;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) return reject(new Error("aborted"));
		signal.addEventListener("abort", () => reject(new Error("aborted")), {
			once: true,
		});
	});
}

const OMLX_MODEL: Model<"openai-completions"> = {
	id: "qwen-test",
	name: "Qwen Test",
	api: "openai-completions",
	provider: PROVIDER_KEY,
	baseUrl: "http://127.0.0.1:8000/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 8192,
};

const NON_OMLX_MODEL: Model<"openai-completions"> = {
	...OMLX_MODEL,
	provider: "zai",
};

const EMPTY_CONTEXT: Context = { messages: [] };

function startEvent(partial: AssistantMessage): AssistantMessageEvent {
	return { type: "start", partial };
}

function textDelta(
	partial: AssistantMessage,
	delta: string,
): AssistantMessageEvent {
	return { type: "text_delta", contentIndex: 0, delta, partial };
}

function thinkingDelta(
	partial: AssistantMessage,
	delta: string,
): AssistantMessageEvent {
	return { type: "thinking_delta", contentIndex: 0, delta, partial };
}

function doneEvent(message: AssistantMessage): AssistantMessageEvent {
	return { type: "done", reason: "stop", message };
}

function blankAssistant(
	over: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: PROVIDER_KEY,
		model: OMLX_MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...over,
	};
}

// Drain a stream into an array, terminating on the first done/error event.
async function collect(
	stream: AssistantMessageEventStream,
): Promise<AssistantMessageEvent[]> {
	const out: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		out.push(event);
		if (event.type === "done" || event.type === "error") break;
	}
	return out;
}

test("non-oMLX models pass straight through to the concrete implementation", async () => {
	const partial = blankAssistant({
		provider: "zai",
		content: [{ type: "text", text: "hi" }],
	});
	innerStreamModule.queue([
		startEvent(partial),
		textDelta(partial, "hi"),
		doneEvent(partial),
	]);

	const stream = streamOmlxOpenAICompletions(
		NON_OMLX_MODEL,
		EMPTY_CONTEXT,
		undefined,
		1_000,
		undefined,
	);

	const events = await collect(stream);
	assert.equal(events[0].type, "start");
	assert.equal(events.at(-1)?.type, "done");
	// The concrete impl was invoked directly with the non-oMLX model.
	const captured = innerStreamModule.lastArgs();
	assert.equal(captured?.model.provider, "zai");
});

test("oMLX model streams body events and terminates on done", async () => {
	const partial = blankAssistant();
	innerStreamModule.queue([
		startEvent(partial),
		textDelta(partial, "answer"),
		doneEvent(partial),
	]);

	const stream = streamOmlxOpenAICompletions(
		OMLX_MODEL,
		EMPTY_CONTEXT,
		undefined,
		5_000,
		undefined,
	);

	const events = await collect(stream);
	assert.ok(events.some((e) => e.type === "text_delta"));
	assert.equal(events.at(-1)?.type, "done");
});

test("buffered thinking is flushed when the inner stream errors mid-stream", async () => {
	const partial = blankAssistant();
	// The reachable data-loss path: thinking is buffered (and clears the
	// inactivity timer because it counts as a meaningful body event), then the
	// inner stream throws. The old code rethrew without flushing, dropping the
	// buffered thinking; runAttempt must flush it before propagating.
	innerStreamModule.queueFactory(async function* () {
		yield startEvent(partial);
		yield thinkingDelta(partial, "pondering");
		throw new Error("connection reset");
	});

	const stream = streamOmlxOpenAICompletions(
		OMLX_MODEL,
		EMPTY_CONTEXT,
		undefined,
		5_000,
		undefined,
	);

	const events = await collect(stream);
	assert.ok(
		events.some((e) => e.type === "thinking_delta"),
		"buffered thinking event must be flushed when the inner stream errors",
	);
	assert.equal(events.at(-1)?.type, "error");
});

test("a repeat-stop triggers at most one reissue, then succeeds", async () => {
	// First inner stream: emits done(stop) whose thinking matches a prior
	// assistant message => isRepeatStop true => one reissue. Second inner stream
	// (the reissue attempt): normal text + done.
	const thinking = "the answer is forty two and only that exact phrase";
	const partial = blankAssistant({ content: [{ type: "thinking", thinking }] });
	const priorAssistant: AssistantMessage = {
		...partial,
		content: [{ type: "thinking", thinking }],
	};
	const context: Context = { messages: [priorAssistant] };

	let calls = 0;
	innerStreamModule.queueFactory(() => {
		calls++;
		return calls === 1
			? arrayIterator([startEvent(partial), doneEvent(partial)])
			: arrayIterator([
					startEvent(partial),
					textDelta(partial, "ok"),
					doneEvent(partial),
				]);
	});

	const stream = streamOmlxOpenAICompletions(
		OMLX_MODEL,
		context,
		undefined,
		5_000,
		undefined,
	);

	const events = await collect(stream);
	assert.equal(calls, 2, "exactly one reissue attempt follows a repeat-stop");
	assert.equal(events.at(-1)?.type, "done");
});

test("two timeouts without progress produce a single terminal error", async () => {
	// Never emit a meaningful body event: the timer fires on every attempt.
	innerStreamModule.queue([startEvent(blankAssistant())]);

	const stream = streamOmlxOpenAICompletions(
		OMLX_MODEL,
		EMPTY_CONTEXT,
		undefined,
		5,
		undefined,
	);

	const events = await collect(stream);
	const errors = events.filter((e) => e.type === "error");
	assert.equal(errors.length, 1, "one terminal timeout error, no retry storm");
});

test("a pre-aborted parent signal surfaces as an aborted terminal error", async () => {
	const controller = new AbortController();
	controller.abort();
	const partial = blankAssistant();
	innerStreamModule.queue([
		startEvent(partial),
		textDelta(partial, "x"),
		doneEvent(partial),
	]);

	const stream = streamOmlxOpenAICompletions(
		OMLX_MODEL,
		EMPTY_CONTEXT,
		{ signal: controller.signal } as SimpleStreamOptions,
		5_000,
		undefined,
	);

	const events = await collect(stream);
	const last = events.at(-1);
	assert.equal(last?.type, "error");
	assert.equal((last as { reason: string }).reason, "aborted");
});
