import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEstimate, parseEstimate, workload } from "../src/estimate.ts";

test("parseEstimate accepts the ways a person actually types a duration", () => {
  assert.equal(parseEstimate("45"), 45);
  assert.equal(parseEstimate("45m"), 45);
  assert.equal(parseEstimate("90 min"), 90);
  assert.equal(parseEstimate("1h"), 60);
  assert.equal(parseEstimate("2 hours"), 120);
  assert.equal(parseEstimate("1.5h"), 90);
  assert.equal(parseEstimate("1h30"), 90);
  assert.equal(parseEstimate("1h 30m"), 90);
  assert.equal(parseEstimate("1:30"), 90);
  assert.equal(parseEstimate(45), 45);
});

test("parseEstimate rejects nonsense and non-positive values", () => {
  assert.equal(parseEstimate("a while"), null);
  assert.equal(parseEstimate(""), null);
  assert.equal(parseEstimate(null), null);
  assert.equal(parseEstimate("0"), null);
  assert.equal(parseEstimate("-30"), null);
});

test("formatEstimate round-trips the common cases", () => {
  assert.equal(formatEstimate(45), "45m");
  assert.equal(formatEstimate(60), "1h");
  assert.equal(formatEstimate(90), "1h 30m");
  assert.equal(formatEstimate(null), "");
  assert.equal(formatEstimate(0), "");
});

test("workload adds up estimates and measures them against free time", () => {
  const w = workload([30, 60, 45], 120);
  assert.equal(w.estimated, 135);
  assert.equal(w.withEstimate, 3);
  assert.equal(w.withoutEstimate, 0);
  assert.equal(w.free, 120);
  assert.equal(w.over, 15); // 15 minutes over-committed
});

test("unestimated tasks are counted separately, never treated as zero work", () => {
  // The warning must not read "you have 30m of work" when two tasks are unmeasured.
  const w = workload([30, null, null], 120);
  assert.equal(w.estimated, 30);
  assert.equal(w.withEstimate, 1);
  assert.equal(w.withoutEstimate, 2);
  assert.equal(w.over, -90); // under, but only on what's actually been estimated
});

test("workload never reports negative free time", () => {
  const w = workload([60], -30);
  assert.equal(w.free, 0);
  assert.equal(w.over, 60);
});
