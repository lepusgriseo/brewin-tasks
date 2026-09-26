import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNaturalDate } from "../src/dateParser.ts";

// Fixed "now" = Friday 2026-07-24 for determinism.
const NOW = new Date(2026, 6, 24, 10, 0, 0); // local; month is 0-indexed → July

test("today / tomorrow / yesterday", () => {
  assert.equal(parseNaturalDate("today", NOW), "2026-07-24");
  assert.equal(parseNaturalDate("tod", NOW), "2026-07-24");
  assert.equal(parseNaturalDate("tomorrow", NOW), "2026-07-25");
  assert.equal(parseNaturalDate("tmr", NOW), "2026-07-25");
  assert.equal(parseNaturalDate("yesterday", NOW), "2026-07-23");
});

test("relative offsets", () => {
  assert.equal(parseNaturalDate("+3d", NOW), "2026-07-27");
  assert.equal(parseNaturalDate("3 days", NOW), "2026-07-27");
  assert.equal(parseNaturalDate("+2w", NOW), "2026-08-07");
  assert.equal(parseNaturalDate("in 5 days", NOW), "2026-07-29");
  assert.equal(parseNaturalDate("next week", NOW), "2026-07-31");
});

test("weekdays: bare = coming (today counts), next = following week", () => {
  // 2026-07-24 is Friday.
  assert.equal(parseNaturalDate("friday", NOW), "2026-07-24"); // today counts
  assert.equal(parseNaturalDate("sat", NOW), "2026-07-25");
  assert.equal(parseNaturalDate("monday", NOW), "2026-07-27");
  assert.equal(parseNaturalDate("next monday", NOW), "2026-07-27");
  assert.equal(parseNaturalDate("next friday", NOW), "2026-07-31");
});

test("weekend and eom", () => {
  assert.equal(parseNaturalDate("weekend", NOW), "2026-07-25"); // coming Saturday
  assert.equal(parseNaturalDate("eom", NOW), "2026-07-31");
});

test("raw ISO passes through", () => {
  assert.equal(parseNaturalDate("2026-12-01", NOW), "2026-12-01");
});

test("empties → null", () => {
  assert.equal(parseNaturalDate("", NOW), null);
  assert.equal(parseNaturalDate("clear", NOW), null);
  assert.equal(parseNaturalDate("garblarg", NOW), null);
});
