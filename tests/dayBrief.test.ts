import { test } from "node:test";
import assert from "node:assert/strict";
import { dayBrief, DayProject } from "../src/dayBrief.ts";
import { ProjectInfo } from "../src/projects.ts";
import { CalendarItem, Task } from "../src/types.ts";
import { weekTaskReview } from "../src/views.ts";

const TODAY = "2026-10-22";
const YESTERDAY = "2026-10-21";

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
function project(p: Partial<ProjectInfo>, steps: { isNext: boolean }[] = []): DayProject {
  return {
    info: { path: `03_Projects/${p.name ?? "P"}.md`, name: "P", status: "active", waitingOn: "", due: null, completed: null, ...p },
    openSteps: steps,
  };
}

const tasks = [
  task({ title: "Pay council tax", scheduled: TODAY }),
  task({ title: "Return parcel", due: "2026-10-20" }),
  task({ title: "Book MOT", status: "done", completed: TODAY }),
  task({ title: "Water plants", recurrence: "FREQ=DAILY", scheduled: YESTERDAY, completeInstances: [YESTERDAY] }),
];

test("dayBrief: the task verdicts are the weekly review's, over a one-day range", () => {
  for (const date of [YESTERDAY, TODAY]) {
    const b = dayBrief({ date, today: TODAY, items: [], tasks, projects: [] });
    assert.deepEqual(b.tasks, weekTaskReview(tasks, date, date, TODAY));
  }
  const y = dayBrief({ date: YESTERDAY, today: TODAY, items: [], tasks, projects: [] });
  assert.deepEqual(y.tasks.doneRecurring.map((r) => [r.task.title, r.dates]), [["Water plants", [YESTERDAY]]]);
});

test("dayBrief: the schedule keeps that day's non-task items, in the Calendar's order", () => {
  const b = dayBrief({
    date: TODAY,
    today: TODAY,
    items: [
      item({ title: "Dinner", start: "19:00" }),
      item({ kind: "task", title: "Pay council tax", allDay: true, start: null }),
      item({ kind: "birthday", title: "Gran (90)", allDay: true, start: null, category: "Birthdays" }),
      item({ kind: "training", title: "PM Bodyweight — Push", start: "18:00" }),
      item({ title: "Tomorrow's thing", date: "2026-10-23" }),
    ],
    tasks: [],
    projects: [],
  });
  assert.deepEqual(b.schedule.map((it) => it.title), ["Gran (90)", "PM Bodyweight — Push", "Dinner"]);
});

test("dayBrief: overdue, stalled and deadlines are only reported on today's note", () => {
  const projects = [
    project({ name: "Shed", due: "2026-10-25" }, [{ isNext: true }]),
    project({ name: "EmuDeck" }, [{ isNext: false }]), // active, no #next step → stalled
    project({ name: "Garden", due: "2026-12-01" }, [{ isNext: true }]), // deadline too far off
    project({ name: "Tax return", status: "done", due: "2026-10-01" }),
  ];
  const today = dayBrief({ date: TODAY, today: TODAY, items: [], tasks, projects });
  assert.equal(today.isToday, true);
  assert.deepEqual(today.overdue.map((t) => t.title), ["Return parcel"]);
  assert.deepEqual(today.stalled.map((p) => p.name), ["EmuDeck"]);
  assert.deepEqual(today.deadlines.map((d) => [d.name, d.days]), [["Shed", 3]]);

  const past = dayBrief({ date: YESTERDAY, today: TODAY, items: [], tasks, projects });
  assert.deepEqual([past.overdue, past.stalled, past.deadlines], [[], [], []]);
});

test("dayBrief lists the day's top three, open ones first", () => {
  const b = dayBrief({
    date: "2026-10-27",
    today: "2026-10-27",
    items: [],
    tasks: [
      task({ title: "Done star", path: "d.md", top: "2026-10-27", status: "done", completed: "2026-10-27" }),
      task({ title: "Open star", path: "o.md", top: "2026-10-27" }),
      task({ title: "Yesterday's", path: "y.md", top: "2026-10-26" }),
    ],
    projects: [],
  });
  assert.deepEqual(b.top, [
    { path: "o.md", title: "Open star", done: false },
    { path: "d.md", title: "Done star", done: true },
  ]);
});

test("dayBrief lists checkbox tasks from other notes on the day, apart from the schedule", () => {
  const note = (p: Partial<CalendarItem>) => ({ kind: "note", path: "Meeting.md", title: "Send minutes", date: "2026-10-27", allDay: true, start: null, end: null, done: false, category: "Notes", recurring: false, line: 4, ...p }) as CalendarItem;
  const b = dayBrief({
    date: "2026-10-27",
    today: "2026-10-27",
    items: [note({}), note({ title: "Other day", date: "2026-10-28" })],
    tasks: [],
    projects: [],
  });
  assert.deepEqual(b.notes, [{ path: "Meeting.md", title: "Send minutes", line: 4 }]);
  assert.equal(b.schedule.length, 0);
});
