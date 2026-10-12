import assert from "node:assert/strict";
import { test } from "node:test";
import { archivable, daysBetweenISO, isActive, isCarried, isOpen, relativeDay } from "../src/status";
import { Task } from "../src/types";

const TODAY = "2026-10-12"; // a Monday
const mk = (p: Partial<Task>): Task =>
  ({
    path: `00_Systems/Tasks/Items/${p.title ?? "t"}.md`, title: "t", status: "todo", scheduled: null, endDate: null,
    startTime: null, endTime: null, due: null, priority: "normal", estimate: null, remind: null, remindStart: null,
    contexts: [], recurrence: null, recurrenceAnchor: "scheduled", completeInstances: [], exdates: [], times: [],
    completeSlots: {}, onCompletion: "keep", created: null, completed: null, parent: null, dependsOn: [], month: null, week: null,
    ...p,
  }) as Task;

test("open versus active", () => {
  assert.deepEqual(["todo", "hold", "someday", "done"].map((s) => isOpen(mk({ status: s as Task["status"] }))), [true, true, true, false]);
  assert.deepEqual(["todo", "hold", "someday", "done"].map((s) => isActive(mk({ status: s as Task["status"] }))), [true, false, false, false]);
});

test("carried over: planned for a passed day, still to do", () => {
  assert.equal(isCarried(mk({ scheduled: "2026-09-26" }), TODAY), true);
  assert.equal(isCarried(mk({ scheduled: TODAY }), TODAY), false, "today's plan is not carried");
  assert.equal(isCarried(mk({ scheduled: "2026-10-10", endDate: "2026-10-14" }), TODAY), false, "a span still running is today's work");
  assert.equal(isCarried(mk({ scheduled: "2026-09-26", due: "2026-10-01" }), TODAY), false, "a missed deadline is overdue, which is worse");
  assert.equal(isCarried(mk({ scheduled: "2026-09-26", status: "hold" }), TODAY), false);
  assert.equal(isCarried(mk({}), TODAY), false);
});

test("dates said the way they matter", () => {
  assert.equal(relativeDay(TODAY, TODAY), "today");
  assert.equal(relativeDay("2026-10-11", TODAY), "yesterday");
  assert.equal(relativeDay("2026-10-13", TODAY), "tomorrow");
  assert.equal(relativeDay("2026-09-26", TODAY), "16 days ago");
  assert.equal(relativeDay("2026-10-16", TODAY), "Fri");
  assert.equal(relativeDay("2026-10-30", TODAY), "30 Oct", "a date says more than 'in 18 days'");
  assert.equal(relativeDay("2027-01-03", TODAY), "3 Jan 2027", "the year appears once it differs");
  assert.equal(daysBetweenISO("2026-09-30", "2026-10-01"), 1, "across a month boundary");
  assert.equal(daysBetweenISO("2026-10-25", "2026-10-26"), 1, "across the clocks going back");
});

test("done tasks file themselves away after a week", () => {
  const DONE = "00_Systems/Tasks/Items/Done";
  const tasks = [
    mk({ title: "ticked today", status: "done", completed: TODAY }),
    mk({ title: "ticked 6 days ago", status: "done", completed: "2026-10-06" }),
    mk({ title: "ticked 7 days ago", status: "done", completed: "2026-10-05" }),
    mk({ title: "old, no completion date", status: "done", completed: null }),
    mk({ title: "already filed", status: "done", completed: "2026-08-01", path: `${DONE}/already filed.md` }),
    mk({ title: "recurring", status: "done", completed: "2026-08-01", recurrence: "FREQ=WEEKLY" }),
    mk({ title: "still open", status: "todo" }),
  ];
  assert.deepEqual(archivable(tasks, TODAY, 7, DONE).map((t) => t.title), ["ticked 7 days ago", "old, no completion date"]);
  assert.deepEqual(archivable(tasks, TODAY, 0, DONE), [], "0 days turns it off");
});

test("next week means the start of next week", async () => {
  const { nextWeekStart } = await import("../src/status");
  assert.equal(nextWeekStart("2026-10-12", 1), "2026-10-19", "on a Monday, next Monday");
  assert.equal(nextWeekStart("2026-10-15", 1), "2026-10-19", "on a Thursday, the coming Monday");
  assert.equal(nextWeekStart("2026-10-18", 1), "2026-10-19", "on a Sunday, tomorrow");
  assert.equal(nextWeekStart("2026-10-15", 0), "2026-10-18", "Sunday-first weeks");
});

test("someday reads as lists, one per context", async () => {
  const { groupSomeday } = await import("../src/status");
  const g = groupSomeday([
    mk({ title: "Flipper Zero", contexts: ["shopping", "tech"] }),
    mk({ title: "Bottle", contexts: ["shopping"] }),
    mk({ title: "Bleed hydraulics", contexts: ["Bicycles"] }),
    mk({ title: "Change wraps", contexts: ["bicycles"] }),
    mk({ title: "Learn Rust", contexts: [] }),
  ]);
  assert.deepEqual(g.map((x) => [x.context, x.tasks.map((t) => t.title)]), [
    ["Bicycles", ["Bleed hydraulics", "Change wraps"]],
    ["shopping", ["Bottle", "Flipper Zero"]],
    [null, ["Learn Rust"]],
  ]);
});
