import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCapture } from "../src/nlp.ts";

// Friday 31 July 2026, fixed so nothing depends on the wall clock.
const NOW = new Date(Date.UTC(2026, 6, 31));
const p = (s: string) => parseCapture(s, NOW);

test("a plain title is left completely alone", () => {
  const r = p("Call the plumber");
  assert.equal(r.title, "Call the plumber");
  assert.equal(r.date, null);
  assert.deepEqual(r.matched, []);
});

test("the full sentence — everything at once", () => {
  const r = p("Water plants every sunday at 9am @home !high ~20m");
  assert.equal(r.title, "Water plants");
  assert.equal(r.recurrence, "FREQ=WEEKLY;BYDAY=SU");
  assert.equal(r.startTime, "09:00");
  assert.deepEqual(r.contexts, ["home"]);
  assert.equal(r.priority, "high");
  assert.equal(r.estimate, 20);
});

// ── the title must never keep what was parsed ──

test("recognised text is removed from the title", () => {
  assert.equal(p("Submit expenses tomorrow").title, "Submit expenses");
  assert.equal(p("Gym at 7am").title, "Gym");
  assert.equal(p("Pay rent by 3 aug").title, "Pay rent");
  assert.equal(p("Standup every weekday at 9:15").title, "Standup");
});

test("everything recognised is reported, so the UI can show it", () => {
  const r = p("Review notes tomorrow at 4pm @obsidian");
  assert.deepEqual(r.matched.map((m) => m.label), ["on 2026-08-01", "at 16:00", "@obsidian"]);
});

// ── dates ──

test("relative dates", () => {
  assert.equal(p("x today").date, "2026-07-31");
  assert.equal(p("x tomorrow").date, "2026-08-01");
  assert.equal(p("x in 3 days").date, "2026-08-03");
  assert.equal(p("x in 2 weeks").date, "2026-08-14");
  assert.equal(p("x next week").date, "2026-08-07");
});

test("a bare weekday means the COMING one, never today", () => {
  // 31 July 2026 is a Friday.
  assert.equal(p("x friday").date, "2026-08-07"); // not today
  assert.equal(p("x monday").date, "2026-08-03");
  assert.equal(p("x sat").date, "2026-08-01");
});

test("'next friday' skips a further week than a bare 'friday'", () => {
  assert.equal(p("x next friday").date, "2026-08-14");
  assert.equal(p("x next monday").date, "2026-08-10");
});

test("month-name dates, both orders, rolling to next year when past", () => {
  assert.equal(p("x 3 aug").date, "2026-08-03");
  assert.equal(p("x aug 3").date, "2026-08-03");
  assert.equal(p("x 3rd august 2027").date, "2027-08-03");
  assert.equal(p("x 1 january").date, "2027-01-01"); // already gone this year
  assert.equal(p("x 2026-12-25").date, "2026-12-25");
});

test("'by <date>' is a deadline, not a do-date", () => {
  const r = p("File tax return by friday");
  assert.equal(r.due, "2026-08-07");
  assert.equal(r.date, null);
  assert.equal(r.title, "File tax return");
});

test("an impossible date isn't invented", () => {
  const r = p("x 31 feb");
  assert.equal(r.date, null);
  assert.equal(r.title, "x 31 feb"); // left in the title rather than guessed at
});

// ── times ──

test("times in the forms people type them", () => {
  assert.equal(p("x at 9am").startTime, "09:00");
  assert.equal(p("x at 9:30").startTime, "09:30");
  assert.equal(p("x at 19:00").startTime, "19:00");
  assert.equal(p("x 7pm").startTime, "19:00");
  assert.equal(p("x at 12am").startTime, "00:00");
  assert.equal(p("x at 12pm").startTime, "12:00");
});

test("a bare evening-ish hour is read as pm — 'at 7' means 19:00 in a planner", () => {
  assert.equal(p("Dinner at 7").startTime, "19:00");
  assert.equal(p("Standup at 9:15").startTime, "09:15"); // explicit minutes are literal
});

test("time ranges, including a meridiem that applies to both halves", () => {
  const a = p("Workshop 9-10am");
  assert.equal(a.startTime, "09:00");
  assert.equal(a.endTime, "10:00");
  const b = p("Call from 14:00 to 15:30");
  assert.equal(b.startTime, "14:00");
  assert.equal(b.endTime, "15:30");
  assert.equal(b.title, "Call");
});

test("'for 45m' sets an end time when there's a start, else an estimate", () => {
  const withStart = p("Deep work at 20:00 for 90m");
  assert.equal(withStart.startTime, "20:00");
  assert.equal(withStart.endTime, "21:30");
  const noStart = p("Tidy the shed for 45m");
  assert.equal(noStart.endTime, null);
  assert.equal(noStart.estimate, 45);
});

// ── recurrence ──

test("repeat phrases become RRULEs", () => {
  assert.equal(p("x every day").recurrence, "FREQ=DAILY");
  assert.equal(p("x daily").recurrence, "FREQ=DAILY");
  assert.equal(p("x every weekday").recurrence, "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  assert.equal(p("x every 2 weeks").recurrence, "FREQ=WEEKLY;INTERVAL=2");
  assert.equal(p("x every monday").recurrence, "FREQ=WEEKLY;BYDAY=MO");
  assert.equal(p("x every mon and thu").recurrence, "FREQ=WEEKLY;BYDAY=MO,TH");
  assert.equal(p("x every month").recurrence, "FREQ=MONTHLY");
});

test("'every monday' is a repeat, NOT a one-off date", () => {
  const r = p("Bins out every monday");
  assert.equal(r.recurrence, "FREQ=WEEKLY;BYDAY=MO");
  assert.equal(r.title, "Bins out");
  assert.equal(r.date, "2026-07-31"); // starts today so it has something to recur from
});

// ── sigils ──

test("contexts, priority and estimate", () => {
  const r = p("Buy milk @shopping @errand !low ~15m");
  assert.deepEqual(r.contexts, ["shopping", "errand"]);
  assert.equal(r.priority, "low");
  assert.equal(r.estimate, 15);
  assert.equal(r.title, "Buy milk");
});

test("priority shorthands", () => {
  assert.equal(p("x !!").priority, "high");
  assert.equal(p("x !1").priority, "high");
  assert.equal(p("x !3").priority, "low");
  assert.equal(p("x !high").priority, "high");
});

test("estimates accept the same forms as the estimate field", () => {
  assert.equal(p("x ~1h").estimate, 60);
  assert.equal(p("x ~1h30").estimate, 90);
  assert.equal(p("x ~90").estimate, 90);
});

// ── things that must NOT be parsed ──

test("an email address isn't mistaken for a context", () => {
  const r = p("Email bob@example.com about the quote");
  assert.deepEqual(r.contexts, []); // @ must follow whitespace or start
  assert.ok(r.title.includes("bob@example.com"));
});

test("ordinary words containing a day or month name are left alone", () => {
  assert.equal(p("Sunday roast recipe").date !== null, true); // 'Sunday' IS a date word…
  // …but a word merely containing one is not.
  const r = p("Mayonnaise and marchpane");
  assert.equal(r.date, null);
  assert.equal(r.title, "Mayonnaise and marchpane");
});

test("only the first of each kind wins, so a second date doesn't overwrite", () => {
  const r = p("x tomorrow friday");
  assert.equal(r.date, "2026-08-01"); // 'tomorrow' came first
});

test("an empty or whitespace input is safe", () => {
  const r = p("   ");
  assert.equal(r.title, "");
  assert.equal(r.date, null);
});

test("adjacent matches don't cannibalise each other's whitespace", () => {
  // Regression: patterns ending in \s* used to claim the space that the NEXT match needed
  // as its leading boundary, so the later one was silently dropped.
  const a = p("Deep work tomorrow 20:00-21:30 @obsidian");
  assert.equal(a.title, "Deep work");
  assert.equal(a.startTime, "20:00");
  assert.equal(a.endTime, "21:30"); // was lost, leaving "-21:30" in the title
  assert.deepEqual(a.contexts, ["obsidian"]);

  const b = p("Weekly review every sunday at 6pm ~30m @tasks");
  assert.equal(b.title, "Weekly review");
  assert.equal(b.estimate, 30); // was dropped when a context followed it
  assert.deepEqual(b.contexts, ["tasks"]);
});

test("a whole realistic line lands every field", () => {
  const r = p("Bins out every monday at 7pm @home ~10m");
  assert.equal(r.title, "Bins out");
  assert.equal(r.recurrence, "FREQ=WEEKLY;BYDAY=MO");
  assert.equal(r.startTime, "19:00");
  assert.equal(r.estimate, 10);
  assert.deepEqual(r.contexts, ["home"]);
});
