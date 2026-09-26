import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOccurrenceISO, parseRRule, firstOnOrAfter, effectiveStart, setUntil, stripEnd } from "../src/rrule.ts";
import { parseISO, formatISO } from "../src/dates.ts";

// ── The three REAL routines from the vault ──────────────────────────────────
// Clean Dreo fan:  "DTSTART:20260726;FREQ=MONTHLY;BYDAY=-1SU"   (last Sunday monthly)
// Submit timecard: "DTSTART:20260801;FREQ=MONTHLY;BYMONTHDAY=1" (1st of month)
// Weekly review:   "DTSTART:20260712;FREQ=WEEKLY;BYDAY=SU"      (every Sunday)

test("monthly last Sunday (Clean Dreo fan)", () => {
  const r = "DTSTART:20260726;FREQ=MONTHLY;BYDAY=-1SU";
  // 2026-07-26 is the last Sunday of July 2026. Next after it:
  assert.equal(nextOccurrenceISO(r, null, "2026-07-26", "2026-07-26"), "2026-08-30"); // last Sun Aug
  assert.equal(nextOccurrenceISO(r, null, "2026-08-30", "2026-07-26"), "2026-09-27"); // last Sun Sep
  assert.equal(nextOccurrenceISO(r, null, "2026-09-27", "2026-07-26"), "2026-10-25"); // last Sun Oct
});

test("monthly by month-day 1 (Submit timecard)", () => {
  const r = "DTSTART:20260801;FREQ=MONTHLY;BYMONTHDAY=1";
  assert.equal(nextOccurrenceISO(r, null, "2026-08-01", "2026-08-01"), "2026-09-01");
  assert.equal(nextOccurrenceISO(r, null, "2026-09-01", "2026-08-01"), "2026-10-01");
  assert.equal(nextOccurrenceISO(r, null, "2027-01-01", "2026-08-01"), "2027-02-01");
});

test("weekly on Sunday (Weekly review)", () => {
  const r = "DTSTART:20260712;FREQ=WEEKLY;BYDAY=SU";
  assert.equal(nextOccurrenceISO(r, null, "2026-07-12", "2026-07-12"), "2026-07-19");
  assert.equal(nextOccurrenceISO(r, null, "2026-07-19", "2026-07-12"), "2026-07-26");
});

test("firstOnOrAfter returns the anchor when it matches", () => {
  const r = parseRRule("FREQ=WEEKLY;BYDAY=SU")!;
  const start = parseISO("2026-07-12")!; // a Sunday
  const first = firstOnOrAfter(r, start, parseISO("2026-07-12")!);
  assert.equal(formatISO(first!), "2026-07-12");
});

test("interval: every 2 weeks on Monday", () => {
  const r = "DTSTART:20260706;FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"; // 2026-07-06 is a Monday
  assert.equal(nextOccurrenceISO(r, null, "2026-07-06", "2026-07-06"), "2026-07-20");
  assert.equal(nextOccurrenceISO(r, null, "2026-07-20", "2026-07-06"), "2026-08-03");
});

test("daily with interval 3", () => {
  const r = "DTSTART:20260724;FREQ=DAILY;INTERVAL=3";
  assert.equal(nextOccurrenceISO(r, null, "2026-07-24", "2026-07-24"), "2026-07-27");
  assert.equal(nextOccurrenceISO(r, null, "2026-07-27", "2026-07-24"), "2026-07-30");
});

test("yearly", () => {
  const r = "DTSTART:20260101;FREQ=YEARLY";
  assert.equal(nextOccurrenceISO(r, null, "2026-01-01", "2026-01-01"), "2027-01-01");
});

test("UNTIL ends the series", () => {
  const r = "DTSTART:20260712;FREQ=WEEKLY;BYDAY=SU;UNTIL=20260726";
  assert.equal(nextOccurrenceISO(r, null, "2026-07-19", "2026-07-12"), "2026-07-26");
  assert.equal(nextOccurrenceISO(r, null, "2026-07-26", "2026-07-12"), null);
});

test("second Monday of month (ordinal BYDAY)", () => {
  const r = "DTSTART:20260701;FREQ=MONTHLY;BYDAY=2MO";
  // 2nd Monday of Aug 2026 = 2026-08-10; of Sep = 2026-09-14
  assert.equal(nextOccurrenceISO(r, null, "2026-07-13", "2026-07-01"), "2026-08-10");
  assert.equal(nextOccurrenceISO(r, null, "2026-08-10", "2026-07-01"), "2026-09-14");
});

test("setUntil / stripEnd (recurring 'this & following' split)", () => {
  assert.equal(setUntil("FREQ=WEEKLY;BYDAY=MO", "2026-08-09"), "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260809");
  // replaces an existing UNTIL rather than duplicating
  assert.equal(setUntil("FREQ=DAILY;UNTIL=20260101", "2026-08-09"), "FREQ=DAILY;UNTIL=20260809");
  // the truncated series stops producing dates after UNTIL
  const r = "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260809"; // Mondays; 2026-08-10 is a Monday
  assert.equal(nextOccurrenceISO(r, null, "2026-08-03", "2026-07-06"), null);
  // stripEnd removes UNTIL/COUNT so the new series runs on
  assert.equal(stripEnd("FREQ=WEEKLY;BYDAY=MO;UNTIL=20260809"), "FREQ=WEEKLY;BYDAY=MO");
});

test("deleting 'this and following' truncates the series at the previous day", () => {
  // Weekly Mondays from 2026-07-06; delete from 2026-07-20 onward → UNTIL the 19th.
  const rule = "FREQ=WEEKLY;BYDAY=MO";
  const truncated = setUntil(rule, "2026-07-19");
  assert.equal(truncated, "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260719");
  // The 13th survives; the 20th and everything after is gone.
  assert.equal(nextOccurrenceISO(truncated, "2026-07-06", "2026-07-06", "2026-07-06"), "2026-07-13");
  assert.equal(nextOccurrenceISO(truncated, "2026-07-06", "2026-07-13", "2026-07-06"), null);
});

test("parse handles DTSTART= and no-DTSTART forms", () => {
  assert.ok(parseRRule("FREQ=DAILY"));
  assert.ok(parseRRule("DTSTART=2026-07-26;FREQ=MONTHLY;BYDAY=-1SU"));
  assert.equal(parseRRule("nonsense"), null);
  assert.equal(parseRRule(""), null);
});
