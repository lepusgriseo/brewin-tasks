import { test } from "node:test";
import assert from "node:assert/strict";
import { isoWeekOf, isoWeeksOfMonth, weekRange } from "../src/dates.ts";

test("isoWeekOf: every day of an ISO week resolves to the same label", () => {
  // ISO week 2026-W37 runs Mon 2026-09-07 … Sun 2026-09-13.
  for (const d of ["2026-09-07", "2026-09-08", "2026-09-10", "2026-09-13"]) {
    assert.equal(isoWeekOf(d), "2026-W37");
  }
  assert.equal(isoWeekOf("2026-09-06"), "2026-W36"); // the Sunday before
  assert.equal(isoWeekOf("2026-09-14"), "2026-W38"); // the Monday after
});

test("isoWeekOf: year boundaries follow the Thursday, not Jan 1", () => {
  // 2026 starts on a Thursday → it is a 53-week year; 2026-12-31 (Thu) is W53.
  assert.equal(isoWeekOf("2026-12-31"), "2026-W53");
  // 2027-01-02 (Sat) still belongs to 2026-W53 (its Thursday is 2026-12-31).
  assert.equal(isoWeekOf("2027-01-02"), "2026-W53");
  // 2027-01-04 (Mon) is the first day of 2027-W01.
  assert.equal(isoWeekOf("2027-01-04"), "2027-W01");
});

test("isoWeekOf: pads the week number and rejects unparseable input", () => {
  assert.equal(isoWeekOf("2026-01-05"), "2026-W02");
  assert.equal(isoWeekOf("not a date"), "");
});

test("isoWeeksOfMonth: Sept 2026 spans W36…W40 with whole boundary weeks", () => {
  const weeks = isoWeeksOfMonth("2026-09");
  assert.deepEqual(
    weeks.map((w) => w.week),
    ["2026-W36", "2026-W37", "2026-W38", "2026-W39", "2026-W40"]
  );
  assert.deepEqual(weeks[0], { week: "2026-W36", start: "2026-08-31", end: "2026-09-06" });
  assert.deepEqual(weeks[4], { week: "2026-W40", start: "2026-09-28", end: "2026-10-04" });
});

test("isoWeeksOfMonth: a 6-week month, and a clean Monday front edge", () => {
  const aug = isoWeeksOfMonth("2026-08"); // Aug 1 2026 = Saturday
  assert.equal(aug.length, 6);
  assert.equal(aug[aug.length - 1].week, "2026-W36"); // W36 also appears under September
  assert.equal(isoWeeksOfMonth("2026-06")[0].start, "2026-06-01"); // June 1 2026 is a Monday
});

test("isoWeeksOfMonth: year-boundary week keeps its label under both months", () => {
  const dec = isoWeeksOfMonth("2026-12");
  assert.deepEqual(dec[dec.length - 1], { week: "2026-W53", start: "2026-12-28", end: "2027-01-03" });
  assert.equal(isoWeeksOfMonth("2027-01")[0].week, "2026-W53");
});

test("isoWeeksOfMonth: unparseable month → empty", () => {
  assert.deepEqual(isoWeeksOfMonth("nope"), []);
});

test("weekRange: a label maps to its Mon–Sun ISO dates", () => {
  assert.deepEqual(weekRange("2026-W37"), { start: "2026-09-07", end: "2026-09-13" });
  assert.deepEqual(weekRange("2026-W01"), { start: "2025-12-29", end: "2026-01-04" });
});

test("weekRange: a genuine W53 resolves; a phantom one is rejected", () => {
  // 2026 is a 53-week year (starts Thursday).
  assert.deepEqual(weekRange("2026-W53"), { start: "2026-12-28", end: "2027-01-03" });
  // 2025 has only 52 ISO weeks — "2025-W53" doesn't round-trip, so it's null.
  assert.equal(weekRange("2025-W53"), null);
});

test("weekRange: rejects anything that isn't a bare YYYY-Www label", () => {
  assert.equal(weekRange("2026-W37 Review"), null);
  assert.equal(weekRange("garbage"), null);
  assert.equal(weekRange("2026-W00"), null);
  assert.equal(weekRange(""), null);
});

test("weekRange: round-trips through isoWeekOf, end is always start + 6", () => {
  for (const label of ["2024-W01", "2025-W30", "2026-W37", "2026-W53", "2027-W01"]) {
    const r = weekRange(label);
    assert.ok(r, `${label} should resolve`);
    assert.equal(isoWeekOf(r!.start), label);
    assert.equal(isoWeekOf(r!.end), label);
  }
});
