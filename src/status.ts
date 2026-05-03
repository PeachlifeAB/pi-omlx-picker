import type { OmlxModel } from "./catalog.ts";
import type { ModelPerformance } from "./performance.ts";
import { rollingTokensPerSecond } from "./performance.ts";
import type { RecoveryThinkingOverrideStatus } from "./recovery-readiness.ts";
import type {
	AssistantStopDiagnostic,
	SessionDiagnostics,
} from "./session-diagnostics.ts";
import type { TaskBudgetState } from "./task-budget.ts";
import {
	getTaskBudgetRemainingRatio,
	getTaskBudgetRemainingTokens,
} from "./task-budget.ts";

export interface StatusPiModel {
	provider?: string;
	id?: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	compat?: Record<string, unknown>;
}

export interface RecoveryCounts {
	boundaryGarbage: number;
	emptyStop: number;
	thinkingOnly: number;
	toolValidation: number;
	toolIntent: number;
}

export interface OmlxStatusSnapshot {
	apiRoot?: string;
	registered: boolean;
	catalog: OmlxModel[];
	modelSettingsPath?: string;
	modelSettingsFound?: boolean;
	lastRefreshAt?: string;
	lastError?: string;
	lastErrorAt?: string;
	activePiModel?: StatusPiModel;
	currentThinkingLevel?: string;
	performance?: ModelPerformance;
	taskBudget: TaskBudgetState;
	recoveryCounts: RecoveryCounts;
	recoveryThinkingOverride?: RecoveryThinkingOverrideStatus;
	session?: SessionDiagnostics;
	debugLogFile: string;
}

export function renderOmlxStatus(snapshot: OmlxStatusSnapshot): string {
	const activeOmlx =
		snapshot.activePiModel?.provider === "omlx"
			? snapshot.catalog.find(
					(model) => model.id === snapshot.activePiModel?.id,
				)
			: undefined;

	const lines: string[] = ["OMLX status", ""];
	lines.push("Connection");
	lines.push(`- API root: ${snapshot.apiRoot ?? "not configured"}`);
	lines.push(`- registered: ${formatBool(snapshot.registered)}`);
	lines.push(`- model count: ${snapshot.catalog.length}`);
	lines.push(
		`- settings path: ${formatSettingsPath(snapshot.modelSettingsPath, snapshot.modelSettingsFound)}`,
	);
	lines.push(`- last refresh: ${snapshot.lastRefreshAt ?? "never"}`);
	lines.push(
		`- last error: ${snapshot.lastError ? `${snapshot.lastError}${snapshot.lastErrorAt ? ` at ${snapshot.lastErrorAt}` : ""}` : "none"}`,
	);
	lines.push("");

	lines.push("Session");
	if (!snapshot.session) {
		lines.push("- file: unavailable");
		lines.push("- messages: unavailable");
		lines.push("- tokens: unavailable");
		lines.push("- last assistant stop: unavailable");
		lines.push("- recent anomalies: unavailable");
	} else {
		lines.push(`- file: ${snapshot.session.sessionFile ?? "unavailable"}`);
		lines.push(`- id: ${snapshot.session.sessionId ?? "unavailable"}`);
		lines.push(`- leaf: ${snapshot.session.leafId ?? "unavailable"}`);
		lines.push(`- messages: ${formatSessionCounts(snapshot.session)}`);
		lines.push(`- tokens: ${formatSessionTokens(snapshot.session)}`);
		lines.push(
			`- last assistant stop: ${snapshot.session.lastAssistantStop ? formatAssistantStop(snapshot.session.lastAssistantStop) : "none"}`,
		);
		lines.push(
			`- recent anomalies: ${formatRecentAnomalies(snapshot.session.recentAnomalies)}`,
		);
	}
	lines.push("");

	lines.push("Active model");
	if (!activeOmlx) {
		const current =
			snapshot.activePiModel?.provider && snapshot.activePiModel?.id
				? `${snapshot.activePiModel.provider}/${snapshot.activePiModel.id}`
				: "none";
		lines.push(`- status: not using OMLX (${current})`);
		lines.push("- display name: n/a");
		lines.push("- raw id: n/a");
		lines.push("- description: n/a");
		lines.push("- capability: n/a");
	} else {
		lines.push(`- display name: ${activeOmlx.displayName ?? activeOmlx.id}`);
		lines.push(`- raw id: ${activeOmlx.id}`);
		lines.push(`- API alias: ${activeOmlx.modelAlias ?? "not configured"}`);
		lines.push(`- description: ${activeOmlx.description ?? "not configured"}`);
		lines.push(
			`- capability: ${formatCapability(snapshot.activePiModel, activeOmlx)}`,
		);
	}
	lines.push("");

	lines.push("Pi mapping");
	if (!activeOmlx || !snapshot.activePiModel) {
		lines.push("- provider name: n/a");
		lines.push("- reasoning enabled: n/a");
		lines.push("- thinking format: n/a");
		lines.push("- context window: n/a");
		lines.push("- max tokens: n/a");
	} else {
		lines.push(
			`- provider name: ${snapshot.activePiModel.name ?? activeOmlx.displayName ?? activeOmlx.id}`,
		);
		lines.push(
			`- reasoning enabled: ${formatBool(snapshot.activePiModel.reasoning === true)}`,
		);
		lines.push(
			`- Pi thinking level: ${snapshot.currentThinkingLevel ?? "unknown"}`,
		);
		lines.push(`- OMLX-derived thinking: ${formatNativeThinking(activeOmlx)}`);
		lines.push(
			`- thinking format: ${formatThinkingFormat(snapshot.activePiModel.compat)}`,
		);
		lines.push(
			`- max tokens field: ${formatMaxTokensField(snapshot.activePiModel.compat)}`,
		);
		lines.push(
			`- context window: ${formatNumber(snapshot.activePiModel.contextWindow ?? activeOmlx.contextWindow)}`,
		);
		lines.push(
			`- max tokens: ${formatNumber(snapshot.activePiModel.maxTokens ?? activeOmlx.maxTokens)}`,
		);
	}
	lines.push("");

	lines.push("OMLX settings");
	if (!activeOmlx) {
		lines.push("- active settings: n/a");
	} else {
		lines.push(`- thinking: ${formatThinkingSettings(activeOmlx)}`);
		lines.push(
			`- identity: ${formatSummaryRecord(activeOmlx.settingsSummary, "identity")}`,
		);
		lines.push(
			`- limits: ${formatSummaryRecord(activeOmlx.settingsSummary, "limits")}`,
		);
		lines.push(
			`- Pi bridge task budget: ${formatNumber(activeOmlx.taskBudgetTokens)}`,
		);
		lines.push(
			`- max tool result: ${formatNumber(activeOmlx.maxToolResultTokens)}`,
		);
		lines.push(
			`- forced chat-template kwargs: ${activeOmlx.forcedCtKwargs?.join(", ") || "none"}`,
		);
		lines.push(
			`- chat-template kwargs: ${formatSummaryRecord(activeOmlx.settingsSummary, "chatTemplate")}`,
		);
		lines.push(
			`- sampling: ${formatSummaryRecord(activeOmlx.settingsSummary, "sampling")}`,
		);
		lines.push(
			`- DFlash: ${formatSummaryRecord(activeOmlx.settingsSummary, "dflash")}`,
		);
		lines.push(
			`- SpecPrefill: ${formatSummaryRecord(activeOmlx.settingsSummary, "specprefill")}`,
		);
		lines.push(
			`- TurboQuant: ${formatSummaryRecord(activeOmlx.settingsSummary, "turboquant")}`,
		);
		lines.push(
			`- lifecycle: ${formatSummaryRecord(activeOmlx.settingsSummary, "lifecycle")}`,
		);
		lines.push(
			`- security: ${formatSummaryRecord(activeOmlx.settingsSummary, "security")}`,
		);
		lines.push(
			`- profile: ${formatSummaryRecord(activeOmlx.settingsSummary, "profile")}`,
		);
		lines.push(
			`- local settings entry: ${activeOmlx.settingsSummary && Object.keys(activeOmlx.settingsSummary).length > 0 ? "present" : "missing"}`,
		);
	}
	lines.push("");

	lines.push("Runtime");
	lines.push(
		`- last tokens/sec: ${formatRate(snapshot.performance?.last?.tokensPerSecond)}`,
	);
	lines.push(
		`- rolling tokens/sec: ${formatRate(rollingTokensPerSecond(snapshot.performance))}`,
	);
	lines.push(
		`- output tokens: ${formatNumber(snapshot.performance?.totalOutputTokens)}`,
	);
	lines.push(
		`- task budget remaining: ${formatTaskBudget(snapshot.taskBudget)}`,
	);
	if (activeOmlx && snapshot.session?.lastAssistantStop) {
		lines.push(
			`- last stop output/max tokens: ${formatTokenRatio(snapshot.session.lastAssistantStop.outputTokens, snapshot.activePiModel?.maxTokens ?? activeOmlx.maxTokens)}`,
		);
		lines.push(
			`- last stop context/window: ${formatTokenRatio(snapshot.session.lastAssistantStop.totalTokens, snapshot.activePiModel?.contextWindow ?? activeOmlx.contextWindow)}`,
		);
	}
	lines.push("");

	lines.push("Recovery");
	lines.push(`- boundary garbage: ${snapshot.recoveryCounts.boundaryGarbage}`);
	lines.push(`- empty stop: ${snapshot.recoveryCounts.emptyStop}`);
	lines.push(`- thinking only: ${snapshot.recoveryCounts.thinkingOnly}`);
	lines.push(`- tool validation: ${snapshot.recoveryCounts.toolValidation}`);
	lines.push(`- tool intent: ${snapshot.recoveryCounts.toolIntent}`);
	lines.push(
		`- thinking override: ${formatRecoveryThinkingOverride(snapshot.recoveryThinkingOverride)}`,
	);
	if (snapshot.session) {
		lines.push(
			`- session recoveries: boundary=${snapshot.session.recoveryCounts.boundaryGarbage}, empty=${snapshot.session.recoveryCounts.emptyStop}, thinking=${snapshot.session.recoveryCounts.thinkingOnly}, validation=${snapshot.session.recoveryCounts.toolValidation}, tool intent=${snapshot.session.recoveryCounts.toolIntent}`,
		);
	}
	lines.push(`- debug log: ${snapshot.debugLogFile}`);
	return lines.join("\n");
}

function formatSessionCounts(session: SessionDiagnostics): string {
	const counts = session.counts;
	return [
		`user=${formatNumber(counts.userMessages)}`,
		`assistant=${formatNumber(counts.assistantMessages)}`,
		`tool calls=${formatNumber(counts.toolCalls)}`,
		`tool results=${formatNumber(counts.toolResults)}`,
		`total=${formatNumber(counts.totalEntries)}`,
	].join(", ");
}

function formatSessionTokens(session: SessionDiagnostics): string {
	const tokens = session.tokens;
	return [
		`input=${formatNumber(tokens.input)}`,
		`output=${formatNumber(tokens.output)}`,
		`cache read=${formatNumber(tokens.cacheRead)}`,
		`total=${formatNumber(tokens.total)}`,
	].join(", ");
}

function formatAssistantStop(stop: AssistantStopDiagnostic): string {
	const flags = [
		stop.hasVisibleText ? "visible" : "no visible",
		stop.hasThinking ? "thinking" : "no thinking",
		stop.hasToolCalls ? "tool calls" : "no tool calls",
		`content=${stop.contentTypes.join("|") || "none"}`,
	];
	const preview = stop.textPreview ?? stop.thinkingPreview;
	return [
		stop.timestamp ?? "unknown time",
		stop.diagnosis,
		`stop=${stop.stopReason ?? "unknown"}`,
		`input=${formatNumber(stop.inputTokens)}`,
		`output=${formatNumber(stop.outputTokens)}`,
		`cache read=${formatNumber(stop.cacheReadTokens)}`,
		`total=${formatNumber(stop.totalTokens)}`,
		flags.join(", "),
		preview ? `preview="${preview}"` : undefined,
	]
		.filter((part): part is string => typeof part === "string")
		.join("; ");
}

function formatRecentAnomalies(anomalies: AssistantStopDiagnostic[]): string {
	if (anomalies.length === 0) return "none";
	return anomalies
		.slice(-3)
		.map((item) => {
			const preview = item.textPreview ?? item.thinkingPreview;
			const parts = [
				item.timestamp ?? "unknown time",
				item.diagnosis,
				`output=${formatNumber(item.outputTokens)}`,
				preview ? `preview="${preview}"` : undefined,
			];
			return parts
				.filter((part): part is string => typeof part === "string")
				.join("; ");
		})
		.join(" | ");
}

function formatSettingsPath(
	path: string | undefined,
	found: boolean | undefined,
): string {
	if (!path) return "not configured";
	if (found === undefined) return path;
	return `${path} (${found ? "found" : "missing"})`;
}

function formatCapability(
	piModel: StatusPiModel | undefined,
	omlxModel: OmlxModel,
): string {
	const input =
		piModel?.input && piModel.input.length > 0
			? piModel.input
			: omlxModel.modelType === "vlm"
				? ["text", "image"]
				: ["text"];
	return input.join(", ");
}

function formatThinkingFormat(
	compat: Record<string, unknown> | undefined,
): string {
	const value = compat?.thinkingFormat;
	return typeof value === "string" ? value : "none";
}

function formatMaxTokensField(
	compat: Record<string, unknown> | undefined,
): string {
	const value = compat?.maxTokensField;
	return value === "max_tokens" || value === "max_completion_tokens"
		? value
		: "max_completion_tokens";
}

function formatThinkingSettings(model: OmlxModel): string {
	const parts = [
		`allowed=${formatBool(model.thinkingDefault === true)}`,
		`budgetEnabled=${model.thinkingBudgetEnabled === undefined ? "unknown" : formatBool(model.thinkingBudgetEnabled)}`,
		`budgetTokens=${formatNumber(model.thinkingBudgetTokens)}`,
		`preserve=${model.preserveThinking === undefined ? "unknown" : formatBool(model.preserveThinking)}`,
		`parser=${model.reasoningParser ?? "unknown"}`,
	];
	return parts.join(", ");
}

function formatNativeThinking(model: OmlxModel): string {
	if (model.nativeThinkingLevel) {
		return `${model.nativeThinkingLevel}${model.nativeThinkingSource ? ` (${model.nativeThinkingSource})` : ""}`;
	}
	if (model.thinkingDefault === true)
		return "not configured (Pi level preserved)";
	return "off";
}

function formatSummaryRecord(
	summary: Record<string, unknown> | undefined,
	key: string,
): string {
	if (!summary) return "not configured";
	const record = summary[key];
	if (!record || typeof record !== "object" || Array.isArray(record))
		return "not configured";
	const entries = Object.entries(record as Record<string, unknown>).filter(
		([, value]) => value !== undefined,
	);
	if (entries.length === 0) return "not configured";
	return entries
		.map(([name, value]) => `${name}=${formatValue(value)}`)
		.join(", ");
}

function formatTaskBudget(state: TaskBudgetState): string {
	const remaining = getTaskBudgetRemainingTokens(state);
	const ratio = getTaskBudgetRemainingRatio(state);
	if (state.totalTokens === undefined) {
		return state.usedOutputTokens > 0
			? `not configured (used ${formatNumber(state.usedOutputTokens)} output tokens)`
			: "not configured";
	}
	const pct = ratio === undefined ? "unknown" : `${Math.round(ratio * 100)}%`;
	return `${formatNumber(remaining)} of ${formatNumber(state.totalTokens)} (${pct})`;
}

function formatTokenRatio(
	value: number | undefined,
	limit: number | undefined,
): string {
	const base = `${formatNumber(value)} of ${formatNumber(limit)}`;
	if (
		typeof value !== "number" ||
		typeof limit !== "number" ||
		!Number.isFinite(value) ||
		!Number.isFinite(limit) ||
		limit <= 0
	) {
		return base;
	}
	return `${base} (${Math.round((value / limit) * 100)}%)`;
}

function formatRecoveryThinkingOverride(
	status: RecoveryThinkingOverrideStatus | undefined,
): string {
	if (!status) return "unavailable";
	const base = `sets thinking_budget=${status.requestThinkingBudget}`;
	if (status.blockedChatTemplateKeys.length === 0) {
		return `${base}, ${status.attemptedChatTemplateKeys.join("|")}=false`;
	}
	return `${base}; chat-template override blocked by forced_ct_kwargs=${status.blockedChatTemplateKeys.join("|")}`;
}

function formatNumber(value: number | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
	return Math.round(value).toLocaleString("en-US");
}

function formatRate(value: number | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value))
		return "unavailable";
	return `${value.toFixed(1)} tok/s`;
}

function formatBool(value: boolean): string {
	return value ? "yes" : "no";
}

function formatValue(value: unknown): string {
	if (typeof value === "number")
		return Number.isInteger(value) ? formatNumber(value) : String(value);
	if (typeof value === "boolean") return formatBool(value);
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(formatValue).join("|");
	if (value === null) return "null";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}
