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

export interface OverlayOptions {
	toolsAvailable: boolean;
}

const OMLX_AGENT_CONTRACT_MARKER =
	"[OMLX agent contract applied by pi-omlx-picker.]";
const OMLX_AGENT_CONTRACT_NAME = "inline-skill-agent-contract";

export function applyOmlxCompatibilityOverlay(
	messages: unknown[],
	options: OverlayOptions = { toolsAvailable: true },
): OverlayResult {
	if (!options.toolsAvailable) return { messages };

	const beforeChars = estimateMessagesChars(messages);
	const targetIndex = findLatestInlineSkillIndex(messages);
	if (targetIndex === -1) return { messages };

	const target = messages[targetIndex];
	const text = getMessageText(target);
	if (!text) return { messages };
	if (text.includes(OMLX_AGENT_CONTRACT_MARKER)) {
		return { messages };
	}

	const overlaid = messages.map((message, index) => {
		if (index !== targetIndex) return message;
		return replaceMessageText(message, addAgentContract(text));
	});

	return {
		messages: overlaid,
		stats: {
			beforeChars,
			afterChars: estimateMessagesChars(overlaid),
			replacedMessages: 1,
			overlay: OMLX_AGENT_CONTRACT_NAME,
		},
	};
}

function addAgentContract(text: string): string {
	const contract = [
		OMLX_AGENT_CONTRACT_MARKER,
		`Provider contract:`,
		`- If an action requires a tool, emit the Pi tool call instead of describing the action.`,
		`- If you say you will inspect, edit, run, fetch, or verify something, emit the tool call now.`,
		`- End each assistant turn with either normal visible text or a Pi tool call, not protocol tags alone.`,
		`- Do not add task-specific recovery policy. Follow the referenced skill's own instructions.`,
	].join("\n");

	if (text.includes("</skill>")) {
		return text.replace("</skill>", `\n\n${contract}\n</skill>`);
	}
	return `${text}\n\n${contract}`;
}

function findLatestInlineSkillIndex(messages: unknown[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (getMessageRole(messages[index]) !== "user") continue;
		const text = getMessageText(messages[index]);
		if (!text) continue;
		if (!text.includes('<skill name="') || !text.includes("</skill>")) continue;
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
	return messages.reduce<number>(
		(sum, message) => sum + (getMessageText(message)?.length ?? 0),
		0,
	);
}
