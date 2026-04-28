export function parseDotenv(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of content.split("\n")) {
		const line = rawLine.replace(/\r$/, "").trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		let key = line.slice(0, eq).trim();
		if (key.startsWith("export ")) key = key.slice(7).trim();
		if (!key) continue;
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
				value = value.slice(1, -1);
			}
		}
		out[key] = value;
	}
	return out;
}

export function mergeDotenv(parsed: Record<string, string>, env: NodeJS.ProcessEnv = process.env): void {
	for (const [k, v] of Object.entries(parsed)) {
		const existing = env[k];
		if (existing === undefined || existing === "") env[k] = v;
	}
}
