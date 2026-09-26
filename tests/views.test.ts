import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attentionTasks,
  groupByProject,
  inboxTasks,
  monthPanelSections,
  tasksByPriority,
  todayAgenda,
  unscheduledTasks,
  weekAgenda,
} from "../src/views.ts";
import { CalendarItem, Task } from "../src/types.ts";

const TODAY = "2026-07-27";

function task(p: Partial<Task>): Task {
  return {
    path: p.title ?? "t", title: "T", status: "todo", scheduled: null, endDate: null, startTime: null,
    endTime: null, due: null, priority: "normal", contexts: [], recurrence: null,
    recurrenceAnchor: "scheduled", completeInstances: [], times: [], completeSlots: {},
    onCompletion: "keep", created: null, completed: null, parent: null, parentPath: null,
    ...p,
  } as Task;
}
function event(p: Partial<CalendarItem>): CalendarItem {
  return {
    kind: "event", path: "e", title: "E", date: TODAY, allDay: false, start: "09:00",
    end: "10:00", done: false, category: "General", recurring: false, ...p,
  } as CalendarItem;
}

// ── Today ────────────────────────────────────────────────────────────────────

test("Today splits timed from anytime and counts what's left", () => {
  const a = todayAgenda(
    [
      task({ title: "Call plumber", scheduled: TODAY, priority: "high" }),
      task({ title: "Standup", scheduled: TODAY, startTime: "09:30", endTime: "09:45" }),
      task({ title: "Order cat food", scheduled: TODAY }),
    ],
    [],
    TODAY
  );
  assert.deepEqual(a.timed.map((r) => r.title), ["Standup"]);
  assert.deepEqual(a.anytime.map((t) => t.title), ["Call plumber", "Order cat food"]); // high first
  assert.equal(a.openCount, 3);
});

test("events are woven into the timeline in clock order but stay uncheckable", () => {
  const a = todayAgenda(
    [task({ title: "Standup", scheduled: TODAY, startTime: "09:30" })],
    [event({ title: "Work", start: "09:00", end: "17:00" }), event({ title: "Spanish", start: "08:15" })],
    TODAY
  );
  assert.deepEqual(a.timed.map((r) => `${r.time} ${r.title}`), [
    "08:15 Spanish",
    "09:00 Work",
    "09:30 Standup",
  ]);
  assert.equal(a.timed.find((r) => r.title === "Work")!.kind, "event");
  assert.equal(a.timed.find((r) => r.title === "Work")!.task, undefined); // nothing to tick
});

test("a multi-slot task contributes one timeline row per slot", () => {
  const litter = task({
    title: "Cat litter tray", scheduled: TODAY,
    times: [
      { time: "08:00", label: "Morning" },
      { time: "13:00", label: "Afternoon" },
      { time: "20:00", label: "Evening" },
    ],
    completeSlots: { [TODAY]: ["08:00"] },
  });
  const a = todayAgenda([litter], [], TODAY);
  assert.deepEqual(a.timed.map((r) => [r.time, r.done]), [
    ["08:00", true],
    ["13:00", false],
    ["20:00", false],
  ]);
  assert.equal(a.timed[0].slotTime, "08:00");
  assert.equal(a.doneCount, 1); // ticked slots count toward today's tally
  assert.equal(a.openCount, 2);
});

test("overdue is pinned separately and never also listed as today's work", () => {
  const late = task({ title: "Tax return", scheduled: TODAY, due: "2026-07-20" });
  const a = todayAgenda([late], [], TODAY);
  assert.deepEqual(a.overdue.map((t) => t.title), ["Tax return"]);
  assert.equal(a.anytime.length, 0); // appears once, at the top
  assert.equal(a.timed.length, 0);
});

test("a task scheduled before today rolls into Today rather than vanishing", () => {
  const a = todayAgenda([task({ title: "Rolled over", scheduled: "2026-07-25" })], [], TODAY);
  assert.deepEqual(a.anytime.map((t) => t.title), ["Rolled over"]);
});

test("done-today counts; held and future tasks are excluded", () => {
  const a = todayAgenda(
    [
      task({ title: "Finished", status: "done", completed: TODAY }),
      task({ title: "Old", status: "done", completed: "2026-07-01" }),
      task({ title: "Parked", status: "hold", scheduled: TODAY }),
      task({ title: "Later", scheduled: "2026-08-01" }),
    ],
    [],
    TODAY
  );
  assert.equal(a.doneCount, 1);
  assert.equal(a.openCount, 0);
  assert.equal(a.anytime.length, 0);
});

test("all-day events go to their own strip, not the timeline", () => {
  const a = todayAgenda([], [event({ title: "Office Day", allDay: true, start: null, end: null })], TODAY);
  assert.deepEqual(a.allDayEvents.map((e) => e.title), ["Office Day"]);
  assert.equal(a.timed.length, 0);
});

// ── Week ─────────────────────────────────────────────────────────────────────

test("Week returns 7 consecutive days and keeps empty ones", () => {
  const w = weekAgenda([task({ title: "A", scheduled: "2026-07-29" })], TODAY, 7);
  assert.equal(w.length, 7);
  assert.deepEqual(w.map((g) => g.date)[0], TODAY);
  assert.deepEqual(w.map((g) => g.date)[6], "2026-08-02");
  assert.equal(w.find((g) => g.date === "2026-07-29")!.tasks.length, 1);
  assert.equal(w.find((g) => g.date === "2026-07-28")!.tasks.length, 0); // empty day kept
});

test("Week folds anything older than the window onto the first day", () => {
  const w = weekAgenda([task({ title: "Ancient", scheduled: "2026-01-01" })], TODAY, 7);
  assert.deepEqual(w[0].tasks.map((t) => t.title), ["Ancient"]);
});

test("Week ignores tasks beyond the window and closed ones", () => {
  const w = weekAgenda(
    [task({ title: "Far", scheduled: "2026-09-01" }), task({ title: "Done", scheduled: TODAY, status: "done" })],
    TODAY,
    7
  );
  assert.equal(w.reduce((n, g) => n + g.tasks.length, 0), 0);
});

// ── Inbox / Attention / Projects ─────────────────────────────────────────────

test("Inbox is only what has no date at all", () => {
  const list = inboxTasks([
    task({ title: "Undated", priority: "high" }),
    task({ title: "Also undated" }),
    task({ title: "Scheduled", scheduled: TODAY }),
    task({ title: "Due only", due: "2026-08-01" }),
    task({ title: "Held" , status: "hold" }),
  ]);
  assert.deepEqual(list.map((t) => t.title), ["Undated", "Also undated"]);
});

test("unscheduledTasks includes a due-only task, unlike Inbox", () => {
  const list = unscheduledTasks([
    task({ title: "Undated", priority: "high" }),
    task({ title: "Due only", due: "2026-08-01" }),
    task({ title: "Scheduled", scheduled: TODAY }),
    task({ title: "Held", status: "hold" }),
    task({ title: "Done", status: "done" }),
  ]);
  assert.deepEqual(list.map((t) => t.title), ["Undated", "Due only"]);
});

test("Attention separates a broken promise from a plan that slipped", () => {
  const g = attentionTasks(
    [
      task({ title: "Overdue", due: "2026-07-01" }),
      task({ title: "Slipped", scheduled: "2026-07-20" }),
      task({ title: "Parked", status: "hold" }),
      task({ title: "Fine", scheduled: TODAY }),
    ],
    TODAY
  );
  assert.deepEqual(g.overdue.map((t) => t.title), ["Overdue"]);
  assert.deepEqual(g.slipped.map((t) => t.title), ["Slipped"]);
  assert.deepEqual(g.onhold.map((t) => t.title), ["Parked"]);
});

test("Projects groups by note, biggest backlog first", () => {
  const groups = groupByProject([
    { projectPath: "a.md", projectName: "Alpha", line: 3, text: "one", scheduled: null, due: null },
    { projectPath: "b.md", projectName: "Beta", line: 1, text: "x", scheduled: "2026-08-01", due: null },
    { projectPath: "a.md", projectName: "Alpha", line: 9, text: "two", scheduled: "2026-07-28", due: null },
  ]);
  assert.deepEqual(groups.map((g) => [g.project, g.tasks.length]), [["Alpha", 2], ["Beta", 1]]);
  assert.deepEqual(groups[0].tasks.map((t) => t.text), ["two", "one"]); // dated first
});

// ── Multi-day tasks + repeat endings ─────────────────────────────────────────

import { readRepeatEnd, spanOf, spanLabel } from "../src/views.ts";
import { taskCoversDay, taskDayIndex, taskLastDay, taskSpanDays } from "../src/task.ts";
import { setCount, setUntil, stripEnd, parseRRule, nextAfter } from "../src/rrule.ts";
import { tasksToItems } from "../src/calendarItem.ts";

const decorate = task({ title: "Decorate spare room", scheduled: "2026-08-01", endDate: "2026-08-05" });

test("a span is inclusive of both ends", () => {
  assert.equal(taskSpanDays(decorate), 5); // 1st–5th is five days, not four
  assert.equal(taskLastDay(decorate), "2026-08-05");
  assert.equal(taskCoversDay(decorate, "2026-08-03"), true);
  assert.equal(taskCoversDay(decorate, "2026-07-31"), false);
  assert.equal(taskCoversDay(decorate, "2026-08-06"), false);
  assert.equal(taskDayIndex(decorate, "2026-08-03"), 3);
  assert.equal(spanLabel(decorate, "2026-08-03"), "3/5");
});

test("a backwards end date is ignored rather than making a zero-day task", () => {
  const wrong = task({ scheduled: "2026-08-05", endDate: "2026-08-01" });
  assert.equal(taskSpanDays(wrong), 1);
  assert.equal(taskLastDay(wrong), "2026-08-05");
});

test("an ordinary single-day task has no span label", () => {
  assert.equal(taskSpanDays(task({ scheduled: "2026-08-01" })), 1);
  assert.equal(spanLabel(task({ scheduled: "2026-08-01" }), "2026-08-01"), "");
});

test("a multi-day task appears on every day it covers, numbered", () => {
  const items = tasksToItems([decorate], "2026-08-01", "2026-08-31");
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((i) => i.date), [
    "2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05",
  ]);
  assert.equal(items[2].title, "Decorate spare room (3/5)");
  assert.ok(items.every((i) => i.allDay));
});

test("a span straddling the window edge is clipped, not dropped", () => {
  // The window starts mid-span: the earlier days are outside, the rest still show.
  const items = tasksToItems([decorate], "2026-08-03", "2026-08-31");
  assert.deepEqual(items.map((i) => i.date), ["2026-08-03", "2026-08-04", "2026-08-05"]);
  assert.equal(items[0].title, "Decorate spare room (3/5)"); // still numbered from the real start
});

test("skipMultiDay drops the (idx/span) chips entirely — the calendar grid renders these as one bar instead", () => {
  const items = tasksToItems([decorate], "2026-08-01", "2026-08-31", 15, { skipMultiDay: true });
  assert.equal(items.length, 0);
  // An ordinary single-day task is unaffected — the option only touches the multi-day branch.
  const plain = tasksToItems([task({ title: "Call plumber", scheduled: "2026-08-01" })], "2026-08-01", "2026-08-31", 15, { skipMultiDay: true });
  assert.equal(plain.length, 1);
});

test("Week places a span on each of its days inside the window", () => {
  const w = weekAgenda([decorate], "2026-08-01", 7);
  const withTask = w.filter((g) => g.tasks.length).map((g) => g.date);
  assert.deepEqual(withTask, ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]);
});

test("Today includes a span that started earlier and still runs", () => {
  const a = todayAgenda([decorate], [], "2026-08-03");
  assert.deepEqual(a.anytime.map((t) => t.title), ["Decorate spare room"]);
});

test("spanOf handles the degenerate cases", () => {
  assert.equal(spanOf("2026-08-01", "2026-08-05"), 5);
  assert.equal(spanOf("2026-08-01", null), 1);
  assert.equal(spanOf("2026-08-01", "2026-08-01"), 1);
  assert.equal(spanOf(null, "2026-08-05"), 0);
});

// ── Repeat endings ───────────────────────────────────────────────────────────

test("readRepeatEnd recognises never / until / count", () => {
  assert.deepEqual(readRepeatEnd("FREQ=DAILY"), { kind: "never", until: null, count: null });
  assert.deepEqual(readRepeatEnd("FREQ=DAILY;UNTIL=20260930"), { kind: "on", until: "2026-09-30", count: null });
  assert.deepEqual(readRepeatEnd("FREQ=WEEKLY;COUNT=8"), { kind: "after", until: null, count: 8 });
  assert.deepEqual(readRepeatEnd(null), { kind: "never", until: null, count: null });
});

test("setUntil / setCount replace each other rather than stacking", () => {
  const withUntil = setUntil("FREQ=DAILY;COUNT=5", "2026-09-30");
  assert.ok(withUntil.includes("UNTIL=20260930"));
  assert.ok(!withUntil.includes("COUNT"));
  const withCount = setCount(withUntil, 3);
  assert.ok(withCount.includes("COUNT=3"));
  assert.ok(!withCount.includes("UNTIL"));
  assert.equal(stripEnd(withCount), "FREQ=DAILY");
});

test("a repeat that has ended stops producing occurrences", () => {
  const rule = parseRRule("FREQ=DAILY;UNTIL=20260930")!;
  const start = new Date(Date.UTC(2026, 8, 28));
  assert.notEqual(nextAfter(rule, start, new Date(Date.UTC(2026, 8, 28))), null); // 29th exists
  // Nothing after the UNTIL date — the series is over, so the task completes for good.
  assert.equal(nextAfter(rule, start, new Date(Date.UTC(2026, 8, 30))), null);
});

// ── Weekly review ────────────────────────────────────────────────────────────

import { expandRecurringTasks, reviewAnchor, reviewRowCount, reviewWeek } from "../src/views.ts";
import { eventsToItems, tasksToItems } from "../src/calendarItem.ts";
import { EventItem } from "../src/types.ts";

const MON = "2026-08-03";
const SUN = "2026-08-09";

function ev(p: Partial<EventItem>): EventItem {
  return {
    path: "e.md", title: "E", date: MON, endDate: null, allDay: false, startTime: "09:00",
    endTime: "10:00", category: "General", originalCategory: "General", archived: false,
    completed: false, recurrence: null, exdates: [], remind: null, remindStart: null, ...p,
  };
}

test("the review week emits all seven days, empty ones included", () => {
  const days = reviewWeek([], MON, SUN);
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((d) => d.date)[0], MON);
  assert.deepEqual(days.map((d) => d.date)[6], SUN);
  assert.equal(reviewRowCount(days), 0);
});

test("a day reads all-day event → timed by clock → untimed task", () => {
  const items = [
    ...eventsToItems(
      [
        ev({ path: "office.md", title: "Office Day", allDay: true, startTime: null, endTime: null }),
        ev({ path: "work.md", title: "Work", startTime: "09:00", endTime: "17:00" }),
        ev({ path: "gym.md", title: "C1.1 Push", startTime: "07:00", endTime: "08:00" }),
      ],
      MON,
      SUN
    ),
    ...tasksToItems([task({ title: "Call plumber", scheduled: MON })], MON, SUN),
  ];
  const monday = reviewWeek(items, MON, SUN)[0];
  assert.deepEqual(monday.allDay.map((r) => r.title), ["Office Day"]);
  assert.deepEqual(monday.timed.map((r) => r.title), ["C1.1 Push", "Work"]); // 07:00 then 09:00
  assert.deepEqual(monday.untimed.map((r) => r.title), ["Call plumber"]);
});

test("an untimed TASK is not mistaken for the day's all-day context", () => {
  const items = tasksToItems([task({ title: "Order cat food", scheduled: MON })], MON, SUN);
  const monday = reviewWeek(items, MON, SUN)[0];
  assert.equal(monday.allDay.length, 0); // it's work to fit in, not a frame for the day
  assert.deepEqual(monday.untimed.map((r) => r.title), ["Order cat food"]);
});

test("a recurring event appears on each of its days in the week", () => {
  const weekly = ev({ path: "c16.md", title: "C1.6 Leg", date: "2026-08-02", recurrence: "FREQ=DAILY" });
  const days = reviewWeek(eventsToItems([weekly], MON, SUN), MON, SUN);
  assert.equal(days.filter((d) => d.timed.some((r) => r.title === "C1.6 Leg")).length, 7);
});

test("a multi-slot task contributes one row per time, each separately tickable", () => {
  const litter = task({
    title: "Cat litter tray",
    scheduled: MON,
    times: [
      { time: "08:00", label: "Morning" },
      { time: "13:00", label: "Afternoon" },
      { time: "20:00", label: "Evening" },
    ],
  });
  const monday = reviewWeek(tasksToItems([litter], MON, SUN, 15), MON, SUN)[0];
  assert.deepEqual(monday.timed.map((r) => r.time), ["08:00", "13:00", "20:00"]);
  assert.equal(new Set(monday.timed.map((r) => r.key)).size, 3); // three distinct ticks
});

test("a multi-day task appears on every day it covers", () => {
  const decorate = task({ title: "Decorate", scheduled: MON, endDate: "2026-08-05" });
  const days = reviewWeek(tasksToItems([decorate], MON, SUN), MON, SUN);
  assert.equal(days.filter((d) => d.untimed.length > 0).length, 3);
});

test("row keys are unique within a week and stable between renders", () => {
  const items = [
    ...eventsToItems([ev({ path: "a.md", title: "A", recurrence: "FREQ=DAILY" })], MON, SUN),
    ...tasksToItems([task({ title: "T", scheduled: MON })], MON, SUN),
  ];
  const keys = (d = reviewWeek(items, MON, SUN)) => d.flatMap((x) => [...x.allDay, ...x.timed, ...x.untimed].map((r) => r.key));
  const first = keys();
  assert.equal(new Set(first).size, first.length, "keys must be unique — a tick must not hit two rows");
  assert.deepEqual(keys(), first, "keys must not change between renders, or ticks would jump");
});

// ── which week it opens on ───────────────────────────────────────────────────

test("on the last day of the week it opens on NEXT week — that's the review moment", () => {
  // Sunday 2 Aug 2026, Monday-start weeks.
  assert.equal(reviewAnchor("2026-08-02", 1), "2026-08-03");
});

test("mid-week it opens on the current week", () => {
  assert.equal(reviewAnchor("2026-08-05", 1), "2026-08-05"); // Wednesday
  assert.equal(reviewAnchor("2026-08-03", 1), "2026-08-03"); // Monday
});

test("it respects a Sunday-start week", () => {
  // With weekStart=0 the last day is Saturday, so Saturday rolls forward, Sunday doesn't.
  assert.equal(reviewAnchor("2026-08-08", 0), "2026-08-09"); // Saturday → next week
  assert.equal(reviewAnchor("2026-08-02", 0), "2026-08-02"); // Sunday is now day 0
});

test("recurring tasks are expanded across the review week, not stuck on one date", () => {
  // The bug this fixes: the litter tray, scheduled 31 Jul and repeating daily, was absent
  // from the week of 3 Aug entirely — so a review of next week silently omitted it.
  const litter = task({
    title: "Cat litter tray",
    scheduled: "2026-07-31",
    recurrence: "FREQ=DAILY",
    times: [
      { time: "08:00", label: "Morning" },
      { time: "20:00", label: "Evening" },
    ],
  });
  const rows = expandRecurringTasks([litter], MON, SUN, 15);
  assert.equal(rows.length, 14); // 7 days × 2 slots
  const days = reviewWeek(rows, MON, SUN);
  assert.ok(days.every((d) => d.timed.length === 2));
});

test("a weekly recurring task lands on its own weekday only", () => {
  const review = task({ title: "Weekly review", scheduled: "2026-08-02", recurrence: "FREQ=WEEKLY" });
  const rows = expandRecurringTasks([review], MON, SUN, 15);
  assert.deepEqual(rows.map((r) => r.date), ["2026-08-09"]); // the Sunday inside the window
});

test("expandRecurringTasks skips a date in the task's exdates — it's been detached onto its own note", () => {
  const daily = task({ title: "Litter tray", scheduled: MON, recurrence: "FREQ=DAILY", exdates: ["2026-08-05"] });
  const rows = expandRecurringTasks([daily], MON, SUN, 15);
  assert.ok(!rows.some((r) => r.date === "2026-08-05"));
  assert.ok(rows.some((r) => r.date === MON));
});

test("expansion skips done and held recurring tasks", () => {
  const held = task({ title: "Paused", scheduled: MON, recurrence: "FREQ=DAILY", status: "hold" });
  const done = task({ title: "Finished", scheduled: MON, recurrence: "FREQ=DAILY", status: "done" });
  assert.deepEqual(expandRecurringTasks([held, done], MON, SUN, 15), []);
});

test("a future occurrence of a recurring task reads as open, not done", () => {
  const t = task({
    title: "Bins", scheduled: MON, recurrence: "FREQ=DAILY",
    completeInstances: [MON], // only Monday was actually ticked
  });
  const rows = expandRecurringTasks([t], MON, SUN, 15);
  assert.equal(rows.find((r) => r.date === MON)!.done, true);
  assert.equal(rows.find((r) => r.date === "2026-08-05")!.done, false);
});

test("the review hides anything already done — it lists what's still to happen", () => {
  const items = [
    ...tasksToItems([task({ title: "Finished", scheduled: MON, status: "done" })], MON, SUN),
    ...tasksToItems([task({ title: "Still to do", scheduled: MON })], MON, SUN),
  ];
  const monday = reviewWeek(items, MON, SUN)[0];
  assert.deepEqual(monday.untimed.map((r) => r.title), ["Still to do"]);
});

test("a completed EVENT is hidden too, not just tasks", () => {
  const done = ev({ path: "d.md", title: "Already happened", completed: true });
  const monday = reviewWeek(eventsToItems([done], MON, SUN), MON, SUN)[0];
  assert.equal(monday.timed.length, 0);
});

test("a ticked slot of a multi-slot task drops out, the rest stay", () => {
  const litter = task({
    title: "Cat litter tray",
    scheduled: MON,
    times: [
      { time: "08:00", label: "Morning" },
      { time: "13:00", label: "Afternoon" },
      { time: "20:00", label: "Evening" },
    ],
    completeSlots: { [MON]: ["08:00"] }, // morning already done
  });
  const monday = reviewWeek(tasksToItems([litter], MON, SUN, 15), MON, SUN)[0];
  assert.deepEqual(monday.timed.map((r) => r.time), ["13:00", "20:00"]);
});

test("done rows can be brought back explicitly, for a backward-looking review", () => {
  const items = tasksToItems([task({ title: "Finished", scheduled: MON, status: "done" })], MON, SUN);
  assert.equal(reviewWeek(items, MON, SUN, { includeDone: true })[0].untimed.length, 1);
});

test("row counts reflect what's actually shown", () => {
  const items = [
    ...tasksToItems([task({ title: "A", scheduled: MON, status: "done" })], MON, SUN),
    ...tasksToItems([task({ title: "B", scheduled: MON })], MON, SUN),
  ];
  assert.equal(reviewRowCount(reviewWeek(items, MON, SUN)), 1);
});

// ── Tasks by priority (Review Day view) ──────────────────────────────────────

test("tasksByPriority buckets by priority, defaulting to normal when unset", () => {
  const grouped = tasksByPriority(
    tasksToItems(
      [
        task({ title: "Urgent", scheduled: MON, priority: "high" }),
        task({ title: "Whenever", scheduled: MON, priority: "low" }),
        task({ title: "Plain" , scheduled: MON }),
      ],
      MON,
      SUN
    ),
    MON
  );
  assert.deepEqual(grouped.high.map((i) => i.title), ["Urgent"]);
  assert.deepEqual(grouped.normal.map((i) => i.title), ["Plain"]);
  assert.deepEqual(grouped.low.map((i) => i.title), ["Whenever"]);
});

test("tasksByPriority is scoped to one day and excludes done tasks", () => {
  const items = tasksToItems(
    [
      task({ title: "Today", scheduled: MON, priority: "high" }),
      task({ title: "Tomorrow", scheduled: "2026-08-04", priority: "high" }),
      task({ title: "Already done", scheduled: MON, priority: "high", status: "done" }),
    ],
    MON,
    SUN
  );
  const grouped = tasksByPriority(items, MON);
  assert.deepEqual(grouped.high.map((i) => i.title), ["Today"]);
});

test("tasksByPriority sorts each bucket untimed-first, then by clock, same as sortItems", () => {
  const grouped = tasksByPriority(
    tasksToItems(
      [
        task({ title: "Zebra", scheduled: MON, priority: "high", startTime: "09:00", endTime: "10:00" }),
        task({ title: "Apple", scheduled: MON, priority: "high" }),
        task({ title: "Earlier", scheduled: MON, priority: "high", startTime: "08:00", endTime: "08:30" }),
      ],
      MON,
      SUN
    ),
    MON
  );
  assert.deepEqual(grouped.high.map((i) => i.title), ["Apple", "Earlier", "Zebra"]);
});

test("tasksByPriority includes a recurring task expanded onto the day", () => {
  const litter = task({ title: "Litter tray", scheduled: MON, recurrence: "FREQ=DAILY", priority: "high" });
  const items = expandRecurringTasks([litter], MON, SUN, 15);
  const grouped = tasksByPriority(items, "2026-08-05"); // a day the task rolls onto, not its anchor
  assert.deepEqual(grouped.high.map((i) => i.title), ["Litter tray"]);
});

// ── monthPanelSections ───────────────────────────────────────────────────────

const SEP_TODAY = "2026-09-09"; // an ISO-W37 day

test("monthPanelSections: a section per ISO week + an 'Anytime this month' catch-all", () => {
  const secs = monthPanelSections("2026-09", [], SEP_TODAY);
  assert.deepEqual(secs.map((s) => s.label), [
    "Week 36", "Week 37", "Week 38", "Week 39", "Week 40", "Anytime this month",
  ]);
  const w37 = secs.find((s) => s.key === "2026-W37")!;
  assert.equal(w37.isCurrent, true);
  assert.equal(w37.defaultOpen, true); // current week
  assert.equal(w37.fallbackDate, "2026-09-07"); // that week's Monday
  for (const k of ["2026-W36", "2026-W38", "2026-W39", "2026-W40"]) {
    assert.equal(secs.find((s) => s.key === k)!.defaultOpen, false); // empty, not current
  }
  const anytime = secs.find((s) => s.kind === "month")!;
  assert.equal(anytime.defaultOpen, true);
  assert.equal(anytime.fallbackDate, SEP_TODAY); // today is in the viewed month
});

test("monthPanelSections: tasks land in exactly one section", () => {
  const weekTask = task({ title: "Renew MOT", week: "2026-W38" });
  const monthTask = task({ title: "Renew passport", month: "2026-09" });
  const both = task({ title: "Legacy", month: "2026-09", week: "2026-W39" });
  const secs = monthPanelSections("2026-09", [weekTask, monthTask, both], SEP_TODAY);

  const w38 = secs.find((s) => s.key === "2026-W38")!;
  assert.deepEqual(w38.tasks.map((t) => t.title), ["Renew MOT"]);
  assert.equal(w38.defaultOpen, true); // non-empty

  const w39 = secs.find((s) => s.key === "2026-W39")!;
  assert.deepEqual(w39.tasks.map((t) => t.title), ["Legacy"]); // both-fields task shows here only

  const anytime = secs.find((s) => s.kind === "month")!;
  assert.deepEqual(anytime.tasks.map((t) => t.title), ["Renew passport"]); // NOT "Legacy"
});

test("monthPanelSections: done tasks sort last within a section; catch-all fallback for another month", () => {
  const secs = monthPanelSections(
    "2026-09",
    [
      task({ title: "Zeta", week: "2026-W37" }),
      task({ title: "Alpha done", week: "2026-W37", status: "done" }),
      task({ title: "Beta", week: "2026-W37" }),
    ],
    "2026-07-01" // today is NOT in the viewed month
  );
  assert.deepEqual(secs.find((s) => s.key === "2026-W37")!.tasks.map((t) => t.title), ["Beta", "Zeta", "Alpha done"]);
  assert.equal(secs.find((s) => s.kind === "month")!.fallbackDate, "2026-09-01"); // month-01, not today
});

// ── weekTaskReview / formatWeekTaskBlock ─────────────────────────────────────

import { formatWeekTaskBlock, weekTaskReview } from "../src/views.ts";
import { shortDate } from "../src/dates.ts";

const WK_FROM = "2026-09-07"; // Mon, ISO-W37
const WK_TO = "2026-09-13"; // Sun
const WK_TODAY = "2026-09-10"; // Thu — Mon–Wed are past, Fri–Sun still ahead

test("weekTaskReview: a one-off counts as done only when completed inside the week", () => {
  const r = weekTaskReview(
    [
      task({ title: "In week", status: "done", completed: "2026-09-08" }),
      task({ title: "Last week", status: "done", completed: "2026-09-01" }),
      task({ title: "Next week", status: "done", completed: "2026-09-20" }),
    ],
    WK_FROM,
    WK_TO,
    WK_TODAY
  );
  assert.deepEqual(r.doneOneOff.map((t) => t.title), ["In week"]);
  assert.equal(r.counts.done, 1);
});

test("weekTaskReview: past unfinished → missed; today or later → still open; hold is neither", () => {
  const r = weekTaskReview(
    [
      task({ title: "Missed sched", scheduled: "2026-09-08" }),
      task({ title: "Missed due", due: "2026-09-09" }),
      task({ title: "Due today", scheduled: "2026-09-10" }),
      task({ title: "Later this week", scheduled: "2026-09-12" }),
      task({ title: "On hold", scheduled: "2026-09-08", status: "hold" }),
      task({ title: "Outside the week", scheduled: "2026-09-20" }),
    ],
    WK_FROM,
    WK_TO,
    WK_TODAY
  );
  assert.deepEqual(r.missedOneOff.map((t) => t.title), ["Missed sched", "Missed due"]);
  assert.deepEqual(r.stillOpen.map((t) => t.title), ["Due today", "Later this week"]);
  assert.deepEqual(r.counts, { done: 0, missed: 2, open: 2 });
});

test("weekTaskReview: recurring done from completeInstances even after the anchor rolled past the week; exdate is not a miss", () => {
  const burpees = task({
    title: "Burpees",
    scheduled: "2026-09-11", // anchor has already advanced past the completed days
    recurrence: "FREQ=DAILY",
    completeInstances: ["2026-09-07", "2026-09-08", "2026-09-09"],
    exdates: ["2026-09-10"], // that occurrence was detached onto its own note
  });
  const r = weekTaskReview([burpees], WK_FROM, WK_TO, WK_TODAY);
  assert.deepEqual(r.doneRecurring[0].dates, ["2026-09-07", "2026-09-08", "2026-09-09"]);
  assert.equal(r.missedRecurring.length, 0);
  assert.deepEqual(r.stillOpen.map((t) => t.title), ["Burpees"]); // 09-11…09-13 still ahead
  assert.equal(r.counts.done, 3);
});

test("weekTaskReview: a past recurring occurrence left unticked is a miss", () => {
  const reading = task({
    title: "Reading",
    scheduled: "2026-09-07",
    recurrence: "FREQ=DAILY",
    completeInstances: ["2026-09-07", "2026-09-09"],
  });
  const r = weekTaskReview([reading], WK_FROM, WK_TO, WK_TODAY);
  assert.deepEqual(r.doneRecurring[0].dates, ["2026-09-07", "2026-09-09"]);
  assert.deepEqual(r.missedRecurring[0].dates, ["2026-09-08"]);
});

test("weekTaskReview: a multi-slot recurring day is done only once its last slot is ticked", () => {
  const litter = task({
    title: "Litter tray",
    scheduled: "2026-09-07",
    recurrence: "FREQ=DAILY",
    times: [
      { time: "08:00", label: "" },
      { time: "20:00", label: "" },
    ],
    completeSlots: {
      "2026-09-07": ["08:00", "20:00"], // finished
      "2026-09-08": ["08:00"], // partial → not done
    },
  });
  const r = weekTaskReview([litter], WK_FROM, WK_TO, "2026-09-09");
  assert.deepEqual(r.doneRecurring[0].dates, ["2026-09-07"]);
  assert.deepEqual(r.missedRecurring[0].dates, ["2026-09-08"]);
});

test("formatWeekTaskBlock: grouped lists, recurring collapsed to ×N, no wikilinks", () => {
  const r = weekTaskReview(
    [
      task({ title: "Call plumber", status: "done", completed: "2026-09-08" }),
      task({
        title: "Burpees",
        scheduled: "2026-09-07",
        recurrence: "FREQ=DAILY",
        completeInstances: ["2026-09-07", "2026-09-08", "2026-09-09"],
      }),
      task({ title: "File taxes", due: "2026-09-09" }),
      task({ title: "Book dentist", scheduled: "2026-09-12" }),
    ],
    WK_FROM,
    WK_TO,
    WK_TODAY
  );
  const md = formatWeekTaskBlock(r, {
    weekLabel: "2026-W37",
    startISO: WK_FROM,
    endISO: WK_TO,
    generatedISO: WK_TODAY,
  });
  assert.ok(md.startsWith(`*2026-W37 · ${shortDate(WK_FROM)} – ${shortDate(WK_TO)} · generated 2026-09-10*`));
  assert.match(md, /\*\*Done — 4\*\*\n- Call plumber\n- Burpees ×3/);
  assert.match(md, new RegExp(`\\*\\*Missed — 1\\*\\*\\n- File taxes — due ${shortDate("2026-09-09")}`));
  assert.match(md, /\*\*Still open — 2\*\*/);
  assert.match(md, /- Burpees \(recurring\)/);
  assert.doesNotMatch(md, /\[\[/);
});

test("formatWeekTaskBlock: an empty week is a single italic line", () => {
  const md = formatWeekTaskBlock(weekTaskReview([], WK_FROM, WK_TO, WK_TODAY), {
    weekLabel: "2026-W37",
    startISO: WK_FROM,
    endISO: WK_TO,
    generatedISO: WK_TODAY,
  });
  assert.match(md, /_Nothing tracked for this week\._/);
});
