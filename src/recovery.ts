const AUTOPLAN_STUB_PATTERNS = [
	"starting with preamble",
	"starting with preamble and context intake",
	"running the full pipeline",
	"let me run the full autoplan pipeline",
	"let me run the full `/autoplan` pipeline",
	"continue `/autoplan` now",
	"continue /autoplan now",
	"you are an autopilot reviewer for gstack projects",
];

const AUTOPLAN_RECOVERY_MESSAGE =
	"Continue `/autoplan` now. Do not restate that you are starting. Do not print the preamble. Execute the first concrete step immediately, and if a tool is needed, emit the tool call now.";

const AUTOPLAN_NARRATION_PATTERNS = [
	"```bash",
	"phase 0:",
	"### step 0:",
	"git log -20 --oneline",
	"git diff $base --stat",
	"gh pr view --json",
	"mkdir -p ~/.gstack/projects",
];

const AUTOPLAN_NARRATION_RECOVERY_MESSAGE =
	"Continue `/autoplan` now. Do not narrate shell commands. Do not print fenced bash blocks, phases, or steps. Execute the next concrete action with Pi tool calls only, and emit the first tool call now.";

export type AutoplanInvalidTurnReason = "empty" | "stub" | "narration";

export function shouldRecoverAutoplanStub(message: unknown, toolResults: number, branchMessages: unknown[]): boolean {
	if (toolResults > 0) return false;
	if (!message || typeof message !== "object") return false;

	const current = message as Record<string, unknown>;
	if (current.role !== "assistant") return false;
	if (current.stopReason !== "stop") return false;

	const toolCalls = extractToolCalls(current.content);
	if (toolCalls.length > 0) return false;

	const text = extractText(current.content);
	if (!text) return false;
	const normalized = text.toLowerCase();
	if (!AUTOPLAN_STUB_PATTERNS.some((pattern) => normalized.includes(pattern))) return false;

	return hasAutoplanInvocation(branchMessages);
}

export function shouldRecoverAutoplanNarration(message: unknown, toolResults: number, branchMessages: unknown[]): boolean {
	if (toolResults > 0) return false;
	if (!message || typeof message !== "object") return false;

	const current = message as Record<string, unknown>;
	if (current.role !== "assistant") return false;
	if (current.stopReason !== "stop") return false;

	const toolCalls = extractToolCalls(current.content);
	if (toolCalls.length > 0) return false;

	const text = extractText(current.content);
	if (!text) return false;
	const normalized = text.toLowerCase();
	if (!AUTOPLAN_NARRATION_PATTERNS.some((pattern) => normalized.includes(pattern))) return false;

	return hasAutoplanInvocation(branchMessages);
}

export function getAutoplanRecoveryMessage(): string {
	return AUTOPLAN_RECOVERY_MESSAGE;
}

export function getAutoplanNarrationRecoveryMessage(): string {
	return AUTOPLAN_NARRATION_RECOVERY_MESSAGE;
}

export function getAutoplanInvalidTurnReason(
	message: unknown,
	toolResults: number,
	branchMessages: unknown[],
): AutoplanInvalidTurnReason | undefined {
	if (toolResults > 0) return undefined;
	if (!hasAutoplanInvocation(branchMessages)) return undefined;
	if (!message || typeof message !== "object") return undefined;

	const current = message as Record<string, unknown>;
	if (current.role !== "assistant") return undefined;
	if (current.stopReason !== "stop") return undefined;

	const toolCalls = extractToolCalls(current.content);
	if (toolCalls.length > 0) return undefined;

	const text = extractText(current.content).trim();
	if (!text) return "empty";
	if (shouldRecoverAutoplanNarration(message, toolResults, branchMessages)) return "narration";
	if (shouldRecoverAutoplanStub(message, toolResults, branchMessages)) return "stub";
	return undefined;
}

export function getAutoplanFailureMessage(reason: AutoplanInvalidTurnReason): string {
	switch (reason) {
		case "empty":
			return "OMLX completed the `/autoplan` request but returned no usable output. The model did not emit tool calls or visible progress.";
		case "stub":
			return "OMLX returned `/autoplan` preamble text instead of executing the workflow. This was treated as invalid output, not real progress.";
		case "narration":
			return "OMLX returned narrated shell commands for `/autoplan` instead of Pi tool calls. This was treated as invalid output, not real progress.";
	}
}

export function getLatestAutoplanInvocationKey(messages: unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		if ((message as Record<string, unknown>).role !== "user") continue;
		const text = extractText((message as Record<string, unknown>).content);
		if (!text.includes("<skill name=\"gstack-autoplan\"")) continue;
		return `${index}:${text.length}`;
	}
	return undefined;
}

function hasAutoplanInvocation(messages: unknown[]): boolean {
	return typeof getLatestAutoplanInvocationKey(messages) === "string";
}

function findLatestUserText(messages: unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const role = (message as Record<string, unknown>).role;
		if (role !== "user") continue;
		const text = extractText((message as Record<string, unknown>).content);
		if (text) return text;
	}
	return undefined;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const record = item as Record<string, unknown>;
			return typeof record.text === "string" ? record.text : "";
		})
		.join("\n");
}

function extractToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.map((item) => {
			if (!item || typeof item !== "object") return undefined;
			const record = item as Record<string, unknown>;
			return record.type === "toolCall" && typeof record.name === "string" ? record.name : undefined;
		})
		.filter((item): item is string => typeof item === "string");
}
