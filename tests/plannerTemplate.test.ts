import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeTemplate,
  durationBetween,
  normaliseTime,
  parsePlannerTemplate,
  resolveEvent,
  resolveTask,
  sortTemplates,
  templateCommandId,
  templateFileName,
  TemplateNote,
  templateNoteFromEvent,
  templateNoteFromTask,
} from "../src/plannerTemplate";

/** A Wednesday, so "next monday" has an unambiguous answer. */
const NOW = new Date("2026-10-14T09:00:00Z");
const CTX = { date: "2026-10-14", defaultMinutes: 30, now: NOW };

const note = (basename: string, frontmatter: Record<string, unknown>, body = ""): TemplateNote => ({
  path: `_Template/Planner/${basename}.md`,
  basename,
  frontmatter,
  body,
});

test("a note only becomes a template if it says it is one", () => {
  // The folder is not enough: a README or a folder note living beside the library must not turn
  // into a template that shows up in every picker.
  assert.equal(parsePlannerTemplate(note("Planner", { up: "[[Home]]" })), null);
  assert.equal(parsePlannerTemplate(note("Notes", {})), null);
  assert.equal(parsePlannerTemplate(note("Meeting", { planner_template: "event" }))?.kind, "event");
  assert.equal(parsePlannerTemplate(note("Prep", { kind: "task" }))?.kind, "task");
  assert.equal(parsePlannerTemplate(note("Odd", { planner_template: "reminder" })), null);
});

test("the name comes from the note, with a trailing \"Template\" stripped", () => {
  assert.equal(parsePlannerTemplate(note("Meeting Template", { planner_template: "event" }))?.name, "Meeting");
  assert.equal(parsePlannerTemplate(note("Job", { planner_template: "event" }))?.name, "Job");
  // An explicit name wins over the filename.
  assert.equal(parsePlannerTemplate(note("evt-01", { planner_template: "event", name: "Client call" }))?.name, "Client call");
  // Stripping must not leave an empty name.
  assert.equal(parsePlannerTemplate(note("Template", { planner_template: "event" }))?.name, "Template");
});

test("frontmatter keys are matched loosely, because these are hand-written notes", () => {
  const a = parsePlannerTemplate(note("A", { planner_template: "event", start_time: "09:00", all_day: false }));
  const b = parsePlannerTemplate(note("B", { planner_template: "event", "Start Time": "09:00", allDay: false }));
  const c = parsePlannerTemplate(note("C", { planner_template: "event", startTime: "09:00", "all day": "no" }));
  for (const t of [a, b, c]) {
    assert.equal(t?.event.startTime, "09:00");
    assert.equal(t?.event.allDay, false);
  }
});

test("times are normalised, and nonsense is dropped rather than guessed", () => {
  assert.equal(normaliseTime("09:00"), "09:00");
  assert.equal(normaliseTime("9:00"), "09:00");
  assert.equal(normaliseTime("0900"), "09:00");
  assert.equal(normaliseTime("9am"), "09:00");
  assert.equal(normaliseTime("5pm"), "17:00");
  assert.equal(normaliseTime("12pm"), "12:00");
  assert.equal(normaliseTime("12am"), "00:00");
  assert.equal(normaliseTime("14:30"), "14:30");
  assert.equal(normaliseTime("25:00"), undefined);
  assert.equal(normaliseTime("half nine"), undefined);
  assert.equal(normaliseTime(""), undefined);
});

test("an event's end comes from duration when no end time is given", () => {
  const t = parsePlannerTemplate(note("Meeting", { planner_template: "event", start_time: "10:00", duration: 45 }))!;
  const r = resolveEvent(t, CTX);
  assert.equal(r.startTime, "10:00");
  assert.equal(r.endTime, "10:45");

  // An explicit end wins over duration.
  const explicit = parsePlannerTemplate(note("M2", { planner_template: "event", start_time: "10:00", duration: 45, end_time: "11:30" }))!;
  assert.equal(resolveEvent(explicit, CTX).endTime, "11:30");

  // Neither given: fall back to the plugin's default meeting length.
  const bare = parsePlannerTemplate(note("M3", { planner_template: "event", start_time: "10:00" }))!;
  assert.equal(resolveEvent(bare, CTX).endTime, "10:30");
});

test("an all-day template carries no times, whatever it was given", () => {
  const t = parsePlannerTemplate(note("Leave", { planner_template: "event", all_day: true, start_time: "09:00", duration: 60 }))!;
  const r = resolveEvent(t, CTX);
  assert.equal(r.allDay, true);
  assert.equal(r.endTime, undefined);
});

test("dates are written as phrases and resolved at creation — the whole point of the format", () => {
  // A template must work in March and in October, so it can never hold a real date.
  const t = parsePlannerTemplate(note("Standup", { planner_template: "event", date: "tomorrow" }))!;
  assert.equal(resolveEvent(t, CTX).date, "2026-10-15");

  const monday = parsePlannerTemplate(note("Review", { planner_template: "event", date: "next monday" }))!;
  assert.equal(resolveEvent(monday, CTX).date, "2026-10-19");

  // No date, or an unparseable one: the context day applies — a clicked calendar cell, or today.
  const bare = parsePlannerTemplate(note("Ad hoc", { planner_template: "event" }))!;
  assert.equal(resolveEvent(bare, CTX).date, "2026-10-14");
  const junk = parsePlannerTemplate(note("Junk", { planner_template: "event", date: "whenever" }))!;
  assert.equal(resolveEvent(junk, CTX).date, "2026-10-14");
});

test("a task with no date stays unscheduled rather than landing on today", () => {
  // Unlike an event, a task is allowed to have no date at all, and silently scheduling one for
  // today would put work in front of you that you never asked for.
  const bare = parsePlannerTemplate(note("Someday", { planner_template: "task" }))!;
  assert.equal(resolveTask(bare, CTX).scheduled, undefined);

  const soon = parsePlannerTemplate(note("Soon", { planner_template: "task", scheduled: "tomorrow", due: "next friday" }))!;
  const r = resolveTask(soon, CTX);
  assert.equal(r.scheduled, "2026-10-15");
  assert.equal(r.due, "2026-10-16");
});

test("task fields parse: priority, contexts, estimate, slots, repeat", () => {
  const t = parsePlannerTemplate(
    note("Prep work bag", {
      planner_template: "task",
      priority: "high",
      context: "home, evening",
      estimate: 10,
      remind: "none",
      repeat: "FREQ=WEEKLY;BYDAY=SU",
      recurrence_anchor: "due",
      times: ["08:00 Morning", "20:00 Evening", "nonsense"],
    })
  )!;
  assert.equal(t.task.priority, "high");
  assert.deepEqual(t.task.contexts, ["home", "evening"]);
  assert.equal(t.task.estimate, 10);
  assert.equal(t.task.remind, "none");
  assert.equal(t.task.recurrence, "FREQ=WEEKLY;BYDAY=SU");
  assert.equal(t.task.recurrenceAnchor, "due");
  // The unparseable slot is dropped; the good ones survive with their labels.
  assert.deepEqual(t.task.times, [
    { time: "08:00", label: "Morning" },
    { time: "20:00", label: "Evening" },
  ]);
  // An invalid priority is ignored rather than coerced.
  const bad = parsePlannerTemplate(note("B", { planner_template: "task", priority: "urgent" }))!;
  assert.equal(bad.task.priority, undefined);
});

test("the body is carried, so a template can ship an agenda", () => {
  const t = parsePlannerTemplate(
    note("Meeting", { planner_template: "event" }, "\n## Agenda\n\n## Attendees\n\n## Actions\n")
  )!;
  assert.equal(t.body, "## Agenda\n\n## Attendees\n\n## Actions");
});

test("an event template never writes task fields, and the reverse", () => {
  const ev = parsePlannerTemplate(note("E", { planner_template: "event", priority: "high", category: "Professional" }))!;
  assert.deepEqual(ev.task, {});
  assert.equal(ev.event.category, "Professional");
  const tk = parsePlannerTemplate(note("T", { planner_template: "task", category: "Professional", priority: "high" }))!;
  assert.deepEqual(tk.event, {});
  assert.equal(tk.task.priority, "high");
});

test("the library is shown in one order everywhere: order, then name", () => {
  const mk = (name: string, order?: number) =>
    parsePlannerTemplate(note(name, { planner_template: "event", ...(order === undefined ? {} : { order }) }))!;
  const sorted = sortTemplates([mk("Zebra", 10), mk("Apple"), mk("Meeting", 10), mk("Banana")]);
  assert.deepEqual(sorted.map((t) => t.name), ["Meeting", "Zebra", "Apple", "Banana"]);
});

test("command ids are slugs, so a hotkey survives the note being renamed in prose", () => {
  const t = parsePlannerTemplate(note("x", { planner_template: "event", name: "Client call (weekly)" }))!;
  assert.equal(templateCommandId(t), "brewin-new-event-client-call-weekly");
  const odd = parsePlannerTemplate(note("y", { planner_template: "task", name: "!!!" }))!;
  assert.equal(templateCommandId(odd), "brewin-new-task-template");
});

test("bundle is parsed and carried, and nothing reads it yet", () => {
  const t = parsePlannerTemplate(note("Work day", { planner_template: "event", bundle: ["Commute in", "Commute home"] }))!;
  assert.deepEqual(t.bundle, ["Commute in", "Commute home"]);
  assert.deepEqual(parsePlannerTemplate(note("Solo", { planner_template: "event" }))!.bundle, []);
});

test("a time the user pressed beats the template's own, and takes the template's duration", () => {
  // Long-press the 14:00 slot and pick a 30-minute Meeting written for 10:00: pressing a specific
  // hour is the more deliberate act, so 14:00 wins — but it stays a 30-minute meeting.
  const t = parsePlannerTemplate(note("Meeting", { planner_template: "event", start_time: "10:00", duration: 30, end_time: "10:30" }))!;
  const pressed = resolveEvent(t, { ...CTX, startTime: "14:00" });
  assert.equal(pressed.startTime, "14:00");
  assert.equal(pressed.endTime, "14:30", "the written end time must not leak through");

  // With no duration written, the caller's default length applies.
  const bare = parsePlannerTemplate(note("Chat", { planner_template: "event", start_time: "10:00" }))!;
  assert.equal(resolveEvent(bare, { ...CTX, startTime: "16:15" }).endTime, "16:45");

  // Nothing pressed: the template is used as written.
  assert.equal(resolveEvent(t, CTX).endTime, "10:30");
});

test("the same override applies to tasks", () => {
  const t = parsePlannerTemplate(note("Gym", { planner_template: "task", start_time: "07:00", duration: 45 }))!;
  const pressed = resolveTask(t, { ...CTX, startTime: "18:00" });
  assert.equal(pressed.startTime, "18:00");
  assert.equal(pressed.endTime, "18:45");
});

test("each template summarises itself for the pickers", () => {
  const meeting = parsePlannerTemplate(
    note("Meeting", { planner_template: "event", category: "Professional", start_time: "10:00", duration: 30 })
  )!;
  assert.equal(describeTemplate(meeting), "event · Professional · 10:00 · 30m");

  const leave = parsePlannerTemplate(note("Leave", { planner_template: "event", all_day: true, category: "Personal" }))!;
  assert.equal(describeTemplate(leave), "event · Personal · all day");

  const prep = parsePlannerTemplate(
    note("Prep", { planner_template: "task", priority: "high", estimate: 10, context: "home", scheduled: "today" })
  )!;
  assert.equal(describeTemplate(prep), "task · high priority · 10m · home · → today");
});

test("saving an event as a template omits the date and keeps the duration", () => {
  // A template that hardcoded the day it was made from would be wrong tomorrow; and a written end
  // time would be wrong the moment you dropped it on a different hour.
  const text = templateNoteFromEvent("Job", {
    title: "Work — Tuesday",
    category: "Professional",
    allDay: false,
    startTime: "09:00",
    endTime: "17:00",
    recurrence: null,
    remind: "none",
    remindStart: null,
    location: "Office",
  });
  assert.match(text, /planner_template: event/);
  assert.match(text, /name: "Job"/);
  assert.match(text, /title: "Job"/, "the template's title is its name, not the one-off event's");
  assert.match(text, /duration: 480/);
  assert.ok(!/date:/.test(text), "no date may be written");
  assert.ok(!/end_time:/.test(text), "duration replaces the end time");
  assert.match(text, /location: "Office"/);

  // It must round-trip: parse what we just wrote and get the same shape back.
  const fm: Record<string, unknown> = {};
  for (const line of text.split("\n").slice(1)) {
    if (line === "---") break;
    const m = /^([a-z_]+): (.*)$/.exec(line);
    if (m) fm[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  const round = parsePlannerTemplate(note("Job", fm))!;
  assert.equal(round.kind, "event");
  assert.equal(round.name, "Job");
  assert.equal(round.event.startTime, "09:00");
  assert.equal(resolveEvent(round, CTX).endTime, "17:00", "480 minutes from 09:00");
  assert.equal(resolveEvent(round, CTX).date, CTX.date, "the date comes from the day you create it");
});

test("an all-day event saves without times", () => {
  const text = templateNoteFromEvent("Leave", {
    title: "Leave",
    category: "Personal",
    allDay: true,
    startTime: "09:00",
    endTime: "17:00",
    recurrence: null,
    remind: null,
    remindStart: null,
    location: null,
  });
  assert.match(text, /all_day: true/);
  assert.ok(!/start_time:/.test(text));
  assert.ok(!/duration:/.test(text));
});

test("saving a task as a template carries its checklist and slots", () => {
  const text = templateNoteFromTask("Prep work bag", {
    title: "Prep work bag",
    priority: "high",
    contexts: ["home", "evening"],
    estimate: 10,
    startTime: "20:30",
    endTime: "20:40",
    recurrence: "FREQ=WEEKLY;BYDAY=SU",
    remind: "10m",
    remindStart: null,
    times: [{ time: "08:00", label: "Morning" }],
    body: "- [ ] Laptop\n- [ ] Badge",
  });
  assert.match(text, /planner_template: task/);
  assert.match(text, /priority: high/);
  assert.match(text, /contexts: home, evening/);
  assert.match(text, /estimate: 10/);
  assert.match(text, /duration: 10/);
  assert.match(text, /times: \["08:00 Morning"\]/);
  assert.match(text, /- \[ \] Laptop/);
  assert.ok(!/scheduled:/.test(text), "a saved task template must not pin a date either");
});

test("durations, including the ones that make no sense", () => {
  assert.equal(durationBetween("09:00", "17:00"), 480);
  assert.equal(durationBetween("10:00", "10:30"), 30);
  assert.equal(durationBetween("23:30", "00:30"), null, "crossing midnight is not a duration here");
  assert.equal(durationBetween("10:00", "10:00"), null);
  assert.equal(durationBetween(null, "10:00"), null);
  assert.equal(durationBetween("10:00", null), null);
});

test("a template filename survives a name with punctuation in it", () => {
  assert.equal(templateFileName("Client call / review"), "Client call  review");
  assert.equal(templateFileName("1:1"), "11");
  assert.equal(templateFileName("***"), "Template");
});
