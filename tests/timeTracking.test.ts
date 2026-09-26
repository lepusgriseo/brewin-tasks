import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventMinutes,
  occurrenceDates,
  totalsByCategory,
  grandTotalMinutes,
  formatDuration,
  weeklyTotals,
  periodRange,
  mergeIntervals,
  allocatedMinutes,
  timeBudget,
} from "../src/timeTracking.ts";
import { EventItem } from "../src/types.ts";

function ev(p: Partial<EventItem>): EventItem {
  return {
    path: "x.md",
    title: "e",
    date: "2026-07-20",
    endDate: null,
    allDay: false,
    startTime: "09:00",
    endTime: "10:00",
    category: "Professional",
    originalCategory: "Professional",
    archived: false,
    completed: false,
    recurrence: null,
    exdates: [],
    ...p,
  };
}

test("eventMinutes: timed events measured, all-day ignored", () => {
  assert.equal(eventMinutes(ev({ startTime: "09:00", endTime: "10:30" })), 90);
  assert.equal(eventMinutes(ev({ startTime: "17:54", endTime: "18:32" })), 38);
  assert.equal(eventMinutes(ev({ allDay: true, startTime: null, endTime: null })), 0);
  assert.equal(eventMinutes(ev({ startTime: "09:00", endTime: null })), 0); // half-specified
});

test("eventMinutes: an event running past midnight isn't negative", () => {
  assert.equal(eventMinutes(ev({ startTime: "23:30", endTime: "00:30" })), 60);
});

test("eventMinutes: an overnight session with an end DATE spans midnight correctly", () => {
  // "Worked on Obsidian 22:00 last night until 01:00 this morning" = 3 hours.
  const overnight = ev({ date: "2026-07-25", endDate: "2026-07-26", startTime: "22:00", endTime: "01:00" });
  assert.equal(eventMinutes(overnight), 180);
});

test("eventMinutes: a multi-day timed event counts every hour in between", () => {
  // 09:00 Mon → 17:00 Wed = 2 whole days + 8h = 56h
  const conf = ev({ date: "2026-07-20", endDate: "2026-07-22", startTime: "09:00", endTime: "17:00" });
  assert.equal(eventMinutes(conf), 2 * 1440 + 8 * 60);
});

test("totals group by category, sorted largest first, with shares", () => {
  const totals = totalsByCategory(
    [
      ev({ path: "a", startTime: "09:00", endTime: "10:00" }), // Professional 60
      ev({ path: "b", startTime: "14:00", endTime: "15:30" }), // Professional 90
      ev({ path: "c", category: "Personal", originalCategory: "Personal", startTime: "18:00", endTime: "18:30" }), // 30
      ev({ path: "d", allDay: true, startTime: null, endTime: null }), // ignored
    ],
    "2026-07-01",
    "2026-07-31"
  );
  assert.deepEqual(totals.map((t) => [t.category, t.minutes, t.count]), [
    ["Professional", 150, 2],
    ["Personal", 30, 1],
  ]);
  assert.equal(grandTotalMinutes(totals), 180);
  assert.ok(Math.abs(totals[0].share - 150 / 180) < 1e-9);
});

test("ARCHIVED events count under their ORIGINAL category, not 'Archived'", () => {
  const totals = totalsByCategory(
    [ev({ archived: true, category: "Archived", originalCategory: "Professional", startTime: "09:00", endTime: "11:00" })],
    "2026-07-01",
    "2026-07-31"
  );
  assert.deepEqual(totals.map((t) => t.category), ["Professional"]);
  assert.equal(totals[0].minutes, 120);
});

test("recurring events count every occurrence in range, minus exceptions", () => {
  const weekly = ev({ date: "2026-07-06", recurrence: "FREQ=WEEKLY;BYDAY=MO", startTime: "09:00", endTime: "09:30" });
  // Mondays in July 2026: 6, 13, 20, 27 → 4 × 30m
  assert.deepEqual(occurrenceDates(weekly, "2026-07-01", "2026-07-31").length, 4);
  const totals = totalsByCategory([weekly], "2026-07-01", "2026-07-31");
  assert.equal(totals[0].minutes, 120);
  assert.equal(totals[0].count, 4);

  const withException = { ...weekly, exdates: ["2026-07-20"] };
  assert.equal(totalsByCategory([withException], "2026-07-01", "2026-07-31")[0].minutes, 90);
});

test("events outside the range don't count", () => {
  const totals = totalsByCategory([ev({ date: "2026-06-15" })], "2026-07-01", "2026-07-31");
  assert.deepEqual(totals, []);
  assert.equal(grandTotalMinutes(totals), 0);
});

test("formatDuration is compact and readable", () => {
  assert.equal(formatDuration(0), "0m");
  assert.equal(formatDuration(45), "45m");
  assert.equal(formatDuration(60), "1h");
  assert.equal(formatDuration(90), "1h 30m");
  assert.equal(formatDuration(755), "12h 35m");
});

test("weeklyTotals buckets by Monday and keeps empty weeks", () => {
  const weeks = weeklyTotals(
    [
      ev({ date: "2026-07-20", startTime: "09:00", endTime: "10:00" }), // week of Mon 20th
      ev({ path: "b", date: "2026-07-21", startTime: "09:00", endTime: "09:30" }), // same week
      ev({ path: "c", date: "2026-07-06", startTime: "09:00", endTime: "11:00" }), // week of Mon 6th
    ],
    "2026-07-06",
    "2026-07-26"
  );
  assert.deepEqual(weeks.map((w) => w.weekStart), ["2026-07-06", "2026-07-13", "2026-07-20"]);
  assert.deepEqual(weeks.map((w) => w.minutes), [120, 0, 90]); // middle week empty, not dropped
});

// ── Unallocated time ─────────────────────────────────────────────────────────

test("mergeIntervals collapses overlaps and touching ranges", () => {
  assert.deepEqual(mergeIntervals([[0, 60], [30, 90]]), [[0, 90]]); // overlapping
  assert.deepEqual(mergeIntervals([[0, 60], [60, 120]]), [[0, 120]]); // touching
  assert.deepEqual(mergeIntervals([[0, 60], [120, 180]]), [[0, 60], [120, 180]]); // apart
  assert.deepEqual(mergeIntervals([[50, 50]]), []); // zero-length
});

test("allocated time counts overlapping events ONCE", () => {
  const a = ev({ date: "2026-07-20", startTime: "09:00", endTime: "11:00" });
  const b = ev({ path: "b", date: "2026-07-20", startTime: "10:00", endTime: "12:00" });
  // Naively summed that's 4h, but only 3h of the day is actually occupied.
  assert.equal(grandTotalMinutes(totalsByCategory([a, b], "2026-07-20", "2026-07-20")), 240);
  assert.equal(allocatedMinutes([a, b], "2026-07-20", "2026-07-20"), 180);
});

test("timeBudget: capacity, allocated and the leftover", () => {
  const a = ev({ date: "2026-07-20", startTime: "09:00", endTime: "11:00" }); // 2h
  // One day at 16 trackable hours = 960 minutes.
  const b = timeBudget([a], "2026-07-20", "2026-07-20", 16 * 60);
  assert.equal(b.capacity, 960);
  assert.equal(b.allocated, 120);
  assert.equal(b.unallocated, 840);
  // Shares are re-based on capacity, so 2h reads as 12.5% of the day — not 100%.
  assert.ok(Math.abs(b.totals[0].share - 120 / 960) < 1e-9);
});

test("timeBudget: a part-elapsed final day only counts as far as it's gone", () => {
  // Two days, but today is only 4h old → 960 + 240 of capacity.
  const b = timeBudget([], "2026-07-19", "2026-07-20", 16 * 60, 4 * 60);
  assert.equal(b.capacity, 960 + 240);
  assert.equal(b.unallocated, 1200);
});

test("timeBudget never reports negative leftover, even if over-booked", () => {
  // A 20h event against a 16h trackable day.
  const marathon = ev({ date: "2026-07-20", startTime: "02:00", endTime: "22:00" });
  const b = timeBudget([marathon], "2026-07-20", "2026-07-20", 16 * 60);
  assert.equal(b.allocated, 960); // clamped to capacity
  assert.equal(b.unallocated, 0);
});

test("timeBudget spans multiple days and ignores all-day events", () => {
  const allDay = ev({ date: "2026-07-20", allDay: true, startTime: null, endTime: null });
  const b = timeBudget([allDay], "2026-07-20", "2026-07-26", 16 * 60); // 7 days
  assert.equal(b.capacity, 7 * 960);
  assert.equal(b.allocated, 0); // no duration → nothing allocated
  assert.equal(b.unallocated, 7 * 960);
});

test("periodRange covers week / month / year", () => {
  assert.deepEqual(periodRange("week", "2026-07-24"), { from: "2026-07-20", to: "2026-07-26" }); // Fri → Mon–Sun
  assert.deepEqual(periodRange("month", "2026-07-24"), { from: "2026-07-01", to: "2026-07-31" });
  assert.deepEqual(periodRange("year", "2026-07-24"), { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(periodRange("month", "2026-02-10").to, "2026-02-28"); // month lengths respected
});
