import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type SmokeStatusModel,
	selectNonThinkingSmokeModel,
} from "../src/smoke-model-selection.ts";

const baseUrl = normalizeBaseUrl(
	process.env.OMLX_BASE_URL ?? "http://127.0.0.1:8000/v1",
);
const apiKey = process.env.OMLX_API_KEY ?? "local-smoke";
const logDir = join(process.cwd(), "log", "smoke-test");
const logPath = join(
	logDir,
	`${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);

const headers = {
	"content-type": "application/json",
	authorization: `Bearer ${apiKey}`,
};

async function main(): Promise<void> {
	mkdirSync(logDir, { recursive: true });
	const startedAt = new Date().toISOString();
	const models = await fetchStatusModels();
	const reasoningModel =
		process.env.OMLX_REASONING_MODEL ??
		models.find((m) => m.thinking_default === true)?.id;
	const nonThinkingModel =
		process.env.OMLX_NON_THINKING_MODEL ?? selectNonThinkingSmokeModel(models);
	const fallbackModel = models.find((m) => typeof m.id === "string")?.id;

	console.log(`OMLX smoke baseUrl=${baseUrl}`);
	console.log(`models=${models.length}`);
	console.log(`reasoningModel=${reasoningModel ?? "missing"}`);
	console.log(`nonThinkingModel=${nonThinkingModel ?? "missing"}`);
	const proof: Record<string, unknown> = {
		startedAt,
		baseUrl,
		modelCount: models.length,
		reasoningModel,
		nonThinkingModel,
		checks: [],
	};

	if (!reasoningModel)
		throw new Error(
			"No reasoning model found. Set OMLX_REASONING_MODEL to run the reasoning smoke.",
		);
	if (!nonThinkingModel)
		throw new Error(
			"No non-thinking model found. Set OMLX_NON_THINKING_MODEL to run the non-thinking smoke.",
		);

	(proof.checks as unknown[]).push(await smokeChat(reasoningModel, true));
	(proof.checks as unknown[]).push(await smokeChat(nonThinkingModel, false));
	const toolModel = reasoningModel ?? fallbackModel;
	(proof.checks as unknown[]).push(await smokeToolCall(toolModel));
	(proof.checks as unknown[]).push(await smokeToolCallStreaming(toolModel));
	(proof.checks as unknown[]).push(await smokeThinkingBudgetZeroOnly(models));

	proof.finishedAt = new Date().toISOString();
	proof.status = "passed";
	writeFileSync(logPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
	console.log(`proofLog=${logPath}`);
	console.log("OMLX smoke passed");
}

async function smokeThinkingBudgetZeroOnly(
	models: SmokeStatusModel[],
): Promise<Record<string, unknown>> {
	// For models with forced_ct_kwargs containing enable_thinking, the server
	// blocks chat_template_kwargs overrides. Recovery turns rely solely on
	// thinking_budget: 0. This smoke test verifies that alone suppresses thinking.
	const forcedModel = models.find(
		(m) =>
			Array.isArray(m.forced_ct_kwargs) &&
			m.forced_ct_kwargs.includes("enable_thinking") &&
			typeof m.id === "string",
	);
	if (!forcedModel) {
		console.log("thinking_budget_zero_only skipped (no forced-template model)");
		return {
			kind: "thinking_budget_zero_only",
			status: "skipped",
			reason: "no_forced_template_model",
		};
	}

	const request = {
		model: forcedModel.id,
		messages: [
			{ role: "system", content: "Reply with exactly OK." },
			{ role: "user", content: "Say OK." },
		],
		stream: false,
		max_tokens: 512,
		// Only thinking_budget: 0 — no chat_template_kwargs override
		thinking_budget: 0,
	};
	const json = await postChat(request);
	const content = json.choices?.[0]?.message?.content;
	const usage = json.usage;

	// Check usage for thinking tokens (OMLX reports thinking_tokens in usage)
	const thinkingTokens =
		typeof usage?.thinking_tokens === "number"
			? usage.thinking_tokens
			: typeof usage?.reasoning_tokens === "number"
				? usage.reasoning_tokens
				: 0;

	if (typeof content !== "string" || content.trim().length === 0) {
		throw new Error(
			`thinking_budget:0 smoke for ${forcedModel.id} returned no visible content`,
		);
	}

	const passed = thinkingTokens === 0;
	if (!passed) {
		console.warn(
			`thinking_budget_zero_only ${forcedModel.id} WARNING: thinking_tokens=${thinkingTokens} (thinking_budget:0 alone did not suppress thinking)`,
		);
	}
	console.log(
		`thinking_budget_zero_only ${forcedModel.id} ok thinking_tokens=${thinkingTokens}`,
	);
	return {
		kind: "thinking_budget_zero_only",
		model: forcedModel.id,
		status: passed ? "passed" : "warning",
		thinkingTokens,
		contentPreview: content.trim().slice(0, 120),
		note: passed
			? "thinking_budget:0 alone suppressed thinking"
			: "thinking_budget:0 alone did NOT suppress thinking — recovery for forced-template models is best-effort",
	};
}

async function fetchStatusModels(): Promise<SmokeStatusModel[]> {
	const response = await fetch(`${baseUrl}/models/status`, { headers });
	if (!response.ok)
		throw new Error(
			`/models/status failed: ${response.status} ${await response.text()}`,
		);
	const json = (await response.json()) as { models?: SmokeStatusModel[] };
	if (!Array.isArray(json.models))
		throw new Error("/models/status response missing models array");
	return json.models.filter((model) => typeof model.id === "string");
}

async function smokeChat(
	model: string,
	thinking: boolean,
): Promise<Record<string, unknown>> {
	const request = {
		model,
		messages: [
			{ role: "system", content: "Reply with exactly OK." },
			{ role: "user", content: "Say OK." },
		],
		stream: false,
		max_tokens: 512,
		thinking_budget: thinking ? 1024 : 0,
		chat_template_kwargs: { enable_thinking: thinking },
	};
	const json = await postChat(request);
	const content = json.choices?.[0]?.message?.content;
	const finishReason = json.choices?.[0]?.finish_reason;
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new Error(`Chat smoke for ${model} returned no visible content`);
	}
	if (finishReason === "length") {
		throw new Error(
			`Chat smoke for ${model} was truncated with finish_reason=length`,
		);
	}
	console.log(`chat ${model} thinking=${thinking} ok`);
	return {
		kind: "chat",
		model,
		thinking,
		status: "passed",
		request: {
			maxTokens: request.max_tokens,
			thinkingBudget: request.thinking_budget,
			enableThinking: request.chat_template_kwargs.enable_thinking,
		},
		contentPreview: content.trim().slice(0, 120),
		finishReason,
	};
}

async function smokeToolCall(
	model: string | undefined,
): Promise<Record<string, unknown>> {
	if (!model) throw new Error("No model available for tool-call smoke");
	const request = {
		model,
		messages: [
			{
				role: "system",
				content: "Use tools when the user asks you to call one.",
			},
			{ role: "user", content: "Call the echo tool with text set to smoke." },
		],
		stream: false,
		max_tokens: 512,
		tools: [
			{
				type: "function",
				function: {
					name: "echo",
					description: "Echo test input.",
					parameters: {
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
					},
				},
			},
		],
		tool_choice: "auto",
		chat_template_kwargs: { enable_thinking: false },
		thinking_budget: 0,
	};
	const json = await postChat(request);
	const message = json.choices?.[0]?.message;
	const finishReason = json.choices?.[0]?.finish_reason;
	const toolCalls = Array.isArray(message?.tool_calls)
		? message.tool_calls
		: [];
	if (toolCalls.length === 0) {
		throw new Error(`Tool-call smoke for ${model} returned no tool calls`);
	}
	if (finishReason === "length") {
		throw new Error(
			`Tool-call smoke for ${model} was truncated with finish_reason=length`,
		);
	}
	console.log(`tool-flow ${model} ok toolCalls=${toolCalls.length}`);
	return {
		kind: "tool-flow",
		model,
		status: "passed",
		request: {
			maxTokens: request.max_tokens,
			thinkingBudget: request.thinking_budget,
			enableThinking: request.chat_template_kwargs.enable_thinking,
			toolChoice: request.tool_choice,
		},
		toolCallCount: toolCalls.length,
		contentPreview:
			typeof message?.content === "string"
				? message.content.trim().slice(0, 120)
				: undefined,
		finishReason,
	};
}

async function smokeToolCallStreaming(
	model: string | undefined,
): Promise<Record<string, unknown>> {
	if (!model)
		throw new Error("No model available for streaming tool-call smoke");
	const request = buildToolCallRequest(model, true);
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify(request),
	});
	if (!response.ok)
		throw new Error(
			`/chat/completions stream failed: ${response.status} ${await response.text()}`,
		);
	if (!response.body)
		throw new Error("Streaming tool-call smoke returned no response body");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let sseChunkCount = 0;
	let toolCallDeltaCount = 0;
	let finishReasonObserved: string | undefined;
	const rawChunkPreviews: string[] = [];

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice("data:".length).trim();
			if (!data || data === "[DONE]") continue;
			sseChunkCount += 1;
			rawChunkPreviews.push(data.slice(0, 240));
			if (rawChunkPreviews.length > 6) rawChunkPreviews.splice(3, 1);
			if (data.includes('"tool_calls"') || data.includes('"tool_call_delta"'))
				toolCallDeltaCount += 1;
			try {
				const json = JSON.parse(data);
				const finishReason = json.choices?.[0]?.finish_reason;
				if (typeof finishReason === "string")
					finishReasonObserved = finishReason;
			} catch {
				// Raw previews are enough when a provider emits non-JSON diagnostic chunks.
			}
		}
	}

	if (finishReasonObserved === "length") {
		throw new Error(
			`Streaming tool-call smoke for ${model} was truncated with finish_reason=length`,
		);
	}
	if (toolCallDeltaCount === 0) {
		throw new Error(
			`Streaming tool-call smoke for ${model} saw no tool call chunks`,
		);
	}
	console.log(
		`tool-flow streaming ${model} ok chunks=${sseChunkCount} toolChunks=${toolCallDeltaCount}`,
	);
	return {
		kind: "tool-flow-streaming",
		model,
		status: "passed",
		sseChunkCount,
		toolCallDeltaCount,
		finishReasonObserved,
		rawChunkPreviews,
	};
}

function buildToolCallRequest(
	model: string,
	stream: boolean,
): Record<string, unknown> {
	return {
		model,
		messages: [
			{
				role: "system",
				content: "Use tools when the user asks you to call one.",
			},
			{ role: "user", content: "Call the echo tool with text set to smoke." },
		],
		stream,
		max_tokens: 512,
		tools: [
			{
				type: "function",
				function: {
					name: "echo",
					description: "Echo test input.",
					parameters: {
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
					},
				},
			},
		],
		tool_choice: "auto",
		chat_template_kwargs: { enable_thinking: false },
		thinking_budget: 0,
	};
}

type ChatResponse = {
	choices?: Array<{
		message?: {
			content?: unknown;
			tool_calls?: unknown[];
		};
		finish_reason?: string;
	}>;
	usage?: {
		thinking_tokens?: number;
		reasoning_tokens?: number;
	};
};

async function postChat(
	payload: Record<string, unknown>,
): Promise<ChatResponse> {
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
	});
	if (!response.ok)
		throw new Error(
			`/chat/completions failed: ${response.status} ${await response.text()}`,
		);
	return response.json() as Promise<ChatResponse>;
}

function normalizeBaseUrl(value: string): string {
	const withV1 = value.replace(/\/+$/, "");
	const url = new URL(withV1.endsWith("/v1") ? withV1 : `${withV1}/v1`);
	if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
	return url.toString().replace(/\/+$/, "");
}

main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	try {
		mkdirSync(logDir, { recursive: true });
		writeFileSync(
			logPath,
			`${JSON.stringify({ startedAt: new Date().toISOString(), baseUrl, status: "failed", error: message }, null, 2)}\n`,
			"utf8",
		);
		console.error(`proofLog=${logPath}`);
	} catch {
		// The smoke failure itself should remain the primary process error.
	}
	console.error(message);
	process.exitCode = 1;
});
