import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildLabels, sortModels } from "../src/labels.ts";

const models = [{ id: "zebra" }, { id: "alpha" }, { id: "mango" }];

test("sortModels puts active first, then alphabetical", () => {
	const sorted = sortModels(models, "mango");
	assert.deepEqual(sorted.map((m) => m.id), ["mango", "alpha", "zebra"]);
});

test("sortModels pure-alphabetical when no active", () => {
	const sorted = sortModels(models, undefined);
	assert.deepEqual(sorted.map((m) => m.id), ["alpha", "mango", "zebra"]);
});

test("buildLabels marks active with [active] prefix", () => {
	const labels = buildLabels(models, "mango");
	assert.deepEqual(labels, [
		{ label: "[active] mango", id: "mango" },
		{ label: "alpha", id: "alpha" },
		{ label: "zebra", id: "zebra" },
	]);
});

test("buildLabels has no prefix when no active model", () => {
	const labels = buildLabels(models, undefined);
	assert.ok(labels.every((l) => !l.label.startsWith("[")));
});
