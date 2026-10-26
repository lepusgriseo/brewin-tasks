import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeBrief } from "../src/rangeBrief.ts";
import { isLiveReview } from "../src/section.ts";
import { CalendarItem, Task } from "../src/types.ts";
import { weekTaskReview } from "../src/views.ts";

const TODAY = "2026-10-24";
const MON = "2026-10-19";
const SUN = "2026-10-25";

function task(p: Partial<Task>): Task {
  return {
    path: p.title ?? "t", title: "T", status: "todo", scheduled: null, endDate: null, startTime: null,
    endTime: null, due: null, priority: "normal", contexts: [], recurrence: null,
    recurrenceAnchor: "scheduled", completeInstances: [], times: [], completeSlots: {},
    onCompletion: "keep", created: null, completed: null, parent: null, parentPath: null,
    ...p,
  } as Task;
}
function item(p: Partial<CalendarItem>): CalendarItem {
  return {
    kind: "event", path: "e", title: "E", date: TODAY, allDay: false, start: "09:00",
    end: "10:00", done: false, category: "General", recurring: false, ...p,
  } as CalendarItem;
}

const tasks = [
  task({ title: "Pay council tax", scheduled: "2026-10-20" }),
  task({ title: "Book MOT", status: "done", completed: "2026-10-21" }),
  task({ title: "Water plants", recurrence: "FREQ=DAILY", scheduled: MON, completeInstances: [MON, "2026-10-22"] }),
  task({ title: "Last week's", status: "done", completed: "2026-10-12" }),
];

test("rangeBrief: the task verdicts are the weekly review's over the same range", () => {
  for (const [from, to] of [[MON, SUN], ["2026-10-01", "2026-10-31"]]) {
    const b = rangeBrief({ from, to, today: TODAY, items: [], tasks });
    assert.deepEqual(b.tasks, weekTaskReview(tasks, from, to, TODAY));
  }
  const w = rangeBrief({ from: MON, to: SUN, today: TODAY, items: [], tasks });
  assert.deepEqual(w.tasks.doneOneOff.map((t) => t.title), ["Book MOT"]);
  assert.deepEqual(w.tasks.missedOneOff.map((t) => t.title), ["Pay council tax"]);
});

test("rangeBrief: one-off events and birthdays in range, repeating blocks and other kinds left out", () => {
  const b = rangeBrief({
    from: MON,
    to: SUN,
    today: TODAY,
    tasks: [],
    items: [
      item({ title: "Dinner", date: "2026-10-23", start: "19:00" }),
      item({ title: "Gym block", recurring: true }),
      item({ title: "Dentist", date: MON, start: "08:30" }),
      item({ kind: "birthday", title: "Gran (90)", date: "2026-10-22", allDay: true, start: null, category: "Birthdays" }),
      item({ kind: "training", title: "PM Bodyweight — Push" }),
      item({ kind: "task", title: "A task" }),
      item({ title: "Next week", date: "2026-10-26" }),
    ],
  });
  assert.deepEqual(b.events.map((e) => e.title), ["Dentist", "Dinner"]);
  assert.deepEqual(b.birthdays.map((e) => e.title), ["Gran (90)"]);
});

test("isLiveReview: a note that draws the review live is told apart from an old frozen one", () => {
  assert.equal(isLiveReview('# Week\n```dataviewjs\nawait dv.view("00_Systems/Scripts/Review", { part: "data" })\n```\n'), true);
  assert.equal(isLiveReview("# Weekly Review — 2026-W37\n\n### Tasks this week\n\n_Run the command._\n"), false);
});
