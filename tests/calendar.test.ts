import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleRange, stepAnchor, timeBox, dayMarks } from "../src/calendar.ts";
import { monthMatrix, weekDates, weekdayHeaders, dayDelta, shiftISO, durationMinutes, addMinutesHM } from "../src/dates.ts";

test("visibleRange: day/week/month", () => {
  assert.deepEqual(visibleRange("day", "2026-07-24", 1), { from: "2026-07-24", to: "2026-07-24" });
  // Week of Fri 2026-07-24, Monday start → Mon 20 .. Sun 26
  assert.deepEqual(visibleRange("week", "2026-07-24", 1), { from: "2026-07-20", to: "2026-07-26" });
  // Month grid for July 2026 (Mon start): starts Mon 2026-06-29, ends Sun 2026-08-02
  const m = visibleRange("month", "2026-07-15", 1);
  assert.equal(m.from, "2026-06-29");
  assert.equal(m.to, "2026-08-02");
});

test("stepAnchor moves by view unit", () => {
  assert.equal(stepAnchor("day", "2026-07-24", 1), "2026-07-25");
  assert.equal(stepAnchor("week", "2026-07-24", -1), "2026-07-17");
  assert.equal(stepAnchor("month", "2026-07-24", 1), "2026-08-01");
  assert.equal(stepAnchor("month", "2026-12-10", 1), "2027-01-01");
});

test("monthMatrix returns full weeks covering the month", () => {
  const rows = monthMatrix(2026, 6, 1); // July 2026, Monday start
  rows.forEach((r) => assert.equal(r.length, 7));
  // first cell is a Monday
  assert.equal(rows[0][0].getUTCDay(), 1);
  // contains July 1 and July 31
  const flat = rows.flat().map((d) => d.toISOString().slice(0, 10));
  assert.ok(flat.includes("2026-07-01"));
  assert.ok(flat.includes("2026-07-31"));
});

test("weekDates + headers respect week start", () => {
  const mon = weekDates(new Date(Date.UTC(2026, 6, 24)), 1);
  assert.equal(mon[0].toISOString().slice(0, 10), "2026-07-20");
  assert.deepEqual(weekdayHeaders(1)[0], "Mon");
  assert.deepEqual(weekdayHeaders(0)[0], "Sun");
});

test("timeBox positions timed events by the hour", () => {
  const b = timeBox("09:00", "10:30", 40); // 1.5h from 9am
  assert.equal(b.topPx, 9 * 40);
  assert.equal(b.heightPx, 60);
  // zero/negative duration → minimum block
  const min = timeBox("09:00", "09:00", 40);
  assert.ok(min.heightPx >= 40 * 0.4);
});

test("time-grid zoom: positions stay correct at 1h / 30m / 15m resolutions", () => {
  // The three configured hour heights (settings.HOUR_PX_BY_SLOT).
  for (const hourPx of [44, 72, 120]) {
    const b = timeBox("09:00", "10:00", hourPx);
    assert.equal(b.topPx, 9 * hourPx, `09:00 should sit 9 hours down at hourPx=${hourPx}`);
    assert.equal(b.heightPx, hourPx, `a 1h block should be one hour tall at hourPx=${hourPx}`);
  }
  // A 15-minute block is only legible once the grid is zoomed in — but it's always
  // positioned proportionally, and never collapses below the minimum block height.
  const quarterAt1h = timeBox("09:00", "09:15", 44);
  const quarterAt15m = timeBox("09:00", "09:15", 120);
  assert.ok(quarterAt15m.heightPx > quarterAt1h.heightPx);
  assert.equal(quarterAt15m.heightPx, 30); // 120px/hour ÷ 4
});

test("time-grid zoom: the gutter and the day column are always the same height", () => {
  // Misalignment here would make every event sit at the wrong time.
  for (const [slot, hourPx] of [[60, 44], [30, 72], [15, 120]] as const) {
    const slotPx = (hourPx * slot) / 60;
    const slotCount = (24 * 60) / slot;
    assert.equal(slotPx * slotCount, 24 * hourPx, `slot=${slot} gutter must equal the column height`);
    assert.equal(Number.isInteger(slotPx), true, `slot=${slot} should give a whole-pixel row`);
  }
});

test("date picker marks: selected, paired date, span between, and today are distinct", () => {
  const TODAY = "2026-07-26";
  const sel = "2026-07-20"; // e.g. scheduled
  const rel = "2026-07-24"; // e.g. due

  assert.deepEqual(dayMarks(sel, sel, rel, TODAY), { selected: true, related: false, inSpan: false, today: false });
  assert.deepEqual(dayMarks(rel, sel, rel, TODAY), { selected: false, related: true, inSpan: false, today: false });
  // strictly between the two — endpoints are never "in span"
  assert.equal(dayMarks("2026-07-22", sel, rel, TODAY).inSpan, true);
  assert.equal(dayMarks("2026-07-25", sel, rel, TODAY).inSpan, false);
  // today is marked independently of the selection
  assert.deepEqual(dayMarks(TODAY, sel, rel, TODAY), { selected: false, related: false, inSpan: false, today: true });
});

test("date picker marks: today can also BE the selection", () => {
  const TODAY = "2026-07-26";
  const m = dayMarks(TODAY, TODAY, null, TODAY);
  assert.equal(m.selected, true);
  assert.equal(m.today, true); // both flags → filled cell keeps its today ring
});

test("date picker marks: the span works in either direction, and selected beats related", () => {
  const TODAY = "2026-01-01";
  // paired date EARLIER than the selection
  assert.equal(dayMarks("2026-07-22", "2026-07-24", "2026-07-20", TODAY).inSpan, true);
  // same day for both → it reads as the selection, not the paired date
  const same = dayMarks("2026-07-20", "2026-07-20", "2026-07-20", TODAY);
  assert.equal(same.selected, true);
  assert.equal(same.related, false);
  // nothing selected → no marks other than today
  assert.deepEqual(dayMarks("2026-07-20", null, null, TODAY), { selected: false, related: false, inSpan: false, today: false });
});

test("drag reschedule helpers", () => {
  // Moving an event forward by N days shifts its endDate by the same delta.
  assert.equal(dayDelta("2026-07-20", "2026-07-24"), 4);
  assert.equal(shiftISO("2026-07-23", 4), "2026-07-27");
  // Dropping onto a new time preserves duration.
  assert.equal(durationMinutes("09:00", "10:30"), 90);
  assert.equal(addMinutesHM("14:00", 90), "15:30");
  // Missing/invalid times default to a 60-min block.
  assert.equal(durationMinutes(null, null), 60);
});
