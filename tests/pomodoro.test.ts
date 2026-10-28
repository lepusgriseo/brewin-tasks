import { test } from "node:test";
import assert from "node:assert/strict";
import { pomodoroPhase, workStretches } from "../src/timeTrack.ts";

const P = { work: 25, short: 5, long: 15, every: 4 };
const min = 60_000;

test("pomodoroPhase: work, short breaks, and the long one after the fourth round", () => {
  const at = (m: number) => {
    const ph = pomodoroPhase(m * min, P);
    return [ph.kind, ph.round, ph.left / min];
  };
  assert.deepEqual(at(0), ["work", 1, 25]);
  assert.deepEqual(at(24.5), ["work", 1, 0.5]);
  assert.deepEqual(at(25), ["short", 1, 5]);
  assert.deepEqual(at(30), ["work", 2, 25]);
  assert.deepEqual(at(115), ["long", 4, 15]); // 4×25 + 3×5 = 115
  assert.deepEqual(at(130), ["work", 5, 25]); // a new cycle
});

test("workStretches logs the work and leaves out the breaks", () => {
  const start = Date.UTC(2026, 9, 28, 9, 0);
  const got = workStretches(start, start + 62 * min, P).map(([s, e]) => [(s - start) / min, (e - start) / min]);
  assert.deepEqual(got, [[0, 25], [30, 55], [60, 62]]);
  assert.deepEqual(workStretches(start, start + 10 * min, P).map(([s, e]) => (e - s) / min), [10]);
});
