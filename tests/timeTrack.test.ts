import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clockText,
  formatSession,
  formatStarted,
  minutesInRange,
  minutesText,
  parseManualSession,
  parseSession,
  parseStarted,
  parseTimeLog,
  sessionMinutes,
  totalMinutes,
  trackedInRange,
} from "../src/timeTrack.ts";

const at = (d: number, h: number, m: number, s = 0) => new Date(2026, 9, d, h, m, s).getTime(); // October 2026, local time

test("formatSession / parseSession: same day leaves the end's date out; across midnight keeps it", () => {
  assert.equal(formatSession(at(26, 14, 5), at(26, 14, 47)), "2026-10-26T14:05/14:47");
  assert.equal(formatSession(at(26, 23, 40), at(27, 0, 15)), "2026-10-26T23:40/2026-10-27T00:15");
  const s = parseSession("2026-10-26T14:05/14:47")!;
  assert.deepEqual([s.start, s.end, s.minutes, s.day], [at(26, 14, 5), at(26, 14, 47), 42, "2026-10-26"]);
  assert.equal(parseSession("2026-10-26T23:40/2026-10-27T00:15")!.minutes, 35);
  assert.equal(parseSession("2026-10-26T23:40/00:15")!.minutes, 35); // typed by hand: next day
  for (const bad of ["", "14:05/14:47", "2026-10-26T14:05", "2026-10-26T14:05/2026-10-25T10:00", 42, null]) assert.equal(parseSession(bad), null);
});

test("parseTimeLog: readable sessions, oldest first; totals and ranges count by start day", () => {
  const log = parseTimeLog(["2026-10-26T14:05/14:47", "junk", "2026-10-25T20:10/21:23", "2026-10-26T23:40/2026-10-27T00:15"]);
  assert.deepEqual(log.map((s) => s.minutes), [73, 42, 35]);
  assert.equal(totalMinutes(log), 150);
  assert.equal(minutesInRange(log, "2026-10-26", "2026-10-26"), 77); // the midnight session counts on the 26th
  assert.equal(minutesInRange(log, "2026-10-27", "2026-10-31"), 0);
  assert.deepEqual(parseTimeLog("2026-10-26T14:05/14:47").length, 1); // a single string is a one-line log
  assert.deepEqual(parseTimeLog(undefined), []);
});

test("sessionMinutes: under 30 seconds isn't logged; anything else is at least a minute", () => {
  assert.equal(sessionMinutes(at(26, 14, 0, 0), at(26, 14, 0, 20)), 0);
  assert.equal(sessionMinutes(at(26, 14, 0, 0), at(26, 14, 0, 40)), 1);
  assert.equal(sessionMinutes(at(26, 14, 0), at(26, 14, 42, 29)), 42);
});

test("timer_started round-trips through local time", () => {
  const ms = at(26, 14, 5, 12);
  assert.equal(formatStarted(ms), "2026-10-26T14:05:12");
  assert.equal(parseStarted("2026-10-26T14:05:12"), ms);
  assert.equal(parseStarted(""), null);
  assert.equal(parseStarted(null), null);
});

test("trackedInRange: per task, most first, tasks without time left out", () => {
  const tasks = [
    { path: "a.md", title: "A", timeLog: parseTimeLog(["2026-10-26T10:00/10:30"]) },
    { path: "b.md", title: "B", timeLog: parseTimeLog(["2026-10-26T11:00/12:00", "2026-10-20T09:00/09:10"]) },
    { path: "c.md", title: "C" },
  ];
  assert.deepEqual(trackedInRange(tasks, "2026-10-26", "2026-10-26"), [
    { path: "b.md", title: "B", minutes: 60 },
    { path: "a.md", title: "A", minutes: 30 },
  ]);
});

test("clockText / minutesText", () => {
  assert.equal(clockText(42 * 60_000 + 17_000), "00:42:17");
  assert.equal(clockText(-5), "00:00:00");
  assert.equal(minutesText(115), "1h 55m");
  assert.equal(minutesText(120), "2h");
  assert.equal(minutesText(42), "42m");
});

test("parseManualSession: a time range on the day, or a duration ending now", () => {
  const now = at(26, 18, 0);
  assert.deepEqual(parseManualSession("14:05-14:47", "2026-10-26", now), [at(26, 14, 5), at(26, 14, 47)]);
  assert.deepEqual(parseManualSession("23:40 – 00:15", "2026-10-26", now), [at(26, 23, 40), at(27, 0, 15)]);
  assert.deepEqual(parseManualSession("45", "2026-10-26", now), [now - 45 * 60_000, now]);
  assert.deepEqual(parseManualSession("1h 30m", "2026-10-26", now), [now - 90 * 60_000, now]);
  assert.deepEqual(parseManualSession("2h", "2026-10-26", now), [now - 120 * 60_000, now]);
  assert.equal(parseManualSession("soon", "2026-10-26", now), null);
  assert.equal(parseManualSession("0", "2026-10-26", now), null);
});
