import { test } from "node:test";
import assert from "node:assert/strict";
import { eventFromFrontmatter, categoryFromPath, eventInRange, eventLastCoveredISO, eventNotePath } from "../src/event.ts";
import { eventsToItems, tasksToItems, sortItems, projectTasksToItems } from "../src/calendarItem.ts";
import { EventItem, Task } from "../src/types.ts";

const EF = "00_Systems/Calendar/Events";

function ev(p: Partial<EventItem>): EventItem {
  return { path: "x", title: "e", date: "2026-07-24", endDate: null, allDay: true, startTime: null, endTime: null, category: "General", originalCategory: "General", archived: false, completed: false, recurrence: null, exdates: [], ...p };
}

test("recurring event expands across the range", () => {
  const weekly = ev({ title: "Standup", date: "2026-07-06", allDay: false, startTime: "09:00", endTime: "09:15", recurrence: "FREQ=WEEKLY;BYDAY=MO" });
  const items = eventsToItems([weekly], "2026-07-01", "2026-07-31");
  // Mondays in July 2026: 6, 13, 20, 27
  assert.deepEqual(items.map((i) => i.date), ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"]);
  assert.ok(items.every((i) => i.recurring && i.start === "09:00"));
});

test("EXDATE skips an excepted occurrence ('this event only')", () => {
  const weekly = ev({ title: "Standup", date: "2026-07-06", allDay: false, startTime: "09:00", endTime: "09:15", recurrence: "FREQ=WEEKLY;BYDAY=MO", exdates: ["2026-07-20"] });
  const items = eventsToItems([weekly], "2026-07-01", "2026-07-31");
  assert.deepEqual(items.map((i) => i.date), ["2026-07-06", "2026-07-13", "2026-07-27"]); // 20th removed
});

test("parse all-day event", () => {
  const e = eventFromFrontmatter(
    { title: "Office Day", allDay: true, date: "2026-05-15", endDate: "2026-05-16" },
    `${EF}/2026-05-15 Office Day.md`, "2026-05-15 Office Day", EF
  );
  assert.equal(e.allDay, true);
  assert.equal(e.date, "2026-05-15");
  assert.equal(e.startTime, null);
  assert.equal(e.category, "General");
});

test("parse timed event + category from subfolder", () => {
  const e = eventFromFrontmatter(
    { title: "Train", allDay: false, date: "2026-05-10", startTime: "17:54", endTime: "18:32" },
    `${EF}/Professional/2026-05-10 Train.md`, "2026-05-10 Train", EF
  );
  assert.equal(e.allDay, false);
  assert.equal(e.startTime, "17:54");
  assert.equal(e.endTime, "18:32");
  assert.equal(e.category, "Professional");
});

test("parse event location; absent frontmatter key stays null, not empty string", () => {
  const withLoc = eventFromFrontmatter(
    { title: "Viewing", allDay: true, date: "2026-05-15", location: "12 High Street, Croydon" },
    `${EF}/2026-05-15 Viewing.md`, "2026-05-15 Viewing", EF
  );
  assert.equal(withLoc.location, "12 High Street, Croydon");

  const withoutLoc = eventFromFrontmatter(
    { title: "Office Day", allDay: true, date: "2026-05-15" },
    `${EF}/2026-05-15 Office Day.md`, "2026-05-15 Office Day", EF
  );
  assert.equal(withoutLoc.location, null);
});

test("eventsToItems carries location through to every recurring occurrence", () => {
  const weekly = ev({
    title: "Standup", date: "2026-07-06", allDay: false, startTime: "09:00", endTime: "09:15",
    recurrence: "FREQ=WEEKLY;BYDAY=MO", location: "Meeting Room 4",
  });
  const items = eventsToItems([weekly], "2026-07-01", "2026-07-31");
  assert.equal(items.length, 4);
  assert.ok(items.every((i) => i.location === "Meeting Room 4"));
});

test("eventNotePath: the category IS the folder, so changing it changes the path", () => {
  // The bug this fixes: editing an event's category left the note in its old folder.
  const before = eventNotePath(EF, "General", "2026-07-25", "Obsidian work");
  const after = eventNotePath(EF, "Systems", "2026-07-25", "Obsidian work");
  assert.equal(before, `${EF}/2026-07-25 Obsidian work.md`); // General lives at the root
  assert.equal(after, `${EF}/Systems/2026-07-25 Obsidian work.md`);
  assert.notEqual(before, after); // → the store must move the file
});

test("eventNotePath: date and title changes rename the file too", () => {
  assert.equal(eventNotePath(EF, "Personal", "2026-08-01", "Gym"), `${EF}/2026-08-01 Gym.md`.replace(EF, `${EF}/Personal`));
  // Characters a filename can't hold are stripped, and a blank title still yields a name.
  assert.equal(eventNotePath(EF, "General", "2026-07-25", "A/B: test?"), `${EF}/2026-07-25 AB test.md`);
  assert.equal(eventNotePath(EF, "General", "2026-07-25", "///"), `${EF}/2026-07-25 Event.md`);
});

test("eventNotePath: round-trips with categoryFromPath", () => {
  for (const cat of ["General", "Personal", "Professional", "Systems"]) {
    const p = eventNotePath(EF, cat, "2026-07-25", "X");
    assert.equal(categoryFromPath(p, EF), cat, `${cat} should survive the round-trip`);
  }
});

test("categoryFromPath", () => {
  assert.equal(categoryFromPath(`${EF}/Personal/x.md`, EF), "Personal");
  assert.equal(categoryFromPath(`${EF}/x.md`, EF), "General");
});

test("eventLastCoveredISO: single day, and all-day multi-day (exclusive end)", () => {
  const single = ev({ date: "2026-07-20", endDate: null, allDay: true });
  assert.equal(eventLastCoveredISO(single), "2026-07-20");
  // all-day 20→23 exclusive covers 20,21,22 → last covered = 22
  const multi = ev({ date: "2026-07-20", endDate: "2026-07-23", allDay: true });
  assert.equal(eventLastCoveredISO(multi), "2026-07-22");
});

test("eventInRange handles multi-day", () => {
  const ev: EventItem = { path: "x", title: "Trip", date: "2026-07-20", endDate: "2026-07-23", allDay: true, startTime: null, endTime: null, category: "Personal", completed: false };
  assert.equal(eventInRange(ev, "2026-07-22", "2026-07-25"), true);
  assert.equal(eventInRange(ev, "2026-07-24", "2026-07-30"), false);
});

test("eventsToItems expands multi-day all-day across covered days", () => {
  const ev: EventItem = { path: "x", title: "Trip", date: "2026-07-20", endDate: "2026-07-23", allDay: true, startTime: null, endTime: null, category: "Personal", completed: false };
  const items = eventsToItems([ev], "2026-07-01", "2026-07-31");
  // endDate 07-23 is exclusive → covers 20, 21, 22
  assert.deepEqual(items.map((i) => i.date), ["2026-07-20", "2026-07-21", "2026-07-22"]);
  assert.ok(items.every((i) => i.allDay));
});

test("a timed event crossing midnight renders a block on BOTH days", () => {
  // The real case: worked 22:00 one night until 01:00 the next morning.
  const overnight = ev({
    title: "Obsidian plugin work", date: "2026-07-25", endDate: "2026-07-26",
    allDay: false, startTime: "22:00", endTime: "01:00",
  });
  const items = eventsToItems([overnight], "2026-07-01", "2026-07-31");
  assert.deepEqual(items.map((i) => [i.date, i.start, i.end]), [
    ["2026-07-25", "22:00", "24:00"], // start → midnight
    ["2026-07-26", "00:00", "01:00"], // midnight → end
  ]);
  assert.ok(items.every((i) => !i.allDay)); // both stay timed blocks, not all-day chips
});

test("a multi-day timed event fills the days in between", () => {
  const conf = ev({ date: "2026-07-20", endDate: "2026-07-22", allDay: false, startTime: "09:00", endTime: "17:00" });
  const items = eventsToItems([conf], "2026-07-01", "2026-07-31");
  assert.deepEqual(items.map((i) => [i.date, i.start, i.end]), [
    ["2026-07-20", "09:00", "24:00"],
    ["2026-07-21", "00:00", "24:00"], // full middle day
    ["2026-07-22", "00:00", "17:00"],
  ]);
});

test("eventsToItems keeps time only on the start day", () => {
  const ev: EventItem = { path: "x", title: "Mtg", date: "2026-07-24", endDate: null, allDay: false, startTime: "09:00", endTime: "10:00", category: "General", completed: false };
  const items = eventsToItems([ev], "2026-07-24", "2026-07-24");
  assert.equal(items.length, 1);
  assert.equal(items[0].start, "09:00");
});

test("tasksToItems places on scheduled, falls back to due", () => {
  const tasks: Task[] = [
    { path: "a", title: "A", status: "todo", scheduled: "2026-07-24", due: null, priority: "normal", contexts: [], recurrence: null, recurrenceAnchor: "scheduled", completeInstances: [], onCompletion: "keep", created: null, completed: null },
    { path: "b", title: "B", status: "todo", scheduled: null, due: "2026-07-26", priority: "normal", contexts: [], recurrence: null, recurrenceAnchor: "scheduled", completeInstances: [], onCompletion: "keep", created: null, completed: null },
  ];
  const items = tasksToItems(tasks, "2026-07-01", "2026-07-31");
  assert.deepEqual(items.map((i) => [i.title, i.date]), [["A", "2026-07-24"], ["B", "2026-07-26"]]);
});

test("a task with a startTime becomes a timed block, not an all-day chip", () => {
  const base = { status: "todo" as const, due: null, priority: "normal" as const, contexts: [], recurrence: null,
    recurrenceAnchor: "scheduled" as const, completeInstances: [], onCompletion: "keep" as const,
    created: null, completed: null, parent: null, parentPath: null };
  const items = tasksToItems(
    [
      { ...base, path: "t1", title: "Timed", scheduled: "2026-07-24", startTime: "09:00", endTime: "10:30" },
      { ...base, path: "t2", title: "Allday", scheduled: "2026-07-24", startTime: null, endTime: null },
    ],
    "2026-07-01",
    "2026-07-31"
  );
  const timed = items.find((i) => i.title === "Timed")!;
  assert.equal(timed.allDay, false); // renders in the hour grid
  assert.equal(timed.start, "09:00");
  assert.equal(timed.end, "10:30");
  assert.equal(items.find((i) => i.title === "Allday")!.allDay, true);
});

test("a task shown on its DUE date stays all-day even if it has a start time", () => {
  // The time belongs to the scheduled day; a due-date placement is a deadline marker.
  const items = tasksToItems(
    [{
      path: "t", title: "T", status: "todo", scheduled: null, due: "2026-07-30",
      startTime: "09:00", endTime: "10:00", priority: "normal", contexts: [], recurrence: null,
      recurrenceAnchor: "scheduled", completeInstances: [], onCompletion: "keep",
      created: null, completed: null, parent: null, parentPath: null,
    }],
    "2026-07-01",
    "2026-07-31"
  );
  assert.equal(items[0].allDay, true);
  assert.equal(items[0].start, null);
});

test("projectTasksToItems: places on scheduled||due, tags kind+line, skips undated", () => {
  const items = projectTasksToItems(
    [
      { projectPath: "03_Projects/CCNP ENCOR.md", projectName: "CCNP ENCOR", line: 12, text: "Book exam", scheduled: null, due: "2026-11-06" },
      { projectPath: "p.md", projectName: "p", line: 3, text: "planned", scheduled: "2026-08-01", due: "2026-09-01" },
      { projectPath: "p.md", projectName: "p", line: 4, text: "no date", scheduled: null, due: null },
    ],
    "2026-07-01",
    "2026-12-31",
    "Projects"
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "project");
  assert.equal(items[0].date, "2026-11-06");
  assert.equal(items[0].line, 12);
  assert.equal(items[0].category, "Projects");
  assert.equal(items[1].date, "2026-08-01"); // scheduled wins over due
});

test("sortItems: all-day before timed, then by start", () => {
  const items = sortItems([
    { kind: "event", path: "1", title: "late", date: "2026-07-24", allDay: false, start: "15:00", end: null, done: false, category: "", recurring: false },
    { kind: "event", path: "2", title: "early", date: "2026-07-24", allDay: false, start: "09:00", end: null, done: false, category: "", recurring: false },
    { kind: "task", path: "3", title: "allday", date: "2026-07-24", allDay: true, start: null, end: null, done: false, category: "", recurring: false },
  ]);
  assert.deepEqual(items.map((i) => i.title), ["allday", "early", "late"]);
});

test("sortItems: completed items sink to the bottom of the day", () => {
  const it = (title: string, done: boolean, allDay = true, start: string | null = null) => ({
    kind: "task" as const, path: title, title, date: "2026-07-24", allDay, start, end: null,
    done, category: "", recurring: false,
  });
  const items = sortItems([
    it("done chore", true),
    it("open task", false),
    it("done task", true),
    it("another open", false),
  ]);
  assert.deepEqual(items.map((i) => i.title), ["another open", "open task", "done chore", "done task"]);
});

test("sortItems: the all-day band reads events → tasks → project tasks", () => {
  const it = (kind: "event" | "task" | "project", title: string) => ({
    kind, path: title, title, date: "2026-07-24", allDay: true, start: null, end: null,
    done: false, category: "", recurring: false,
  });
  const items = sortItems([it("project", "Ship v2"), it("task", "Call plumber"), it("event", "Dentist")]);
  assert.deepEqual(items.map((i) => i.title), ["Dentist", "Call plumber", "Ship v2"]);
});

test("sortItems: kind never overrides the clock for TIMED items", () => {
  const it = (kind: "event" | "task", title: string, start: string) => ({
    kind, path: title, title, date: "2026-07-24", allDay: false, start, end: null,
    done: false, category: "", recurring: false,
  });
  // An event at 17:00 must not jump ahead of a task at 09:00 just because events rank first.
  const items = sortItems([it("event", "evening event", "17:00"), it("task", "morning task", "09:00")]);
  assert.deepEqual(items.map((i) => i.title), ["morning task", "evening event"]);
});

test("sortItems: completion still outranks kind", () => {
  const it = (kind: "event" | "task", title: string, done: boolean) => ({
    kind, path: title, title, date: "2026-07-24", allDay: true, start: null, end: null,
    done, category: "", recurring: false,
  });
  // A done event sinks below an open task — finished work leaves the top regardless of kind.
  const items = sortItems([it("event", "done event", true), it("task", "open task", false)]);
  assert.deepEqual(items.map((i) => i.title), ["open task", "done event"]);
});

// ── all-day ⇄ timed conversion on drop (v1.39.3) ────────────────────────────
//
// The two endDate conventions differ: an all-day event's is EXCLUSIVE (the day after the
// last covered), a timed event's is the actual last day. Flipping without adjusting
// silently gains or loses a day.

import { convertEndDate } from "../src/event.ts";

test("timed → all-day pushes the end out, because all-day ends are exclusive", () => {
  // A timed event running 3rd→5th covers three days. As all-day that's endDate 6th.
  assert.equal(convertEndDate("2026-08-03", "2026-08-05", true), "2026-08-06");
});

test("all-day → timed pulls the end back", () => {
  // All-day 3rd→6th (exclusive) covers 3rd–5th. As timed that's endDate 5th.
  assert.equal(convertEndDate("2026-08-03", "2026-08-06", false), "2026-08-05");
});

test("the two conversions are inverses, so a round trip doesn't drift", () => {
  const start = "2026-08-03";
  const timedEnd = "2026-08-05";
  const asAllDay = convertEndDate(start, timedEnd, true)!;
  assert.equal(convertEndDate(start, asAllDay, false), timedEnd);
});

test("a single-day event gains no span from the conversion", () => {
  assert.equal(convertEndDate("2026-08-03", null, true), null);
  assert.equal(convertEndDate("2026-08-03", "2026-08-03", true), null);
  // All-day 3rd→4th covers only the 3rd; as timed that's no span at all.
  assert.equal(convertEndDate("2026-08-03", "2026-08-04", false), null);
});

test("a backwards endDate is discarded rather than propagated", () => {
  assert.equal(convertEndDate("2026-08-05", "2026-08-01", true), null);
  assert.equal(convertEndDate("2026-08-05", "2026-08-01", false), null);
});

test("eventLastCoveredISO agrees with the conversion in both directions", () => {
  // The conversion must preserve which days are actually covered.
  const timed = ev({ date: "2026-08-03", endDate: "2026-08-05", allDay: false });
  const asAllDayEnd = convertEndDate("2026-08-03", "2026-08-05", true);
  const allDay = ev({ date: "2026-08-03", endDate: asAllDayEnd, allDay: true });
  assert.equal(eventLastCoveredISO(timed), eventLastCoveredISO(allDay));
});
