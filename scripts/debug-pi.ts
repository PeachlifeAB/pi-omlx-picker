import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const HOME = homedir();
const PI_HOME = join(HOME, ".pi");
const SESSION_ROOT = join(PI_HOME, "agent", "sessions");
const PACKAGE_ID = "pi-omlx-picker";
const INSTALLED_PACKAGE = join(PI_HOME, "packages", PACKAGE_ID);
const PI_CONFIG = join(PI_HOME, "config.json");
const SKILLS_LOCK = join(PI_HOME, "skills-lock.json");
const PI_LOG_DIR = join(PI_HOME, "log");
const PACKAGE_LOG_DIR = join(INSTALLED_PACKAGE, "log");
const PACKAGE_DEBUG_LOG = join(PACKAGE_LOG_DIR, "provider-debug.log");
const OMLX_HOME = join(HOME, ".omlx");
const OMLX_SERVER_LOG = join(OMLX_HOME, "logs", "server.log");

const mode = process.argv[2] ?? "all";
const modeArgs = process.argv.slice(3);

function main(): void {
	section("PI DEBUG");
	line(`time: ${new Date().toISOString()}`);
	line(`cwd: ${process.cwd()}`);
	line(`mode: ${mode}`);

	if (mode === "all" || mode === "install") printInstall();
	if (mode === "all" || mode === "config") printConfig();
	if (mode === "all" || mode === "sessions") printSessions();
	if (mode === "all" || mode === "logs") printLogs();
	if (mode === "all" || mode === "cache") printCache();
	if (mode === "timeline") printTimeline(modeArgs);

	section("NEXT CHECKS");
	line("Use /omlx-status for live in-Pi active session state.");
	line("Use `mise run debug:omlx` for OMLX model settings, model files, templates, and OMLX cache state.");
	line("Use `mise run debug:pi -- timeline [session-id|session-file|iso-time]` for a tight Pi+OMLX event window.");
}

function printInstall(): void {
	section("INSTALL");
	const piBins = findAllOnPath("pi");
	line(`pi binaries: ${piBins.length > 0 ? piBins.join(", ") : "(not found on PATH)"}`);
	pathSummary("~/.pi", PI_HOME);
	line(`~/.pi realpath: ${safeRealpath(PI_HOME) ?? "(missing)"}`);
	gitSummary("~/.pi git", PI_HOME);
	pathSummary("installed package", INSTALLED_PACKAGE);
	line(`installed package realpath: ${safeRealpath(INSTALLED_PACKAGE) ?? "(missing)"}`);
	line(`repo realpath: ${safeRealpath(process.cwd()) ?? resolve(process.cwd())}`);
	line(`installed package is this repo: ${safeRealpath(INSTALLED_PACKAGE) === safeRealpath(process.cwd()) ? "yes" : "no"}`);
	fileJsonSummary("installed package.json", join(INSTALLED_PACKAGE, "package.json"), ["name", "version", "description"]);
}

function printConfig(): void {
	section("CONFIG");
	fileJsonSummary("Pi config", PI_CONFIG, ["defaultModel", "model", "models", "providers", "packages", "extensions", "theme"]);
	fileJsonSummary("skills lock", SKILLS_LOCK, ["skills", "packages", "updatedAt"]);
	pathSummary("Pi wiki", join(PI_HOME, "pi-wiki"));
	printLatestFiles("Pi wiki entries", join(PI_HOME, "pi-wiki", "pi"), 8);
}

function printSessions(): void {
	section("SESSIONS");
	pathSummary("session root", SESSION_ROOT);
	const currentSessionDir = sessionDirForCwd(process.cwd());
	pathSummary("current cwd session dir", currentSessionDir);
	printLatestFiles("latest sessions for cwd", currentSessionDir, 8);
	const latest = latestFile(currentSessionDir, ".jsonl");
	if (latest) printSessionSummary(latest);
	printRecentSessionDirs();
}

function printLogs(): void {
	section("LOGS");
	pathSummary("Pi log dir", PI_LOG_DIR);
	printLatestFiles("Pi logs", PI_LOG_DIR, 10);
	pathSummary("package log dir", PACKAGE_LOG_DIR);
	printLatestFiles("package logs", PACKAGE_LOG_DIR, 10);
	printProviderDebugSummary(PACKAGE_DEBUG_LOG);
}

function printCache(): void {
	section("CACHE");
	for (const path of [
		join(PI_HOME, "cache"),
		join(PI_HOME, "agent", "cache"),
		join(HOME, ".cache", "pi"),
		join(HOME, "Library", "Caches", "pi"),
	]) {
		pathSummary(path, path);
	}
}

function printTimeline(args: string[]): void {
	section("TIMELINE");
	const requestedWindowMinutes = numberArg(args, "--minutes") ?? 3;
	const anchorInput = firstNonFlag(args);
	const anchor = resolveTimelineAnchor(anchorInput);
	if (!anchor) {
		line("no anchor found; pass a session id, session file path, or ISO timestamp");
		return;
	}
	if (anchor.note) line(anchor.note);
	line(`anchor: ${anchor.date.toISOString()} (${formatLocal(anchor.date)} local)`);

	const providerRows = readProviderRows(PACKAGE_DEBUG_LOG);
	const request = findProviderRequest(providerRows, anchor.date) ?? latestProviderRequest(providerRows);
	if (!request) {
		line("no provider request found in provider-debug.log");
		return;
	}
	const requestDate = parseIso(stringValue(request.ts));
	const correlationId = stringValue(request.correlationId);
	if (!requestDate) {
		line("provider request has no parseable timestamp");
		return;
	}

	const start = new Date(requestDate.getTime() - 60_000);
	const end = new Date(requestDate.getTime() + requestedWindowMinutes * 60_000);
	line(`request: ${requestDate.toISOString()} (${formatLocal(requestDate)} local)`);
	if (correlationId) line(`correlationId: ${correlationId}`);
	const payload = asObject(request.payload);
	if (payload) {
		line(
			`payload: model=${stringValue(request.model) ?? "?"}, messages=${stringValue(payload.messageCount) ?? "?"}, chars=${
				stringValue(payload.messageChars) ?? "?"
			}, max_tokens=${stringValue(payload.max_tokens) ?? "?"}, stream=${stringValue(payload.stream) ?? "?"}`,
		);
		const preview = stringValue(payload.lastMessagePreview);
		if (preview) line(`preview: ${preview.slice(0, 360).replace(/\s+/g, " ")}`);
	}
	line(`window: ${start.toISOString()} .. ${end.toISOString()} (${requestedWindowMinutes}m after request)`);

	printProviderTimeline(providerRows, start, end, correlationId);
	printOmlxTimeline(start, end);
	printChangedFilesTimeline(start, end);
}

function printProviderTimeline(rows: JsonObject[], start: Date, end: Date, correlationId: string | undefined): void {
	console.log("\n[provider events]");
	const selected = rows.filter((row) => {
		const date = parseIso(stringValue(row.ts));
		if (!date || date < start || date > end) return false;
		const kind = stringValue(row.kind) ?? "";
		return (
			!correlationId ||
			stringValue(row.correlationId) === correlationId ||
			["extension_load", "session_start", "native_thinking_applied", "catalog_status_loaded"].includes(kind)
		);
	});
	if (selected.length === 0) {
		line("none");
		return;
	}
	for (const row of selected) {
		const bits = [
			stringValue(row.ts) ?? "?",
			stringValue(row.kind) ?? "?",
			stringValue(row.correlationId),
			stringValue(row.model),
			stringValue(asObject(row.message)?.stopReason),
			stringValue(row.status),
		].filter(Boolean);
		line(bits.join(" "));
	}
	const hasTerminal = selected.some((row) =>
		["message_update", "assistant_message_metrics", "turn_end", "tool_call"].includes(stringValue(row.kind) ?? ""),
	);
	if (!hasTerminal) line("diagnosis: provider opened request but no assistant/tool/turn progress was logged in this window");
}

function printOmlxTimeline(start: Date, end: Date): void {
	console.log("\n[OMLX server events]");
	if (!existsSync(OMLX_SERVER_LOG)) {
		line(`missing: ${OMLX_SERVER_LOG}`);
		return;
	}
	const patterns =
		/chat\/completions|Chat completion request|Sampling params|Cache hit|Loaded block|Walk-back|Reconstructed cache|partial cache hit|Added request|Scheduled request|SpecPrefill|Prefill|Aborting request|Aborted request|ERROR|WARNING|Traceback|Exception/i;
	const lines = readFileSync(OMLX_SERVER_LOG, "utf8").split(/\r?\n/).filter(Boolean);
	let printed = 0;
	const requestIds = new Set<string>();
	for (const text of lines) {
		const date = parseOmlxLocalDate(text);
		if (!date || date < start || date > end || !patterns.test(text)) continue;
		line(text.length > 900 ? `${text.slice(0, 900)}...` : text);
		for (const id of extractUuids(text)) requestIds.add(id);
		printed++;
		if (printed >= 80) {
			line("truncated after 80 matching OMLX lines");
			break;
		}
	}
	if (printed === 0) line("none");
	printOmlxRequestLifecycles(lines, requestIds);
	if (!lines.some((text) => {
		const date = parseOmlxLocalDate(text);
		return Boolean(date && date >= start && date <= end && /Scheduled request|SpecPrefill|Aborted request|ERROR|Traceback|Exception/i.test(text));
	})) {
		line("diagnosis: OMLX log has no scheduler progress, abort, or exception after the request enqueue in this window");
	}
}

function printOmlxRequestLifecycles(lines: string[], requestIds: Set<string>): void {
	if (requestIds.size === 0) return;
	console.log("\n[OMLX exact request-id lifecycle]");
	for (const id of requestIds) {
		const matching = lines.filter((text) => text.includes(id));
		line(`request ${id}: ${matching.length} log line(s)`);
		for (const text of matching.slice(0, 40)) line(text.length > 900 ? `${text.slice(0, 900)}...` : text);
		if (matching.length > 40) line(`request ${id}: truncated after 40 lines`);
		const lifecycle = matching.map(classifyOmlxLine).filter(Boolean);
		line(`request ${id} lifecycle: ${lifecycle.length > 0 ? lifecycle.join(" -> ") : "(no classified lifecycle events)"}`);
		if (!matching.some((text) => /Scheduled request|SpecPrefill|Aborted request|ERROR|Traceback|Exception|Generated|Finished|completed/i.test(text))) {
			line(`request ${id} diagnosis: discovered by timestamp, then exact-id search found enqueue/cache lines only`);
		}
	}
}

function classifyOmlxLine(text: string): string | undefined {
	if (/Incoming POST .*chat\/completions/.test(text)) return "incoming";
	if (/Chat completion request received/.test(text)) return "parsed";
	if (/Sampling params/.test(text)) return "sampling";
	if (/Cache hit/.test(text)) return "cache-hit";
	if (/Walk-back truncation/.test(text)) return "cache-walkback";
	if (/partial cache hit/.test(text)) return "partial-cache";
	if (/Added request/.test(text)) return "enqueue";
	if (/Scheduled request/.test(text)) return "scheduled";
	if (/SpecPrefill/.test(text)) return "spec-prefill";
	if (/Aborting request/.test(text)) return "aborting";
	if (/Aborted request/.test(text)) return "aborted";
	if (/ERROR|Traceback|Exception/.test(text)) return "error";
	return undefined;
}

function extractUuids(text: string): string[] {
	return [...text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((match) => match[0]);
}

function printChangedFilesTimeline(start: Date, end: Date): void {
	console.log("\n[changed files in window]");
	const roots = [
		OMLX_HOME,
		join(OMLX_HOME, "cache"),
		join(OMLX_HOME, "logs"),
		SESSION_ROOT,
		PACKAGE_LOG_DIR,
	].filter((path, index, all) => existsSync(path) && all.indexOf(path) === index);
	const files = roots.flatMap((root) => recentFiles(root, start, end, 5));
	const unique = [...new Map(files.map((file) => [file.path, file])).values()]
		.sort((a, b) => a.mtime.getTime() - b.mtime.getTime())
		.slice(0, 80);
	if (unique.length === 0) {
		line("none");
		return;
	}
	for (const file of unique) line(`${file.mtime.toISOString()} ${formatBytes(file.size)} ${file.path}`);
}

function resolveTimelineAnchor(input: string | undefined): { date: Date; note?: string } | undefined {
	if (!input) {
		const latest = latestProviderRequest(readProviderRows(PACKAGE_DEBUG_LOG));
		const date = parseIso(stringValue(latest?.ts));
		return date ? { date, note: "anchor source: latest provider request" } : undefined;
	}
	if (existsSync(input)) {
		const date = dateFromSessionPath(input) ?? safeStat(input)?.mtime;
		return date ? { date, note: `anchor source: file ${input}` } : undefined;
	}
	const directDate = parseLooseDate(input);
	if (directDate) return { date: directDate, note: `anchor source: timestamp ${input}` };
	const found = findSessionFileById(input);
	if (found) {
		const date = dateFromSessionPath(found) ?? safeStat(found)?.mtime;
		return date ? { date, note: `anchor source: session file ${found}` } : undefined;
	}
	const uuidPrefix = input.slice(0, 8);
	const providerRows = readProviderRows(PACKAGE_DEBUG_LOG);
	const nearId = providerRows.find((row) => JSON.stringify(row).includes(input) || JSON.stringify(row).includes(uuidPrefix));
	const date = parseIso(stringValue(nearId?.ts));
	if (date) return { date, note: `anchor source: provider log match for ${input}` };
	return undefined;
}

function findProviderRequest(rows: JsonObject[], anchor: Date): JsonObject | undefined {
	return rows.find((row) => {
		if (row.kind !== "before_provider_request") return false;
		const date = parseIso(stringValue(row.ts));
		return Boolean(date && date >= anchor && date.getTime() - anchor.getTime() <= 10 * 60_000);
	});
}

function latestProviderRequest(rows: JsonObject[]): JsonObject | undefined {
	return rows.filter((row) => row.kind === "before_provider_request").at(-1);
}

function readProviderRows(path: string): JsonObject[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map(parseLogLine)
		.filter((entry): entry is JsonObject => Boolean(entry));
}

function findSessionFileById(id: string): string | undefined {
	if (!existsSync(SESSION_ROOT)) return undefined;
	const stack = [SESSION_ROOT];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;
		for (const name of safeReadDir(dir)) {
			const path = join(dir, name);
			const stat = safeStat(path);
			if (!stat) continue;
			if (stat.isDirectory()) stack.push(path);
			else if (name.includes(id) || (name.endsWith(".jsonl") && fileContains(path, id))) return path;
		}
	}
	return undefined;
}

function fileContains(path: string, needle: string): boolean {
	try {
		return readFileSync(path, "utf8").includes(needle);
	} catch {
		return false;
	}
}

function dateFromSessionPath(path: string): Date | undefined {
	const match = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_/.exec(path);
	if (!match) return undefined;
	return parseIso(match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z"));
}

function parseLooseDate(value: string): Date | undefined {
	const iso = parseIso(value);
	if (iso) return iso;
	const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?$/.exec(value);
	if (!local) return undefined;
	const date = new Date(
		`${local[1]}T${local[2]}:${local[3]}:${local[4] ?? "00"}.${(local[5] ?? "0").padEnd(3, "0")}`,
	);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseIso(value: string | undefined): Date | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseOmlxLocalDate(lineText: string): Date | undefined {
	const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3})/.exec(lineText);
	if (!match) return undefined;
	const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}`);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function recentFiles(root: string, start: Date, end: Date, maxDepth: number): Array<{ path: string; mtime: Date; size: number }> {
	const out: Array<{ path: string; mtime: Date; size: number }> = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > maxDepth) return;
		for (const name of safeReadDir(dir)) {
			if ([".git", "node_modules", "references", "omlx-wiki"].includes(name)) continue;
			const path = join(dir, name);
			const stat = safeStat(path);
			if (!stat) continue;
			if (stat.isDirectory()) {
				walk(path, depth + 1);
				continue;
			}
			if (stat.mtime >= start && stat.mtime <= end) out.push({ path, mtime: stat.mtime, size: stat.size });
		}
	};
	const stat = safeStat(root);
	if (!stat) return out;
	if (stat.isFile()) {
		if (stat.mtime >= start && stat.mtime <= end) out.push({ path: root, mtime: stat.mtime, size: stat.size });
		return out;
	}
	walk(root, 0);
	return out;
}

function numberArg(args: string[], name: string): number | undefined {
	const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
	const raw = prefixed ? prefixed.slice(name.length + 1) : undefined;
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function firstNonFlag(args: string[]): string | undefined {
	return args.find((arg) => !arg.startsWith("--"));
}

function formatLocal(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(
		date.getHours(),
	).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function printSessionSummary(path: string): void {
	console.log(`\n[session summary: ${path}]`);
	const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
	const entries = lines.map(parseJson).filter((value): value is JsonObject => Boolean(asObject(value)));
	const header = asObject(entries.find((entry) => entry.type === "session"));
	line(`lines: ${lines.length}`);
	if (header) {
		line(`id: ${stringValue(header.id) ?? "(missing)"}`);
		line(`version: ${stringValue(header.version) ?? "(missing)"}`);
		line(`cwd: ${stringValue(header.cwd) ?? "(missing)"}`);
		line(`timestamp: ${stringValue(header.timestamp) ?? "(missing)"}`);
		if (header.parentSession) line(`parentSession: ${stringValue(header.parentSession)}`);
	}
	printCounts("entry types", entries.map((entry) => stringValue(entry.type) ?? "(unknown)"));
	const messages = entries
		.map((entry) => asObject(entry.message))
		.filter((message): message is JsonObject => Boolean(message));
	printCounts("message roles", messages.map((message) => stringValue(message.role) ?? "(unknown)"));
	const assistantStops = messages
		.filter((message) => message.role === "assistant")
		.map((message) => stringValue(message.stopReason))
		.filter((value): value is string => Boolean(value));
	printCounts("assistant stop reasons", assistantStops);
	const latestModels = entries
		.filter((entry) => entry.type === "model_change")
		.slice(-5)
		.map((entry) => `${stringValue(entry.provider) ?? "?"}/${stringValue(entry.modelId) ?? "?"}`);
	if (latestModels.length > 0) line(`recent model changes: ${latestModels.join(" -> ")}`);
	const customMessages = messages.filter((message) => message.role === "custom");
	if (customMessages.length > 0) line(`custom messages: ${customMessages.length}`);
	const statusMessages = customMessages.filter((message) => message.customType === "omlx-status");
	if (statusMessages.length > 0) line(`omlx-status messages: ${statusMessages.length}`);
}

function printRecentSessionDirs(): void {
	if (!existsSync(SESSION_ROOT)) return;
	const dirs = readdirSync(SESSION_ROOT)
		.map((name) => join(SESSION_ROOT, name))
		.filter((path) => safeStat(path)?.isDirectory())
		.sort((a, b) => (safeStat(b)?.mtimeMs ?? 0) - (safeStat(a)?.mtimeMs ?? 0))
		.slice(0, 8);
	console.log("\n[recent session dirs]");
	for (const dir of dirs) pathSummary(dir, dir);
}

function printProviderDebugSummary(path: string): void {
	console.log(`\n[provider debug summary]`);
	if (!existsSync(path)) {
		line(`missing: ${path}`);
		return;
	}
	pathSummary("provider debug log", path);
	const entries = tailLines(path, 700)
		.map(parseLogLine)
		.filter((entry): entry is JsonObject => Boolean(entry));
	if (entries.length === 0) {
		line("no parseable JSON log lines in last 700 lines");
		return;
	}
	printCounts("recent kinds", entries.map((entry) => stringValue(entry.kind) ?? "(unknown)"), 12);
	const modelEvents = entries
		.filter((entry) => ["session_start", "model_select", "before_provider_request", "turn_end"].includes(stringValue(entry.kind) ?? ""))
		.map((entry) => `${stringValue(entry.kind) ?? "?"}:${stringValue(entry.model) ?? stringValue(entry.selected) ?? "?"}`)
		.slice(-16);
	if (modelEvents.length > 0) {
		line("recent runtime events:");
		for (const event of modelEvents) line(`- ${event}`);
	}
}

function printLatestFiles(label: string, dir: string, limit: number): void {
	console.log(`\n[${label}]`);
	if (!existsSync(dir)) {
		line(`missing: ${dir}`);
		return;
	}
	const files = readdirSync(dir)
		.map((name) => join(dir, name))
		.filter((path) => safeStat(path)?.isFile())
		.sort((a, b) => (safeStat(b)?.mtimeMs ?? 0) - (safeStat(a)?.mtimeMs ?? 0))
		.slice(0, limit);
	if (files.length === 0) line("no files");
	for (const file of files) pathSummary(file, file);
}

function fileJsonSummary(label: string, path: string, keys: string[]): void {
	pathSummary(label, path);
	const json = asObject(parseJsonFile(path));
	if (!json) return;
	for (const key of keys) {
		if (!(key in json)) continue;
		const value = json[key];
		if (isSecretKey(key)) continue;
		line(`${key}: ${summarizeValue(value)}`);
	}
}

function pathSummary(label: string, path: string): void {
	if (!existsSync(path)) {
		line(`${label}: missing (${path})`);
		return;
	}
	const stat = safeStat(path);
	if (!stat) {
		line(`${label}: unreadable (${path})`);
		return;
	}
	const link = lstatSync(path).isSymbolicLink() ? ` -> ${safeRealpath(path) ?? "unresolved"}` : "";
	const kind = stat.isDirectory() ? `${safeReadDir(path).length} entries` : formatBytes(stat.size);
	line(`${label}: ${path}${link} (${kind}, mtime ${stat.mtime.toISOString()})`);
}

function gitSummary(label: string, cwd: string): void {
	if (!existsSync(join(cwd, ".git"))) {
		line(`${label}: no .git`);
		return;
	}
	const branch = safeExec("git", ["-C", cwd, "branch", "--show-current"]);
	const commit = safeExec("git", ["-C", cwd, "rev-parse", "--short", "HEAD"]);
	const dirty = safeExec("git", ["-C", cwd, "status", "--short"]);
	line(`${label}: branch=${branch || "(detached)"} commit=${commit || "(unknown)"} dirty=${dirty ? "yes" : "no"}`);
}

function sessionDirForCwd(cwd: string): string {
	const normalized = resolve(cwd).split("/").filter(Boolean).join("-");
	return join(SESSION_ROOT, `--${normalized}--`);
}

function latestFile(dir: string, extension: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	return readdirSync(dir)
		.map((name) => join(dir, name))
		.filter((path) => path.endsWith(extension) && safeStat(path)?.isFile())
		.sort((a, b) => (safeStat(b)?.mtimeMs ?? 0) - (safeStat(a)?.mtimeMs ?? 0))[0];
}

function printCounts(label: string, values: string[], limit = 20): void {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	if (counts.size === 0) return;
	line(`${label}:`);
	for (const [value, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
		line(`- ${value}: ${count}`);
	}
}

function parseJsonFile(path: string): unknown {
	if (!existsSync(path)) return undefined;
	return parseJson(readFileSync(path, "utf8"));
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function parseLogLine(lineText: string): JsonObject | undefined {
	const parsed = asObject(parseJson(lineText));
	if (parsed) return parsed;
	const jsonStart = lineText.indexOf("{");
	if (jsonStart < 0) return undefined;
	return asObject(parseJson(lineText.slice(jsonStart)));
}

function tailLines(path: string, maxLines: number): string[] {
	return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines);
}

function findAllOnPath(name: string): string[] {
	const found: string[] = [];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(dir, name);
		if (existsSync(candidate) && !found.includes(candidate)) found.push(candidate);
	}
	return found;
}

function safeExec(file: string, args: string[]): string | undefined {
	try {
		return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function safeStat(path: string) {
	try {
		return statSync(path);
	} catch {
		return undefined;
	}
}

function safeReadDir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

function safeRealpath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function asObject(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function summarizeValue(value: unknown): string {
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (asObject(value)) return `{${Object.keys(value as JsonObject).length} keys}`;
	if (typeof value === "string") return value.includes("key") || value.length > 120 ? "(redacted or long string)" : value;
	return String(value);
}

function isSecretKey(key: string): boolean {
	return /key|token|secret|password/i.test(key);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function section(title: string): void {
	console.log(`\n== ${title} ==`);
}

function line(value: string): void {
	console.log(value);
}

main();
