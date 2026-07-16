const DEBUG_ENV = "PI_OMLX_PICKER_DEBUG";

function redact(value: string): string {
	return value
		.replace(
			/(authorization|api[_-]?key|bearer)\s*[:=]\s*[^\s,;]+/gi,
			"$1=[REDACTED]",
		)
		.slice(0, 500);
}

// Opt-in, local smoke-only trace. It records provider-path transitions and
// error normalization without model payloads, prompts, or credentials.
export function pickerDebug(
	event: string,
	data?: Record<string, unknown>,
): void {
	if (!process.env[DEBUG_ENV]) return;
	const safe = data
		? Object.fromEntries(
				Object.entries(data).map(([key, value]) => [
					key,
					typeof value === "string" ? redact(value) : value,
				]),
			)
		: undefined;
	process.stderr.write(
		`[pi-omlx-picker] ${event}${safe ? ` ${JSON.stringify(safe)}` : ""}\n`,
	);
}
