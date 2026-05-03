import type { OmlxModel } from "./catalog.ts";

export interface RecoveryThinkingOverrideStatus {
	attemptedChatTemplateKeys: string[];
	blockedChatTemplateKeys: string[];
	requestThinkingBudget: 0;
	canOverrideChatTemplateThinking: boolean;
}

const RECOVERY_CHAT_TEMPLATE_KEYS = ["enable_thinking", "preserve_thinking"];

export function getRecoveryThinkingOverrideStatus(
	model: Pick<OmlxModel, "forcedCtKwargs"> | undefined,
): RecoveryThinkingOverrideStatus {
	const forced = new Set(model?.forcedCtKwargs ?? []);
	const blockedChatTemplateKeys = RECOVERY_CHAT_TEMPLATE_KEYS.filter((key) =>
		forced.has(key),
	);
	return {
		attemptedChatTemplateKeys: [...RECOVERY_CHAT_TEMPLATE_KEYS],
		blockedChatTemplateKeys,
		requestThinkingBudget: 0,
		canOverrideChatTemplateThinking: blockedChatTemplateKeys.length === 0,
	};
}
