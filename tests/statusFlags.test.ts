import { test } from "node:test";
import assert from "node:assert/strict";
import { flagCounts, flagFor, flagId, flagRefusal, moveFlag, sanitizeFlags, StatusFlag, uniqueFlagId } from "../src/statusFlags.ts";
import { applyTaskToFrontmatter, taskFromFrontmatter } from "../src/task.ts";
import { matchesFilter, resolveDrop, suggestFilterName, DashState } from "../src/dashMenu.ts";

const inProgress: StatusFlag = { id: "in-progress", label: "In progress", icon: "▶️", base: "todo" };
const waiting: StatusFlag = { id: "waiting", label: "Waiting on someone", icon: "⏳", base: "hold" };
const cancelled: StatusFlag = { id: "cancelled", label: "Cancelled", icon: "✖️", base: "done" };
const FLAGS = [inProgress, waiting, cancelled];
const TODAY = "2026-10-24";

test("flagId / uniqueFlagId: a slug from the name, never a built-in status or a taken id", () => {
  assert.equal(flagId("Waiting on a reply!"), "waiting-on-a-reply");
  assert.equal(flagId("Café — review"), "cafe-review");
  assert.equal(uniqueFlagId("In progress", []), "in-progress");
  assert.equal(uniqueFlagId("In progress", [inProgress]), "in-progress-2");
  assert.equal(uniqueFlagId("Done", []), "done-2"); // a flag called "done" would read as the real thing
  assert.equal(uniqueFlagId("!!!", []), "flag");
});

test("sanitizeFlags: malformed and repeated entries dropped, a missing base reads as To do", () => {
  const out = sanitizeFlags([
    inProgress,
    { id: "in-progress", label: "Again", icon: "x", base: "hold" },
    { id: "todo", label: "Shadowing a built-in", base: "todo" },
    { id: "Review", label: "", icon: "", base: "nonsense" },
    null,
    "junk",
  ]);
  assert.deepEqual(out, [inProgress, { id: "review", label: "review", icon: "🏷", base: "todo" }]);
  assert.deepEqual(sanitizeFlags(undefined), []);
});

test("taskFromFrontmatter: a flag is read only while the status is the one it stands for", () => {
  const t = (fm: Record<string, unknown>) => taskFromFrontmatter({ tags: ["task"], ...fm }, "x.md", "x", FLAGS);
  assert.equal(t({ status: "todo", flag: "in-progress" }).flag, inProgress);
  assert.equal(t({ status: "hold", flag: "Waiting" }).flag, waiting); // matched without regard to case
  assert.equal(t({ status: "done", flag: "in-progress" }).flag, null); // completed elsewhere: no longer in progress
  assert.equal(t({ status: "todo", flag: "gone-from-settings" }).flag, null);
  assert.equal(taskFromFrontmatter({ status: "todo", flag: "in-progress" }, "x.md", "x").flag, null); // no flags passed
  assert.equal(flagFor(FLAGS, "", "todo"), null);
});

test("applyTaskToFrontmatter: status keeps the built-in value; flag is written while it matches, removed once not", () => {
  const base = taskFromFrontmatter({ status: "hold", flag: "waiting" }, "x.md", "x", FLAGS);
  const fm: Record<string, unknown> = { status: "hold", flag: "waiting" };
  applyTaskToFrontmatter(fm, base);
  assert.equal(fm.status, "hold");
  assert.equal(fm.flag, "waiting");

  // Dropped on Today: To do, and no longer waiting.
  applyTaskToFrontmatter(fm, { ...base, status: "todo" });
  assert.equal(fm.status, "todo");
  assert.equal("flag" in fm, false);

  // Taking a flag off leaves the status alone.
  const fm2: Record<string, unknown> = {};
  applyTaskToFrontmatter(fm2, { ...base, flag: null });
  assert.equal(fm2.status, "hold");
  assert.equal("flag" in fm2, false);
});

test("flagCounts: tasks per flag; a flag standing for Done counts nothing", () => {
  const counts = flagCounts([{ flag: inProgress }, { flag: inProgress }, { flag: waiting }, { flag: cancelled }, {}], FLAGS);
  assert.deepEqual([...counts], [["in-progress", 2], ["waiting", 1], ["cancelled", null]]);
});

test("flagRefusal: not the flag it already has, and no Someday or Done flag for a repeating task", () => {
  assert.match(flagRefusal({ recurrence: null, flag: inProgress }, inProgress)!, /already In progress/);
  assert.equal(flagRefusal({ recurrence: "FREQ=DAILY", flag: null }, waiting), null); // hold is fine
  assert.match(flagRefusal({ recurrence: "FREQ=DAILY", flag: null }, cancelled)!, /repeats/);
  assert.equal(flagRefusal({ recurrence: null, flag: null }, cancelled), null);
});

test("resolveDrop: dropping a task on a flag in the menu flags it, or says why not", () => {
  const task = { status: "todo" as const, scheduled: null, recurrence: null, contexts: [], flag: null };
  assert.deepEqual(resolveDrop("flag:waiting", task, TODAY, 1, FLAGS), { kind: "flag", flag: waiting });
  assert.deepEqual(resolveDrop("flag:waiting", { ...task, flag: waiting, status: "hold" as const }, TODAY, 1, FLAGS), {
    kind: "refuse",
    reason: "is already Waiting on someone",
  });
  assert.equal(resolveDrop("flag:removed", task, TODAY, 1, FLAGS), null);
  assert.equal(resolveDrop("flag:waiting", task, TODAY, 1), null); // no flags known
});

test("saved filters: the flag is part of what a filter matches and how it's named", () => {
  const s: DashState = { view: "all", project: null, context: null, flag: "waiting", query: "", groupBy: "date" };
  assert.equal(matchesFilter(s, s), true);
  assert.equal(matchesFilter({ ...s, flag: null }, s), false);
  // A filter saved before flags existed has no `flag` and still matches an unflagged view.
  const old = { view: "all", project: null, context: null, query: "", groupBy: "date" } as DashState;
  assert.equal(matchesFilter(old, { ...s, flag: null }), true);
  assert.equal(suggestFilterName(s, null, "Waiting on someone"), "All · Waiting on someone");
});

test("moveFlag: up and down a place, nothing off either end", () => {
  assert.deepEqual(moveFlag(FLAGS, "waiting", -1).map((f) => f.id), ["waiting", "in-progress", "cancelled"]);
  assert.deepEqual(moveFlag(FLAGS, "in-progress", -1).map((f) => f.id), ["in-progress", "waiting", "cancelled"]);
  assert.deepEqual(moveFlag(FLAGS, "cancelled", 1).map((f) => f.id), ["in-progress", "waiting", "cancelled"]);
});
