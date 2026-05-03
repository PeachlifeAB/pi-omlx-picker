import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	buildTaskBudgetSteer,
	getTaskBudgetRemainingTokens,
	recordTaskBudgetUsage,
	resetTaskBudget,
} from "../src/task-budget.ts";

test("resetTaskBudget initializes configured model budget", () => {
	const state = resetTaskBudget({ id: "m1", taskBudgetTokens: 1000 });

	assert.equal(state.modelId, "m1");
	assert.equal(state.totalTokens, 1000);
	assert.equal(state.usedOutputTokens, 0);
	assert.equal(state.warned20Percent, false);
	assert.equal(state.warned5Percent, false);
});

test("recordTaskBudgetUsage accumulates output tokens", () => {
	const first = resetTaskBudget({ id: "m1", taskBudgetTokens: 1000 });
	const second = recordTaskBudgetUsage(first, 250).state;
	const third = recordTaskBudgetUsage(second, 125).state;

	assert.equal(third.usedOutputTokens, 375);
	assert.equal(getTaskBudgetRemainingTokens(third), 625);
});

test("recordTaskBudgetUsage emits 20 percent steer once", () => {
	const start = resetTaskBudget({ id: "m1", taskBudgetTokens: 1000 });
	const first = recordTaskBudgetUsage(start, 800);
	const second = recordTaskBudgetUsage(first.state, 1);

	assert.equal(first.warning, "20_percent");
	assert.equal(first.state.warned20Percent, true);
	assert.equal(second.warning, undefined);
	assert.match(buildTaskBudgetSteer(first.state, first.warning!), /task budget low/i);
});

test("recordTaskBudgetUsage emits 5 percent steer once and marks 20 percent warned", () => {
	const start = resetTaskBudget({ id: "m1", taskBudgetTokens: 1000 });
	const first = recordTaskBudgetUsage(start, 950);
	const second = recordTaskBudgetUsage(first.state, 1);

	assert.equal(first.warning, "5_percent");
	assert.equal(first.state.warned5Percent, true);
	assert.equal(first.state.warned20Percent, true);
	assert.equal(second.warning, undefined);
	assert.match(buildTaskBudgetSteer(first.state, first.warning!), /critical/i);
});

test("resetTaskBudget resets usage on model switch", () => {
	const start = resetTaskBudget({ id: "m1", taskBudgetTokens: 1000 });
	const used = recordTaskBudgetUsage(start, 900).state;
	const switched = resetTaskBudget({ id: "m2", taskBudgetTokens: 2000 });

	assert.equal(used.usedOutputTokens, 900);
	assert.equal(switched.modelId, "m2");
	assert.equal(switched.totalTokens, 2000);
	assert.equal(switched.usedOutputTokens, 0);
	assert.equal(switched.warned20Percent, false);
	assert.equal(switched.warned5Percent, false);
});
