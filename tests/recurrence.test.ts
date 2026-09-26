import { test } from "node:test";
import assert from "node:assert/strict";
import { completeRecurringOccurrence, shiftAnchor, skipRecurringOccurrence } from "../src/recurrence.ts";
import { Task } from "../src/types.ts";

const TODAY = "2026-08-29";

function mk(p: Partial<Task>): Task {
  return {
    path: "t.md", title: "t", status: "todo", scheduled: null, endDate: null, startTime: null,
    endTime: null, due: null, priority: "normal", estimate: null, remind: null, remindStart: null,
    contexts: [], recurrence: null, recurrenceAnchor: "scheduled", completeInstances: [],
    exdates: [], times: [], completeSlots: {}, onCompletion: "keep", created: TODAY,
    completed: null, parent: null, parentPath: null, dependsOn: [], dependsOnPaths: [],
    ...p,
  };
}

// ── skipRecurringOccurrence ────────────────────────────────────────────────────

test("skipRecurringOccurrence advances scheduled past the occurrence, without logging it done", () => {
  const t = mk({ scheduled: TODAY, recurrence: "FREQ=DAILY" });
  const res = skipRecurringOccurrence(t, TODAY, TODAY);
  assert.equal(res.ended, false);
  assert.equal(res.task.scheduled, "2026-08-30");
  assert.deepEqual(res.task.completeInstances, []); // NOT logged as completed
  assert.equal(res.task.status, "todo");
});

test("skipRecurringOccurrence advances due when the anchor is due", () => {
  const t = mk({ due: TODAY, recurrenceAnchor: "due", recurrence: "FREQ=WEEKLY" });
  const res = skipRecurringOccurrence(t, TODAY, TODAY);
  assert.equal(res.task.due, "2026-09-05");
});

test("skipRecurringOccurrence preserves the scheduled/due gap", () => {
  const t = mk({ scheduled: TODAY, due: "2026-08-31", recurrence: "FREQ=WEEKLY" }); // 2-day gap
  const res = skipRecurringOccurrence(t, TODAY, TODAY);
  assert.equal(res.task.scheduled, "2026-09-05");
  assert.equal(res.task.due, "2026-09-07");
});

test("skipRecurringOccurrence ends the series (marks done) when there's no next occurrence", () => {
  const t = mk({ scheduled: TODAY, recurrence: "FREQ=DAILY;UNTIL=20260829" });
  const res = skipRecurringOccurrence(t, TODAY, TODAY);
  assert.equal(res.ended, true);
  assert.equal(res.task.status, "done");
  assert.equal(res.task.completed, TODAY);
});

test("completeRecurringOccurrence still logs completeInstances (unlike skip)", () => {
  const t = mk({ scheduled: TODAY, recurrence: "FREQ=DAILY" });
  const res = completeRecurringOccurrence(t, TODAY, TODAY);
  assert.deepEqual(res.task.completeInstances, [TODAY]);
  assert.equal(res.task.scheduled, "2026-08-30");
});

// ── shiftAnchor ────────────────────────────────────────────────────────────────

test("shiftAnchor moves scheduled by however far the occurrence moved", () => {
  const t = mk({ scheduled: TODAY });
  const shifted = shiftAnchor(t, TODAY, "2026-09-01"); // +3 days
  assert.equal(shifted.scheduled, "2026-09-01");
});

test("shiftAnchor applies the SAME delta even when the grabbed occurrence isn't the anchor", () => {
  // The task's own anchor is a week before the occurrence that was actually dragged.
  const t = mk({ scheduled: "2026-08-22" });
  const shifted = shiftAnchor(t, TODAY, "2026-08-30"); // occurrence moved +1 day
  assert.equal(shifted.scheduled, "2026-08-23"); // anchor shifts by the same +1
});

test("shiftAnchor preserves the scheduled/due gap", () => {
  const t = mk({ scheduled: TODAY, due: "2026-09-02" }); // 4-day gap
  const shifted = shiftAnchor(t, TODAY, "2026-08-30"); // +1 day
  assert.equal(shifted.scheduled, "2026-08-30");
  assert.equal(shifted.due, "2026-09-03");
});

test("shiftAnchor leaves a null scheduled/due as null", () => {
  const t = mk({ scheduled: TODAY, due: null });
  const shifted = shiftAnchor(t, TODAY, "2026-08-30");
  assert.equal(shifted.due, null);
});

test("a zero delta (editing the occurrence in place) is a no-op shift", () => {
  const t = mk({ scheduled: TODAY, due: "2026-09-01" });
  const shifted = shiftAnchor(t, TODAY, TODAY);
  assert.equal(shifted.scheduled, TODAY);
  assert.equal(shifted.due, "2026-09-01");
});
