import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeType, planPropertyTypes, TASK_PROPERTY_TYPES } from "../src/propertyTypes.ts";
import { reconcile, seenFrom, SeenTask } from "../src/reconcile.ts";
import { StatusFlag } from "../src/statusFlags.ts";
import { TaskAttribute } from "../src/attributes.ts";
import { applyTaskToFrontmatter, taskFromFrontmatter } from "../src/task.ts";

const TODAY = "2026-10-27";
const waiting: StatusFlag = { id: "waiting", label: "Waiting", icon: "⏳", base: "hold" };
const cancelled: StatusFlag = { id: "cancelled", label: "Cancelled", icon: "✖️", base: "done" };
const inProgress: StatusFlag = { id: "in-progress", label: "In progress", icon: "▶️", base: "todo" };
const FLAGS = [waiting, cancelled, inProgress];
const seen = (p: Partial<SeenTask>): SeenTask => ({ status: "todo", flag: null, completed: null, recurring: false, ...p });

test("planPropertyTypes: unassigned names get the Planner's type; completed's yes/no becomes a date; other choices stand", () => {
  const assigned: Record<string, string> = { completed: "checkbox", tags: "tags", priority: "number", due: "date" };
  const cost: TaskAttribute = { key: "Cost", label: "Cost", icon: "💷", kind: "number", onRow: true };
  const plan = planPropertyTypes((n) => assigned[n.toLowerCase()] ?? null, [cost]);
  const set = Object.fromEntries(plan.changes.map((c) => [c.name, [c.from, c.to]]));
  assert.deepEqual(set.completed, ["checkbox", "date"]);
  assert.deepEqual(set.scheduled, [null, "date"]);
  assert.deepEqual(set.contexts, [null, "multitext"]);
  assert.deepEqual(set.estimate, [null, "number"]);
  assert.deepEqual(set.Cost, [null, "number"]);
  assert.equal("due" in set, false); // already right
  assert.deepEqual(plan.conflicts, [{ name: "priority", assigned: "number", wanted: "text" }]); // the user's own choice, left alone
  assert.equal(attributeType({ kind: "bool" }), "checkbox");
  assert.equal(attributeType({ kind: "link" }), "text");
  assert.equal(TASK_PROPERTY_TYPES.timer_started, "datetime");
});

test("seenFrom: read the way the Planner reads it — yes/no and empty completed are not dates", () => {
  assert.deepEqual(seenFrom({ status: "Done", completed: "2026-10-26T09:00", recurrence: "FREQ=DAILY", flag: "" }), { status: "done", flag: null, completed: "2026-10-26", recurring: true });
  assert.deepEqual(seenFrom({ status: "weird", completed: true }), { status: "todo", flag: null, completed: null, recurring: false });
});

test("reconcile: nothing for an untouched note, a first sighting, or the Planner's own consistent writes", () => {
  assert.equal(reconcile(undefined, seen({ status: "done" }), FLAGS, TODAY), null);
  assert.equal(reconcile(seen({}), seen({}), FLAGS, TODAY), null);
  assert.equal(reconcile(seen({}), seen({ status: "done", completed: "2026-10-27" }), FLAGS, TODAY), null); // ticked by the Planner
  assert.equal(reconcile(seen({}), seen({ status: "hold", flag: "waiting" }), FLAGS, TODAY), null); // flagged by the Planner
});

test("reconcile: done by hand gets its date; opened again loses it; a repeating task moves on", () => {
  assert.deepEqual(reconcile(seen({}), seen({ status: "done" }), FLAGS, TODAY), { kind: "write", completed: TODAY });
  assert.deepEqual(reconcile(seen({ status: "done", completed: "2026-10-20" }), seen({ status: "todo", completed: "2026-10-20" }), FLAGS, TODAY), { kind: "write", completed: null });
  assert.deepEqual(reconcile(seen({ recurring: true }), seen({ status: "done", recurring: true }), FLAGS, TODAY), { kind: "occurrence" });
  // The Planner ending a series writes done with its date: not an occurrence to tick.
  assert.equal(reconcile(seen({ recurring: true }), seen({ status: "done", completed: TODAY, recurring: true }), FLAGS, TODAY), null);
});

test("reconcile: a flag picked by hand brings its status; a status moved from under a flag drops the flag", () => {
  assert.deepEqual(reconcile(seen({}), seen({ flag: "waiting" }), FLAGS, TODAY), { kind: "write", status: "hold" });
  assert.deepEqual(reconcile(seen({}), seen({ flag: "cancelled" }), FLAGS, TODAY), { kind: "write", status: "done", completed: TODAY });
  assert.deepEqual(reconcile(seen({ recurring: true }), seen({ flag: "cancelled", recurring: true }), FLAGS, TODAY), { kind: "write", flag: null });
  assert.deepEqual(reconcile(seen({ status: "hold", flag: "waiting" }), seen({ status: "todo", flag: "waiting" }), FLAGS, TODAY), { kind: "write", flag: null });
  assert.deepEqual(reconcile(seen({ flag: "in-progress" }), seen({ status: "done", flag: "in-progress" }), FLAGS, TODAY), { kind: "write", completed: TODAY, flag: null });
  assert.equal(reconcile(seen({}), seen({ flag: "unknown-one" }), FLAGS, TODAY), null);
});

test("applyTaskToFrontmatter writes empty dates as empty, not as text, and reopening clears completed", () => {
  const fm: Record<string, unknown> = { status: "done", completed: "2026-10-20", scheduled: "", due: "" };
  const t = taskFromFrontmatter(fm, "t.md", "t");
  applyTaskToFrontmatter(fm, { ...t, status: "todo", completed: null });
  assert.equal(fm.scheduled, null);
  assert.equal(fm.due, null);
  assert.equal(fm.completed, null);
  applyTaskToFrontmatter(fm, { ...t, status: "done", completed: "2026-10-27" });
  assert.equal(fm.completed, "2026-10-27");
});

// ── The starter Base ─────────────────────────────────────────────────────────

import { tasksBaseYaml } from "../src/basesTemplate.ts";

test("tasksBaseYaml: the settings' folders, plain-named attributes as columns, expressions quoted", () => {
  const yaml = tasksBaseYaml({
    itemsFolder: "Tasks/Items",
    routinesFolder: "Tasks/Routines",
    attributes: [
      { key: "cost", label: "Cost", icon: "💷", kind: "number", onRow: true },
      { key: "Needs parts", label: "Needs parts", icon: "🔧", kind: "bool", onRow: true },
    ],
  });
  assert.match(yaml, /- 'file\.inFolder\("Tasks\/Items"\)'/);
  assert.match(yaml, /- 'file\.inFolder\("Tasks\/Routines"\)'/);
  assert.match(yaml, /overdue: 'if\(status != "done" && due && due < today\(\), "⚠️ overdue", ""\)'/);
  assert.match(yaml, /\n  cost:\n    displayName: "Cost"/);
  assert.doesNotMatch(yaml, /Needs parts/); // a name Bases can't take as it stands
  assert.equal((yaml.match(/^  - type: /gm) ?? []).length, 6);
  assert.match(yaml, /- 'completed >= today\(\) - "7d"'/);
});
