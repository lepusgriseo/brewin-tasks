import { test } from "node:test";
import assert from "node:assert/strict";
import {
  doneTimesOn,
  formatSlot,
  isSlotDone,
  nextOpenSlot,
  parseSlot,
  parseSlots,
  pruneSlotLog,
  slotProgress,
  slotTitle,
  withSlotToggled,
} from "../src/slots.ts";

const TIMES = ["08:00 Morning", "13:00 Afternoon", "20:00 Evening"];
const slots = parseSlots(TIMES);

test("parseSlot reads a time with and without a label", () => {
  assert.deepEqual(parseSlot("08:00 Morning"), { time: "08:00", label: "Morning" });
  assert.deepEqual(parseSlot("13:00"), { time: "13:00", label: "" });
  assert.deepEqual(parseSlot("8:05  Early  "), { time: "08:05", label: "Early" }); // padded + trimmed
});

test("parseSlot rejects nonsense and impossible clock times", () => {
  assert.equal(parseSlot("sometime"), null);
  assert.equal(parseSlot("25:00"), null);
  assert.equal(parseSlot("08:75"), null);
  assert.equal(parseSlot(""), null);
});

test("parseSlots sorts by clock and drops duplicate times", () => {
  const s = parseSlots(["20:00 Evening", "08:00 Morning", "08:00 Duplicate"]);
  assert.deepEqual(s.map((x) => x.time), ["08:00", "20:00"]);
  assert.equal(s[0].label, "Morning"); // first one wins
});

test("parseSlots tolerates a single value and an empty list", () => {
  assert.deepEqual(parseSlots("09:00").map((s) => s.time), ["09:00"]);
  assert.deepEqual(parseSlots(undefined), []);
  assert.deepEqual(parseSlots([]), []);
});

test("formatSlot round-trips; slotTitle reads label-first", () => {
  for (const raw of TIMES) assert.equal(formatSlot(parseSlot(raw)!), raw);
  assert.equal(formatSlot({ time: "13:00", label: "" }), "13:00");
  assert.equal(slotTitle({ time: "13:00", label: "Afternoon" }), "Afternoon 13:00");
  assert.equal(slotTitle({ time: "13:00", label: "" }), "13:00");
});

// ── per-day completion ───────────────────────────────────────────────────────

const DAY = "2026-07-27";

test("progress counts ticked slots and points at the next one", () => {
  const log = { [DAY]: ["08:00"] };
  const p = slotProgress(slots, log, DAY);
  assert.equal(p.done, 1);
  assert.equal(p.total, 3);
  assert.equal(p.next!.time, "13:00");
  assert.equal(p.dayComplete, false);
});

test("the day is finished when the LAST slot is ticked, even with one skipped", () => {
  // This is the chosen rule: skipping 13:00 must not trap the task on today's list.
  const log = { [DAY]: ["08:00", "20:00"] };
  const p = slotProgress(slots, log, DAY);
  assert.equal(p.done, 2);
  assert.equal(p.dayComplete, true);
  assert.equal(p.next!.time, "13:00"); // still visibly open for today
});

test("ticking early slots alone does NOT finish the day", () => {
  const p = slotProgress(slots, { [DAY]: ["08:00", "13:00"] }, DAY);
  assert.equal(p.dayComplete, false);
  assert.equal(p.next!.time, "20:00");
});

test("a fresh day starts with nothing done", () => {
  const p = slotProgress(slots, { [DAY]: ["08:00", "13:00", "20:00"] }, "2026-07-28");
  assert.equal(p.done, 0);
  assert.equal(p.dayComplete, false);
  assert.equal(p.next!.time, "08:00");
});

test("a task with no slots is never 'day complete'", () => {
  const p = slotProgress([], {}, DAY);
  assert.equal(p.total, 0);
  assert.equal(p.next, null);
  assert.equal(p.dayComplete, false);
});

test("nextOpenSlot returns null once every slot is ticked", () => {
  assert.equal(nextOpenSlot(slots, { [DAY]: ["08:00", "13:00", "20:00"] }, DAY), null);
});

test("toggling a slot adds then removes it, and never mutates the input", () => {
  const before = { [DAY]: ["08:00"] };
  const added = withSlotToggled(before, DAY, "13:00");
  assert.deepEqual(added[DAY], ["08:00", "13:00"]);
  assert.deepEqual(before[DAY], ["08:00"]); // untouched

  const removed = withSlotToggled(added, DAY, "08:00");
  assert.deepEqual(removed[DAY], ["13:00"]);
});

test("emptying a day drops the key rather than leaving []", () => {
  const out = withSlotToggled({ [DAY]: ["08:00"] }, DAY, "08:00");
  assert.equal(DAY in out, false);
});

test("doneTimesOn normalises and de-duplicates stored values", () => {
  assert.deepEqual(doneTimesOn({ [DAY]: ["8:00", "08:00", "rubbish", "13:00"] }, DAY), ["08:00", "13:00"]);
  assert.deepEqual(doneTimesOn({}, DAY), []);
  assert.equal(isSlotDone({ [DAY]: ["8:00"] }, DAY, "08:00"), true);
});

test("pruneSlotLog keeps the recent window and drops old days", () => {
  const log = { "2026-07-01": ["08:00"], "2026-07-20": ["08:00"], "2026-07-27": ["08:00"] };
  const kept = pruneSlotLog(log, "2026-07-27", 14);
  assert.deepEqual(Object.keys(kept).sort(), ["2026-07-20", "2026-07-27"]);
});

// ── Interaction with the recurrence engine ───────────────────────────────────

import { taskFromFrontmatter, applyTaskToFrontmatter } from "../src/task.ts";
import { completeRecurringOccurrence } from "../src/recurrence.ts";
import { tasksToItems } from "../src/calendarItem.ts";

const LITTER = {
  tags: ["task"], status: "todo", scheduled: DAY, due: "", priority: "normal", contexts: ["home"],
  recurrence: "FREQ=DAILY", recurrence_anchor: "scheduled", complete_instances: [], on_completion: "keep",
  times: ["08:00 Morning", "13:00 Afternoon", "20:00 Evening"], complete_slots: {},
};
const litter = (overrides: Record<string, unknown> = {}) =>
  taskFromFrontmatter({ ...LITTER, ...overrides }, "Routines/Cat litter tray.md", "Cat litter tray");

test("times and complete_slots survive a frontmatter round-trip", () => {
  const t = litter({ complete_slots: { [DAY]: ["08:00"] } });
  const out: Record<string, unknown> = {};
  applyTaskToFrontmatter(out, t);
  assert.deepEqual(out.times, ["08:00 Morning", "13:00 Afternoon", "20:00 Evening"]);
  assert.deepEqual(out.complete_slots, { [DAY]: ["08:00"] });
});

test("an ordinary task writes no slot keys at all", () => {
  const out: Record<string, unknown> = {};
  applyTaskToFrontmatter(out, litter({ times: [], complete_slots: {} }));
  assert.equal("times" in out, false);
  assert.equal("complete_slots" in out, false);
});

test("closing the day rolls the task to tomorrow with a clean sheet", () => {
  const done = litter({ complete_slots: { [DAY]: ["08:00", "13:00", "20:00"] } });
  const res = completeRecurringOccurrence(done, DAY, DAY);
  assert.equal(res.ended, false);
  assert.equal(res.task.scheduled, "2026-07-28");
  assert.equal(res.task.status, "todo");
  // Tomorrow has no entry in the log, so every slot is open again.
  const p = slotProgress(res.task.times, res.task.completeSlots, "2026-07-28");
  assert.equal(p.done, 0);
  assert.equal(p.next!.time, "08:00");
});

test("each slot becomes its own short calendar block, ticked independently", () => {
  const items = tasksToItems([litter({ complete_slots: { [DAY]: ["08:00"] } })], DAY, DAY, 15);
  assert.deepEqual(items.map((i) => [i.start, i.end, i.done]), [
    ["08:00", "08:15", true],
    ["13:00", "13:15", false],
    ["20:00", "20:15", false],
  ]);
  assert.equal(items[0].title, "Cat litter tray — Morning");
  assert.equal(items[0].slotTime, "08:00"); // carries which slot it is, for ticking
  assert.ok(items.every((i) => !i.allDay));
});

test("a task with no slots is unaffected by any of this", () => {
  const plain = litter({ times: [], scheduled: DAY, startTime: "09:00", endTime: "10:00" });
  const items = tasksToItems([plain], DAY, DAY, 15);
  assert.equal(items.length, 1);
  assert.equal(items[0].slotTime, undefined);
});
