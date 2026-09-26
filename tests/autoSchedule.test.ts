import { test } from "node:test";
import assert from "node:assert/strict";
import { autoScheduleDay, freeGapsToday, groupByContext } from "../src/autoSchedule.ts";
import { Task } from "../src/types.ts";

function mk(p: Partial<Task>): Task {
  return {
    path: (p.title ?? "t") + ".md", title: p.title ?? "t", status: "todo", scheduled: null,
    endDate: null, startTime: null, endTime: null, due: null, priority: "normal", estimate: null,
    remind: null, remindStart: null, contexts: [], recurrence: null, recurrenceAnchor: "scheduled",
    completeInstances: [], exdates: [], times: [], completeSlots: {}, onCompletion: "keep",
    created: null, completed: null, parent: null, parentPath: null, dependsOn: [], dependsOnPaths: [],
    ...p,
  };
}

// ── freeGapsToday ──────────────────────────────────────────────────────────────

test("an empty day has one gap spanning the whole window", () => {
  assert.deepEqual(freeGapsToday([], 540, 1080), [[540, 1080]]); // 09:00–18:00
});

test("busy ranges carve gaps out of the window", () => {
  // Busy 10:00-11:00 and 14:00-15:00 within a 09:00-18:00 window.
  const gaps = freeGapsToday([[600, 660], [840, 900]], 540, 1080);
  assert.deepEqual(gaps, [[540, 600], [660, 840], [900, 1080]]);
});

test("overlapping busy ranges are merged before gaps are computed", () => {
  const gaps = freeGapsToday([[600, 700], [650, 750]], 540, 1080);
  assert.deepEqual(gaps, [[540, 600], [750, 1080]]);
});

test("a fully-busy window has no gaps", () => {
  assert.deepEqual(freeGapsToday([[540, 1080]], 540, 1080), []);
});

test("busy time outside the window is clipped away, not treated as blocking", () => {
  const gaps = freeGapsToday([[0, 600]], 540, 1080); // busy until 10:00, window starts 09:00
  assert.deepEqual(gaps, [[600, 1080]]);
});

test("a gap smaller than the minimum is dropped", () => {
  const gaps = freeGapsToday([[541, 1080]], 540, 1080, 5); // only a 1-minute gap at the start
  assert.deepEqual(gaps, []);
});

test("a window that's already closed (start >= end) has no gaps", () => {
  assert.deepEqual(freeGapsToday([], 1080, 540), []);
});

// ── groupByContext ─────────────────────────────────────────────────────────────

test("tasks sharing a context land adjacently, ordered by the group's best priority", () => {
  const homeLow = mk({ title: "Tidy", contexts: ["home"], priority: "low" });
  const errandHigh = mk({ title: "Post office", contexts: ["errand"], priority: "high" });
  const homeHigh = mk({ title: "Fix tap", contexts: ["home"], priority: "high" });
  const ordered = groupByContext([homeLow, errandHigh, homeHigh]).map((t) => t.title);
  // "home" group's best is high (Fix tap), same as "errand" — alphabetical tiebreak: errand < home.
  assert.deepEqual(ordered, ["Post office", "Fix tap", "Tidy"]);
});

test("no-context tasks form their own bucket", () => {
  const a = mk({ title: "A", contexts: [] });
  const b = mk({ title: "B", contexts: ["home"] });
  const ordered = groupByContext([a, b]).map((t) => t.title);
  assert.equal(ordered.length, 2);
  assert.ok(ordered.includes("A") && ordered.includes("B"));
});

// ── autoScheduleDay ──────────────────────────────────────────────────────────

test("places tasks back-to-back using each one's estimate", () => {
  const a = mk({ title: "A", estimate: 30 });
  const b = mk({ title: "B", estimate: 45 });
  const res = autoScheduleDay([a, b], [[540, 1080]], 60);
  assert.deepEqual(res.placements.map((p) => [p.task.title, p.start, p.end]), [
    ["A", 540, 570],
    ["B", 570, 615],
  ]);
  assert.deepEqual(res.unplaced, []);
});

test("a task with no estimate falls back to the default block length", () => {
  const a = mk({ title: "A", estimate: null });
  const res = autoScheduleDay([a], [[540, 1080]], 60);
  assert.deepEqual(res.placements, [{ task: a, start: 540, end: 600 }]);
});

test("a task that doesn't fit anywhere is reported as unplaced, not dropped", () => {
  const tooBig = mk({ title: "Too big", estimate: 500 });
  const res = autoScheduleDay([tooBig], [[540, 600]], 60); // only a 60-minute gap
  assert.deepEqual(res.placements, []);
  assert.deepEqual(res.unplaced, [tooBig]);
});

test("a smaller later task is NOT pulled forward to fill room a bigger earlier one couldn't use", () => {
  const big = mk({ title: "Big", contexts: ["work"], priority: "high", estimate: 90 });
  const small = mk({ title: "Small", contexts: ["home"], priority: "low", estimate: 15 });
  // One 60-minute gap: "Big" (queued first, higher priority) doesn't fit, so the gap is left
  // alone rather than skipping ahead to place "Small" instead.
  const res = autoScheduleDay([big, small], [[540, 600]], 60);
  assert.deepEqual(res.placements, []);
  assert.deepEqual(res.unplaced.map((t) => t.title), ["Big", "Small"]);
});

test("filling one gap continues into the next rather than restarting the queue", () => {
  const a = mk({ title: "A", estimate: 50 });
  const b = mk({ title: "B", estimate: 50 });
  // First gap only fits A; B rolls over into the second gap.
  const res = autoScheduleDay([a, b], [[540, 600], [700, 800]], 60);
  assert.deepEqual(res.placements.map((p) => p.task.title), ["A", "B"]);
  assert.deepEqual(res.placements[1], { task: b, start: 700, end: 750 });
});
