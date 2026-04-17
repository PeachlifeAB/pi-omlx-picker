import type { OmlxModel } from "./catalog.ts";

export interface LabelledModel {
	label: string;
	id: string;
}

export function buildLabels(models: OmlxModel[], activeId: string | undefined): LabelledModel[] {
	return sortModels(models, activeId).map((m) => ({
		label: m.id === activeId ? `[active] ${m.id}` : m.id,
		id: m.id,
	}));
}

export function sortModels(models: OmlxModel[], activeId: string | undefined): OmlxModel[] {
	const copy = [...models];
	copy.sort((a, b) => {
		if (a.id === activeId && b.id !== activeId) return -1;
		if (b.id === activeId && a.id !== activeId) return 1;
		return a.id.localeCompare(b.id);
	});
	return copy;
}
