import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRRule,
  CustomRecurrence,
  defaultCustomRecurrence,
  parseCustomRecurrence,
} from "../src/recurrenceBuilder.ts";
import { parseRRule, occurrencesInRange, effectiveStart } from "../src/rrule.ts";
import { parseISO, formatISO } from "../src/dates.ts";

// 2026-08-29 is a Saturday; it's the LAST Saturday of August 2026 (the next one would be Sep 5).
const SAT = "2026-08-29";
// 2026-08-10 is a Monday, the second Monday of August 2026.
const MON2 = "2026-08-10";

test("defaultCustomRecurrence seeds weekday/day-of-month from the anchor", () => {
  const d = defaultCustomRecurrence(SAT, "WEEKLY");
  assert.deepEqual(d.byday, [6]); // Saturday
  const m = defaultCustomRecurrence(SAT, "MONTHLY");
  assert.equal(m.monthDay, 29);
  // The anchor IS the month's last Saturday → defaults to "last", not "fourth/fifth".
  assert.equal(m.monthWeekOrdinal, -1);
  assert.equal(m.monthWeekday, 6);
});

test("defaultCustomRecurrence defaults to the actual ordinal when not the last occurrence", () => {
  const m = defaultCustomRecurrence(MON2, "MONTHLY");
  assert.equal(m.monthWeekOrdinal, 2);
  assert.equal(m.monthWeekday, 1); // Monday
});

test("buildRRule: weekly on specific days, sorted and de-duplicated", () => {
  const c: CustomRecurrence = { ...defaultCustomRecurrence(SAT, "WEEKLY"), byday: [4, 1, 1] }; // Thu, Mon, Mon
  assert.equal(buildRRule(c), "FREQ=WEEKLY;BYDAY=MO,TH");
});

test("buildRRule: weekly with an interval", () => {
  const c: CustomRecurrence = { ...defaultCustomRecurrence(SAT, "WEEKLY"), interval: 2, byday: [1, 3] };
  assert.equal(buildRRule(c), "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE");
});

test("buildRRule: monthly on a day-of-month, including 'last day' as -1", () => {
  const day = defaultCustomRecurrence(SAT, "MONTHLY");
  assert.equal(buildRRule(day), "FREQ=MONTHLY;BYMONTHDAY=29");
  const last: CustomRecurrence = { ...day, monthDay: -1 };
  assert.equal(buildRRule(last), "FREQ=MONTHLY;BYMONTHDAY=-1");
});

test("buildRRule: monthly on the Nth weekday, including 'last'", () => {
  const c: CustomRecurrence = {
    ...defaultCustomRecurrence(SAT, "MONTHLY"),
    monthlyMode: "weekday",
    monthWeekOrdinal: -1,
    monthWeekday: 0, // Sunday
  };
  assert.equal(buildRRule(c), "FREQ=MONTHLY;BYDAY=-1SU");
});

test("buildRRule: yearly and daily are interval-only", () => {
  assert.equal(buildRRule(defaultCustomRecurrence(SAT, "YEARLY")), "FREQ=YEARLY");
  const everyThreeYears: CustomRecurrence = { ...defaultCustomRecurrence(SAT, "YEARLY"), interval: 3 };
  assert.equal(buildRRule(everyThreeYears), "FREQ=YEARLY;INTERVAL=3");
  assert.equal(buildRRule(defaultCustomRecurrence(SAT, "DAILY")), "FREQ=DAILY");
});

test("parseCustomRecurrence round-trips everything buildRRule can produce", () => {
  const cases: CustomRecurrence[] = [
    { ...defaultCustomRecurrence(SAT, "WEEKLY"), byday: [1, 4] },
    { ...defaultCustomRecurrence(SAT, "WEEKLY"), interval: 3, byday: [0, 6] },
    { ...defaultCustomRecurrence(SAT, "MONTHLY"), monthDay: 15 },
    { ...defaultCustomRecurrence(SAT, "MONTHLY"), monthDay: -1 },
    { ...defaultCustomRecurrence(SAT, "MONTHLY"), monthlyMode: "weekday", monthWeekOrdinal: 2, monthWeekday: 4 },
    { ...defaultCustomRecurrence(SAT, "MONTHLY"), monthlyMode: "weekday", monthWeekOrdinal: -1, monthWeekday: 0 },
    { ...defaultCustomRecurrence(SAT, "YEARLY"), interval: 5 },
    { ...defaultCustomRecurrence(SAT, "DAILY"), interval: 4 },
  ];
  for (const c of cases) {
    const rrule = buildRRule(c);
    const parsed = parseCustomRecurrence(rrule, SAT);
    assert.deepEqual(parsed, c, `round-trip failed for ${rrule}`);
  }
});

test("parseCustomRecurrence rejects shapes the builder never produces", () => {
  assert.equal(parseCustomRecurrence("FREQ=WEEKLY;BYDAY=2MO", SAT), null); // ordinal on weekly
  assert.equal(parseCustomRecurrence("FREQ=MONTHLY;BYMONTHDAY=1,15", SAT), null); // multiple month-days
  assert.equal(parseCustomRecurrence("FREQ=YEARLY;BYMONTHDAY=1", SAT), null); // wrong day for the anchor's month
  assert.equal(parseCustomRecurrence("not a rule", SAT), null);
});

test("parseCustomRecurrence accepts a plain FREQ=MONTHLY with no BY* as day-mode at the anchor", () => {
  const parsed = parseCustomRecurrence("FREQ=MONTHLY", SAT);
  assert.equal(parsed?.monthlyMode, "day");
  assert.equal(parsed?.monthDay, 29);
});

test("a weekly Mon+Thu custom rule actually occurs on Mondays and Thursdays (engine sanity check)", () => {
  const c = buildRRule({ ...defaultCustomRecurrence(MON2, "WEEKLY"), byday: [1, 4] });
  const rule = parseRRule(c)!;
  const anchor = parseISO(MON2)!;
  const from = parseISO("2026-08-10")!;
  const to = parseISO("2026-08-23")!;
  const start = effectiveStart(rule, anchor, from);
  const occ = occurrencesInRange(rule, start, from, to).map(formatISO);
  assert.deepEqual(occ, ["2026-08-10", "2026-08-13", "2026-08-17", "2026-08-20"]);
});
