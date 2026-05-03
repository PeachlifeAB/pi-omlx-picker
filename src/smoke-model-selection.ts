export type SmokeStatusModel = {
	id?: string;
	thinking_default?: boolean | null;
	loaded?: boolean;
	engine_type?: string | null;
	model_type?: string | null;
	estimated_size?: number;
	forced_ct_kwargs?: string[];
};

export function selectNonThinkingSmokeModel(
	models: SmokeStatusModel[],
): string | undefined {
	const nonThinkingModels = models.filter(
		(model) =>
			model.thinking_default === false || model.thinking_default === null,
	);
	return (
		selectBestSmokeModel(nonThinkingModels.filter(isChatSmokeModel)) ??
		selectFirstSmokeModel(nonThinkingModels)
	);
}

function isChatSmokeModel(model: SmokeStatusModel): boolean {
	return model.engine_type === "batched" || model.model_type === "llm";
}

function selectFirstSmokeModel(models: SmokeStatusModel[]): string | undefined {
	return models.find(
		(model): model is SmokeStatusModel & { id: string } =>
			typeof model.id === "string",
	)?.id;
}

function selectBestSmokeModel(models: SmokeStatusModel[]): string | undefined {
	return models
		.filter(
			(model): model is SmokeStatusModel & { id: string } =>
				typeof model.id === "string",
		)
		.slice()
		.sort((a, b) => {
			const loadedA = a.loaded === true ? 0 : 1;
			const loadedB = b.loaded === true ? 0 : 1;
			if (loadedA !== loadedB) return loadedA - loadedB;

			const sizeA =
				typeof a.estimated_size === "number"
					? a.estimated_size
					: Number.POSITIVE_INFINITY;
			const sizeB =
				typeof b.estimated_size === "number"
					? b.estimated_size
					: Number.POSITIVE_INFINITY;
			if (sizeA !== sizeB) return sizeA - sizeB;

			return a.id.localeCompare(b.id);
		})[0]?.id;
}
