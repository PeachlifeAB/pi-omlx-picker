const CONTEXT_CHAR_BUDGET = 250_000;
const KEEP_RECENT_MESSAGES = 8;
const LARGE_MESSAGE_CHARS = 20_000;
const SKILL_INLINE_CHARS = 12_000;
const PREVIEW_CHARS = 600;

export interface ContextCompactionStats {
	beforeChars: number;
	afterChars: number;
	modifiedMessages: number;
	compactedSkillMessages: number;
	compactedLargeMessages: number;
}

export interface ContextCompactionResult {
	messages: unknown[];
	stats?: ContextCompactionStats;
}

export function compactOmlxContext(messages: unknown[]): ContextCompactionResult {
	const filteredMessages = messages.filter((message) => !isOmlxStatusMessage(message));
	if (filteredMessages.length !== messages.length) {
		messages = filteredMessages;
	}

	const beforeChars = estimateMessagesChars(messages);
	if (beforeChars <= CONTEXT_CHAR_BUDGET && !hasOversizedHistoricalSkills(messages) && !hasRepeatedInlineSkill(messages)) {
		return { messages };
	}

	const keepFrom = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
	const latestSkill = findLatestInlineSkill(messages);
	const repeatedSkillIndexes = latestSkill ? findPriorInlineSkillIndexes(messages, latestSkill.name, latestSkill.index) : [];
	const retryClusterStart = repeatedSkillIndexes.length > 0 ? repeatedSkillIndexes[repeatedSkillIndexes.length - 1] : -1;
	let modifiedMessages = 0;
	let compactedSkillMessages = 0;
	let compactedLargeMessages = 0;

	const compacted = messages.map((message, index) => {
		const text = getMessageText(message);
		if (!text) return message;

		if (
			latestSkill &&
			repeatedSkillIndexes.includes(index) &&
			getMessageRole(message) === "user"
		) {
			modifiedMessages += 1;
			compactedSkillMessages += 1;
			return replaceMessageText(
				message,
				`[Earlier ${latestSkill.name} invocation compacted by pi-omlx-picker for OMLX. This session already contained a failed retry of the same skill, so only the latest invocation remains in full.]`,
			);
		}

		if (
			latestSkill &&
			index > retryClusterStart &&
			index < latestSkill.index &&
			getMessageRole(message) === "assistant" &&
			(text.length === 0 || isLikelyFailedSkillRetry(text, latestSkill.name) || isInvalidAutoplanAssistantTurn(text, latestSkill.name))
		) {
			modifiedMessages += 1;
			compactedLargeMessages += 1;
			return replaceMessageText(
				message,
				`[Earlier assistant stub from a failed ${latestSkill.name} retry compacted by pi-omlx-picker for OMLX. No tool calls were produced in that attempt.]`,
			);
		}

		if (index >= keepFrom) return message;

		if (isInlineSkillBlob(text) && text.length >= SKILL_INLINE_CHARS) {
			modifiedMessages += 1;
			compactedSkillMessages += 1;
			return replaceMessageText(message, compactSkillText(text));
		}

		if (beforeChars > CONTEXT_CHAR_BUDGET && text.length >= LARGE_MESSAGE_CHARS) {
			modifiedMessages += 1;
			compactedLargeMessages += 1;
			return replaceMessageText(message, compactLargeText(text));
		}

		return message;
	});

	if (modifiedMessages === 0) {
		return { messages };
	}

	return {
		messages: compacted,
		stats: {
			beforeChars,
			afterChars: estimateMessagesChars(compacted),
			modifiedMessages,
			compactedSkillMessages,
			compactedLargeMessages,
		},
	};
}

function hasOversizedHistoricalSkills(messages: unknown[]): boolean {
	const keepFrom = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
	return messages.some((message, index) => {
		if (index >= keepFrom) return false;
		const text = getMessageText(message);
		return typeof text === "string" && text.length >= SKILL_INLINE_CHARS && isInlineSkillBlob(text);
	});
}

function hasRepeatedInlineSkill(messages: unknown[]): boolean {
	const latestSkill = findLatestInlineSkill(messages);
	return latestSkill ? findPriorInlineSkillIndexes(messages, latestSkill.name, latestSkill.index).length > 0 : false;
}

function estimateMessagesChars(messages: unknown[]): number {
	return messages.reduce<number>((sum, message) => sum + (getMessageText(message)?.length ?? 0), 0);
}

function getMessageRole(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const role = (message as Record<string, unknown>).role;
	return typeof role === "string" ? role : undefined;
}

function isOmlxStatusMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const current = message as Record<string, unknown>;
	return current.role === "custom" && current.customType === "omlx-status";
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

function isInlineSkillBlob(text: string): boolean {
	return text.includes("<skill name=\"") && text.includes("</skill>");
}

function extractInlineSkillName(text: string): string | undefined {
	return text.match(/^<skill name="([^"]+)"/)?.[1];
}

function findLatestInlineSkill(messages: unknown[]): { index: number; name: string } | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const text = getMessageText(messages[index]);
		if (!text || !isInlineSkillBlob(text)) continue;
		const name = extractInlineSkillName(text);
		if (!name) continue;
		return { index, name };
	}
	return undefined;
}

function findPriorInlineSkillIndexes(messages: unknown[], name: string, beforeIndex: number): number[] {
	const indexes: number[] = [];
	for (let index = 0; index < beforeIndex; index += 1) {
		const text = getMessageText(messages[index]);
		if (!text || !isInlineSkillBlob(text)) continue;
		if (extractInlineSkillName(text) === name) indexes.push(index);
	}
	return indexes;
}

function isLikelyFailedSkillRetry(text: string, skillName: string): boolean {
	const normalized = text.toLowerCase();
	const compactSkill = skillName.toLowerCase().replace(/^gstack-/, "");
	return (
		normalized.includes("autplan") ||
		normalized.includes(`/${compactSkill}`) ||
		normalized.includes(`/${skillName.toLowerCase()}`) ||
		normalized.includes("starting with preamble") ||
		normalized.includes("running the full pipeline") ||
		normalized.includes("let me run the full") ||
		normalized.includes("gstack-review-read")
	);
}

function isInvalidAutoplanAssistantTurn(text: string, skillName: string): boolean {
	const normalized = text.trim().toLowerCase();
	if (!skillName.toLowerCase().includes("autoplan")) return false;
	return (
		normalized === "[" ||
		normalized.includes("```bash") ||
		normalized.includes("you are an autopilot reviewer for gstack projects") ||
		normalized.startsWith("read /") ||
		normalized.startsWith("bash ") ||
		normalized.startsWith("git ")
	);
}

function compactSkillText(text: string): string {
	const tagMatch = text.match(/^<skill name="([^"]+)" location="([^"]+)">/);
	const name = tagMatch?.[1] ?? "unknown";
	const location = tagMatch?.[2] ?? "unknown";
	const description = text.match(/^description:\s*\|?\s*\n([\s\S]*?)\n---/m)?.[1];
	const keyRules = collectBulletPreview(text, ["Never abort", "Premises are the one gate", "Log every decision", "Sequential order"]);

	return [
		`<skill name="${name}" location="${location}">`,
		`[Compacted by pi-omlx-picker for OMLX: earlier inline skill copies are reduced because large verbatim skill blobs caused empty completions on this provider path.]`,
		`Treat the referenced skill file as authoritative if more detail is required.`,
		description ? `Summary:\n${normalizeWhitespace(description).slice(0, 800)}` : undefined,
		keyRules.length > 0 ? `Retained rules:\n${keyRules.join("\n")}` : undefined,
		`</skill>`,
	]
		.filter((part): part is string => typeof part === "string")
		.join("\n\n");
}

function compactLargeText(text: string): string {
	const head = text.slice(0, PREVIEW_CHARS).trim();
	const tail = text.slice(-PREVIEW_CHARS).trim();
	return [
		`[Earlier oversized message compacted by pi-omlx-picker for OMLX. Original length: ${text.length} chars.]`,
		`Start:\n${head}`,
		head === tail ? undefined : `End:\n${tail}`,
	]
		.filter((part): part is string => typeof part === "string")
		.join("\n\n");
}

function collectBulletPreview(text: string, needles: string[]): string[] {
	return needles
		.map((needle) => {
			const line = text
				.split("\n")
				.find((entry) => entry.includes(needle));
			return line ? `- ${normalizeWhitespace(line.replace(/^[-*]\s*/, ""))}` : undefined;
		})
		.filter((line): line is string => typeof line === "string");
}

function normalizeWhitespace(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join("\n");
}
