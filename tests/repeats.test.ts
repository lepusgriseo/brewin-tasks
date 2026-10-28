import { test } from "node:test";
import assert from "node:assert/strict";
import { completeRecurringOccurrence, skipThisTime } from "../src/recurrence.ts";
import { nextWeekendISO, postponeChoices } from "../src/postpone.ts";
import { parseCapture } from "../src/nlp.ts";
import { expandRecurringTasks, weekTaskReview } from "../src/views.ts";
import { Task } from "../src/types.ts";

function task(p: Partial<Task>): Task {
  return {
    path: "t.md", title: "Water the ferns", status: "todo", scheduled: null, endDate: null, startTime: null,
    endTime: null, due: null, priority: "normal", contexts: [], recurrence: null,
    recurrenceAnchor: "scheduled", completeInstances: [], exdates: [], times: [], completeSlots: {},
    onCompletion: "keep", created: null, completed: null, parent: null, parentPath: null,
    ...p,
  } as Task;
}

const every3 = { recurrence: "FREQ=DAILY;INTERVAL=3", scheduled: "2026-10-20" };

test("a repeat counted from completion starts again from the day it was done", () => {
  // Due on the 20th, done late on the 28th: on schedule it would be the 23rd; after done, the 31st.
  assert.equal(completeRecurringOccurrence(task(every3), "2026-10-20", "2026-10-28").task.scheduled, "2026-10-23");
  const late = completeRecurringOccurrence(task({ ...every3, recurrenceFrom: "completion" }), "2026-10-20", "2026-10-28").task;
  assert.equal(late.scheduled, "2026-10-31");
  assert.deepEqual(late.completeInstances, ["2026-10-20"]);
  // Weekly with no day named: a week from whenever it was done.
  const weekly = completeRecurringOccurrence(task({ recurrence: "FREQ=WEEKLY", scheduled: "2026-10-19", recurrenceFrom: "completion" }), "2026-10-19", "2026-10-22").task;
  assert.equal(weekly.scheduled, "2026-10-29");
});

test("skip this time: an exception, not a completion, and on to the next date", () => {
  const skipped = skipThisTime(task({ recurrence: "FREQ=WEEKLY;BYDAY=MO", scheduled: "2026-10-26" }), "2026-10-26", "2026-10-26").task;
  assert.equal(skipped.scheduled, "2026-11-02");
  assert.deepEqual(skipped.exdates, ["2026-10-26"]);
  assert.deepEqual(skipped.completeInstances, []);
  const fromToday = skipThisTime(task({ ...every3, recurrenceFrom: "completion" }), "2026-10-20", "2026-10-28").task;
  assert.equal(fromToday.scheduled, "2026-10-31");
});

test("reviews and the calendar don't invent dates for a repeat counted from completion", () => {
  const t = task({ ...every3, recurrenceFrom: "completion", scheduled: "2026-10-31", completeInstances: ["2026-10-20"] });
  const r = weekTaskReview([t], "2026-10-19", "2026-10-25", "2026-10-28");
  assert.deepEqual(r.doneRecurring.map((x) => x.dates), [["2026-10-20"]]);
  assert.deepEqual(r.missedRecurring, []); // on schedule, the 23rd would have been "missed"
  const late = task({ ...every3, recurrenceFrom: "completion", scheduled: "2026-10-24" });
  assert.deepEqual(weekTaskReview([late], "2026-10-19", "2026-10-25", "2026-10-28").missedRecurring.map((x) => x.dates), [["2026-10-24"]]);
  assert.deepEqual(expandRecurringTasks([t], "2026-10-26", "2026-11-15").map((i) => i.date), ["2026-10-31"]);
  assert.equal(expandRecurringTasks([task({ ...every3, scheduled: "2026-10-31" })], "2026-10-26", "2026-11-15").length, 6);
});

test("the capture box reads “after done” and “every!”", () => {
  const now = new Date("2026-10-28T09:00:00");
  const a = parseCapture("Water the ferns every 3 days after done", now);
  assert.equal(a.title, "Water the ferns");
  assert.equal(a.recurrence, "FREQ=DAILY;INTERVAL=3");
  assert.equal(a.recurrenceFrom, "completion");
  const b = parseCapture("Descale the kettle every! month", now);
  assert.deepEqual([b.title, b.recurrence, b.recurrenceFrom], ["Descale the kettle", "FREQ=MONTHLY", "completion"]);
  const c = parseCapture("Bins every week", now);
  assert.deepEqual([c.recurrence, c.recurrenceFrom], ["FREQ=WEEKLY", null]);
  // Without a repeat, the words are only words.
  assert.equal(parseCapture("Call Gran when done with work", now).title, "Call Gran when done with work");
});

test("postpone offers tomorrow, the weekend and next week", () => {
  assert.equal(nextWeekendISO("2026-10-28"), "2026-10-31"); // Wednesday → Saturday
  assert.equal(nextWeekendISO("2026-10-31"), "2026-11-07"); // Saturday → the next one
  assert.equal(nextWeekendISO("2026-11-01"), "2026-11-07"); // Sunday
  assert.deepEqual(postponeChoices("2026-10-28", 1), [
    { label: "tomorrow", iso: "2026-10-29" },
    { label: "this weekend", iso: "2026-10-31" },
    { label: "next week", iso: "2026-11-02" },
  ]);
  assert.equal(postponeChoices("2026-11-01", 1)[1].label, "next weekend");
});
