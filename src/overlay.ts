export interface OverlayStats {
	beforeChars: number;
	afterChars: number;
	replacedMessages: number;
	overlay: string;
}

export interface OverlayResult {
	messages: unknown[];
	stats?: OverlayStats;
}

const AUTOPLAN_OVERLAY_NAME = "gstack-autoplan";

export function applyOmlxCompatibilityOverlay(messages: unknown[]): OverlayResult {
	const beforeChars = estimateMessagesChars(messages);
	const targetIndex = findLatestAutoplanSkillIndex(messages);
	if (targetIndex === -1) return { messages };

	const target = messages[targetIndex];
	const text = getMessageText(target);
	if (!text) return { messages };
	if (text.includes("[OMLX compatibility overlay applied by pi-omlx-picker.]")) {
		return { messages };
	}

	const overlaid = messages.map((message, index) => {
		if (index !== targetIndex) return message;
		return replaceMessageText(message, buildAutoplanOverlayText(text));
	});

	return {
		messages: overlaid,
		stats: {
			beforeChars,
			afterChars: estimateMessagesChars(overlaid),
			replacedMessages: 1,
			overlay: AUTOPLAN_OVERLAY_NAME,
		},
	};
}

function buildAutoplanOverlayText(text: string): string {
	const tagMatch = text.match(/^<skill name="([^"]+)" location="([^"]+)">/);
	const name = tagMatch?.[1] ?? AUTOPLAN_OVERLAY_NAME;
	const location = tagMatch?.[2] ?? "unknown";
	const description = text.match(/^description:\s*\|?\s*\n([\s\S]*?)\n---/m)?.[1];

	return [
		`<skill name="${name}" location="${location}">`,
		`[OMLX compatibility overlay applied by pi-omlx-picker.]`,
		`Use the referenced skill file as authoritative if more detail is needed.`,
		description ? `Summary:\n${normalizeWhitespace(description).slice(0, 500)}` : undefined,
		`Execution contract:`,
		`- Run the actual ${name.replace(/^gstack-/, "")} workflow.`,
		`- Treat this turn as /no_think. Do not enter a hidden thinking phase before acting.`,
		`- Do not print the preamble.`,
		`- Do not narrate shell commands, phases, or steps.`,
		`- Do not emit fenced bash blocks.`,
		`- Use Pi tool calls for shell, file, and git actions.`,
		`- Start with the first concrete tool call immediately.`,
		`- If no tool is needed for a step, continue with the next concrete action instead of narrating intent.`,
		`/no_think`,
		`</skill>`,
	]
		.filter((part): part is string => typeof part === "string")
		.join("\n\n");
}

function findLatestAutoplanSkillIndex(messages: unknown[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (getMessageRole(messages[index]) !== "user") continue;
		const text = getMessageText(messages[index]);
		if (!text) continue;
		if (!text.includes(`<skill name="${AUTOPLAN_OVERLAY_NAME}"`)) continue;
		return index;
	}
	return -1;
}

function getMessageRole(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const role = (message as Record<string, unknown>).role;
	return typeof role === "string" ? role : undefined;
}

function getMessageText(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((item) => {
			if (!item || typeof item !== "object") return undefined;
			const record = item as Record<string, unknown>;
			return typeof record.text === "string" ? record.text : undefined;
		})
		.filter((item): item is string => typeof item === "string");
	return text.length > 0 ? text.join("\n") : undefined;
}

function replaceMessageText(message: unknown, text: string): unknown {
	if (!message || typeof message !== "object") return message;
	const current = message as Record<string, unknown>;
	const content = current.content;
	if (typeof content === "string") {
		return { ...current, content: text };
	}
	if (!Array.isArray(content)) return message;

	return {
		...current,
		content: [
			{
				type: "text",
				text,
			},
		],
	};
}

function estimateMessagesChars(messages: unknown[]): number {
	return messages.reduce<number>((sum, message) => sum + (getMessageText(message)?.length ?? 0), 0);
}

function normalizeWhitespace(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join("\n");
}
