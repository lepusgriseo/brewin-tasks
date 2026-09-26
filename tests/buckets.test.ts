import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, groupByDate, groupByContext } from "../src/buckets.ts";
import { Task } from "../src/types.ts";
import { completeRecurringOccurrence } from "../src/recurrence.ts";

const TODAY = "2026-07-24";

function mk(partial: Partial<Task>): Task {
  return {
    path: (partial.title ?? "t") + ".md",
    title: partial.title ?? "t",
    status: "todo",
    scheduled: null,
    due: null,
    priority: "normal",
    contexts: [],
    recurrence: null,
    recurrenceAnchor: "scheduled",
    completeInstances: [],
    onCompletion: "keep",
    created: TODAY,
    completed: null,
    ...partial,
  };
}

test("bucket classification", () => {
  const tasks = [
    mk({ title: "overdue", due: "2026-07-20" }),
    mk({ title: "todayByScheduled", scheduled: "2026-07-24" }),
    mk({ title: "pastScheduledStillToday", scheduled: "2026-07-10" }),
    mk({ title: "upcoming", scheduled: "2026-07-30" }),
    mk({ title: "unplanned" }),
    mk({ title: "onhold", status: "hold", scheduled: "2026-07-24" }),
    mk({ title: "done", status: "done" }),
  ];
  const b = classify(tasks, TODAY);
  assert.deepEqual(b.overdue.map((t) => t.title), ["overdue"]);
  assert.deepEqual(b.today.map((t) => t.title).sort(), ["pastScheduledStillToday", "todayByScheduled"]);
  assert.deepEqual(b.upcoming.map((t) => t.title), ["upcoming"]);
  assert.deepEqual(b.unplanned.map((t) => t.title), ["unplanned"]);
  assert.deepEqual(b.onhold.map((t) => t.title), ["onhold"]);
});

test("overdue takes precedence over a future scheduled date", () => {
  const b = classify([mk({ title: "x", due: "2026-07-01", scheduled: "2026-08-01" })], TODAY);
  assert.equal(b.overdue.length, 1);
  assert.equal(b.upcoming.length, 0);
});

test("today sorts high priority first", () => {
  const b = classify(
    [
      mk({ title: "lo", scheduled: TODAY, priority: "low" }),
      mk({ title: "hi", scheduled: TODAY, priority: "high" }),
    ],
    TODAY
  );
  assert.deepEqual(b.today.map((t) => t.title), ["hi", "lo"]);
});

test("groupByDate orders ascending", () => {
  const groups = groupByDate([
    mk({ title: "b", scheduled: "2026-08-02" }),
    mk({ title: "a", scheduled: "2026-08-01" }),
    mk({ title: "a2", scheduled: "2026-08-01" }),
  ]);
  assert.deepEqual(groups.map((g) => g.date), ["2026-08-01", "2026-08-02"]);
  assert.equal(groups[0].tasks.length, 2);
});

test("groupByContext excludes the filtered context and lists tasks under each other one", () => {
  const tasks = [
    mk({ title: "a", contexts: ["obsidian", "work"] }),
    mk({ title: "b", contexts: ["obsidian", "home"] }),
    mk({ title: "c", contexts: ["obsidian"] }), // no OTHER context
    mk({ title: "d", contexts: ["obsidian", "work", "home"] }), // appears under both
  ];
  const groups = groupByContext(tasks, "obsidian");
  // The "@obsidian only" set leads, then the extra contexts alphabetically.
  // "obsidian" itself is never a group.
  assert.deepEqual(groups.map((g) => g.context), [null, "home", "work"]);
  assert.deepEqual(groups[0].tasks.map((t) => t.title), ["c"]); // only @obsidian
  assert.deepEqual(groups[1].tasks.map((t) => t.title), ["b", "d"]);
  assert.deepEqual(groups[2].tasks.map((t) => t.title), ["a", "d"]);
});

test("groupByContext skips done tasks and handles no active filter", () => {
  const tasks = [
    mk({ title: "open", contexts: ["work"] }),
    mk({ title: "finished", status: "done", contexts: ["work"] }),
    mk({ title: "bare" }),
  ];
  const groups = groupByContext(tasks, null);
  assert.deepEqual(groups.map((g) => g.context), ["work", null]);
  assert.deepEqual(groups[0].tasks.map((t) => t.title), ["open"]); // done excluded
  assert.deepEqual(groups[1].tasks.map((t) => t.title), ["bare"]);
});

test("completing a recurring occurrence advances the anchor and logs the instance", () => {
  const t = mk({
    title: "Weekly review",
    recurrence: "DTSTART:20260712;FREQ=WEEKLY;BYDAY=SU",
    scheduled: "2026-07-19",
    recurrenceAnchor: "scheduled",
    onCompletion: "archive",
  });
  const res = completeRecurringOccurrence(t, "2026-07-19", TODAY);
  assert.equal(res.ended, false);
  assert.equal(res.task.scheduled, "2026-07-26");
  assert.ok(res.task.completeInstances.includes("2026-07-19"));
  assert.equal(res.task.status, "todo");
});

test("recurring preserves scheduled↔due gap", () => {
  const t = mk({
    title: "Timecard",
    recurrence: "DTSTART:20260801;FREQ=MONTHLY;BYMONTHDAY=1",
    scheduled: "2026-07-30",
    due: "2026-08-01",
    recurrenceAnchor: "due",
  });
  const res = completeRecurringOccurrence(t, "2026-08-01", TODAY);
  assert.equal(res.task.due, "2026-09-01");
  assert.equal(res.task.scheduled, "2026-08-30"); // gap of 2 days preserved
});
