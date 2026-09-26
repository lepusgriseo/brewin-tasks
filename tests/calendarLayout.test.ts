import { test } from "node:test";
import assert from "node:assert/strict";
import { allDaySpans, segmentsForWeek, laneCount, taskSpans } from "../src/calendarLayout.ts";
import { EventItem, Task } from "../src/types.ts";

function ev(p: Partial<EventItem>): EventItem {
  return { path: "x", title: "e", date: "2026-07-20", endDate: null, allDay: true, startTime: null, endTime: null, category: "General", originalCategory: "General", archived: false, completed: false, recurrence: null, exdates: [], ...p };
}

function task(p: Partial<Task>): Task {
  return {
    path: "t", title: "T", status: "todo", scheduled: null, endDate: null, startTime: null,
    endTime: null, due: null, priority: "normal", contexts: [], recurrence: null,
    recurrenceAnchor: "scheduled", completeInstances: [], times: [], completeSlots: {},
    onCompletion: "keep", created: null, completed: null, parent: null, parentPath: null,
    dependsOn: [], dependsOnPaths: [], month: null, week: null,
    ...p,
  };
}

// Week Mon 2026-07-20 … Sun 2026-07-26
const WEEK = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25", "2026-07-26"];

test("single all-day event → 1-day inclusive span", () => {
  const spans = allDaySpans([ev({ date: "2026-07-22" })], "2026-07-01", "2026-07-31");
  assert.deepEqual(spans.map((s) => [s.start, s.end]), [["2026-07-22", "2026-07-22"]]);
});

test("multi-day event: exclusive endDate → inclusive span", () => {
  // date 20, endDate 23 (exclusive) → covers 20,21,22
  const spans = allDaySpans([ev({ date: "2026-07-20", endDate: "2026-07-23" })], "2026-07-01", "2026-07-31");
  assert.deepEqual(spans.map((s) => [s.start, s.end]), [["2026-07-20", "2026-07-22"]]);
});

test("timed events are ignored by allDaySpans", () => {
  const spans = allDaySpans([ev({ allDay: false, startTime: "09:00" })], "2026-07-01", "2026-07-31");
  assert.equal(spans.length, 0);
});

test("taskSpans: a multi-day task (Fri→Sun) becomes ONE spanning bar, not three", () => {
  // The actual bug report this fixes: a weekend task rendered as three separate day chips
  // ("Run 10k (1/3)", "(2/3)", "(3/3)") instead of one item, unlike a multi-day event.
  const t = task({ title: "Run 10k", scheduled: "2026-07-24", endDate: "2026-07-26" }); // Fri→Sun, inclusive
  const spans = taskSpans([t], "2026-07-01", "2026-07-31");
  assert.equal(spans.length, 1);
  assert.deepEqual([spans[0].start, spans[0].end], ["2026-07-24", "2026-07-26"]);
  assert.equal(spans[0].kind, "task");
  assert.equal(spans[0].title, "Run 10k");
});

test("taskSpans: a single-day task is excluded — it stays an ordinary chip", () => {
  const t = task({ scheduled: "2026-07-24" }); // no endDate, or endDate == scheduled
  assert.equal(taskSpans([t], "2026-07-01", "2026-07-31").length, 0);
  const same = task({ scheduled: "2026-07-24", endDate: "2026-07-24" });
  assert.equal(taskSpans([same], "2026-07-01", "2026-07-31").length, 0);
});

test("taskSpans: an unscheduled task (due-date only) is excluded — nothing to span", () => {
  const t = task({ scheduled: null, due: "2026-07-24", endDate: "2026-07-26" });
  assert.equal(taskSpans([t], "2026-07-01", "2026-07-31").length, 0);
});

test("taskSpans: a recurring multi-day task is excluded — expansion isn't handled here", () => {
  const t = task({ scheduled: "2026-07-24", endDate: "2026-07-26", recurrence: "FREQ=WEEKLY" });
  assert.equal(taskSpans([t], "2026-07-01", "2026-07-31").length, 0);
});

test("taskSpans: clips to the visible range like allDaySpans does", () => {
  const t = task({ scheduled: "2026-07-24", endDate: "2026-07-26" });
  const spans = taskSpans([t], "2026-07-25", "2026-07-31");
  assert.deepEqual([spans[0].start, spans[0].end], ["2026-07-25", "2026-07-26"]);
});

test("segment columns + continues flags", () => {
  // Span Wed(22)–next-Tue: within this week covers cols 2..6 and continues right.
  const spans = allDaySpans([ev({ date: "2026-07-22", endDate: "2026-07-29" })], "2026-07-01", "2026-08-07");
  const segs = segmentsForWeek(spans, WEEK);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].startCol, 2); // Wed
  assert.equal(segs[0].endCol, 6); // Sun
  assert.equal(segs[0].continuesRight, true);
  assert.equal(segs[0].continuesLeft, false);
});

test("overlapping spans get separate lanes", () => {
  const spans = allDaySpans(
    [
      ev({ path: "a", date: "2026-07-20", endDate: "2026-07-23" }), // 20–22
      ev({ path: "b", date: "2026-07-21", endDate: "2026-07-24" }), // 21–23
    ],
    "2026-07-01",
    "2026-07-31"
  );
  const segs = segmentsForWeek(spans, WEEK);
  assert.equal(laneCount(segs), 2);
  const a = segs.find((s) => s.span.path === "a")!;
  const b = segs.find((s) => s.span.path === "b")!;
  assert.notEqual(a.lane, b.lane);
});

test("non-overlapping spans share a lane", () => {
  const spans = allDaySpans(
    [
      ev({ path: "a", date: "2026-07-20", endDate: "2026-07-22" }), // 20–21
      ev({ path: "b", date: "2026-07-24", endDate: "2026-07-26" }), // 24–25
    ],
    "2026-07-01",
    "2026-07-31"
  );
  const segs = segmentsForWeek(spans, WEEK);
  assert.equal(laneCount(segs), 1);
});

// ── Timed-block overlap layout ───────────────────────────────────────────────

import { packOverlaps } from "../src/calendarLayout.ts";

const cols = (rs: [number, number][]) => packOverlaps(rs).map((p) => `${p.column}/${p.columns}x${p.span}`);

test("packOverlaps: a lone block keeps the full width", () => {
  assert.deepEqual(cols([[540, 600]]), ["0/1x1"]);
});

test("packOverlaps: sequential blocks don't split the column", () => {
  // 09:00–10:00 then 10:00–11:00 — touching edges are NOT an overlap.
  assert.deepEqual(cols([[540, 600], [600, 660]]), ["0/1x1", "0/1x1"]);
});

test("packOverlaps: two overlapping blocks sit side by side", () => {
  assert.deepEqual(cols([[540, 660], [600, 720]]), ["0/2x1", "1/2x1"]);
});

test("packOverlaps: three simultaneous blocks split three ways", () => {
  const p = packOverlaps([[540, 600], [540, 600], [540, 600]]);
  assert.deepEqual(p.map((x) => x.column), [0, 1, 2]);
  assert.ok(p.every((x) => x.columns === 3 && x.span === 1));
});

test("packOverlaps: separate clusters are sized independently", () => {
  // Morning pair overlaps; the afternoon block is alone and stays full width.
  assert.deepEqual(cols([[540, 660], [600, 720], [900, 960]]), ["0/2x1", "1/2x1", "0/1x1"]);
});

test("packOverlaps: a block widens over a column that doesn't overlap it", () => {
  // A 09:00–12:00 spans the cluster; B 09:00–10:00 and C 10:00–11:00 share column 1.
  // C doesn't overlap anything in a third column, so nothing is needlessly narrowed.
  const p = packOverlaps([[540, 720], [540, 600], [600, 660]]);
  assert.equal(p[0].columns, 2);
  assert.equal(p[0].column, 0);
  assert.equal(p[1].column, 1);
  assert.equal(p[2].column, 1); // reuses column 1 — B has finished by 10:00
});

test("packOverlaps: a chain of partial overlaps stays one cluster", () => {
  // A–B overlap, B–C overlap, A–C do not: still one cluster, but only 2 columns needed.
  const p = packOverlaps([[540, 620], [600, 700], [660, 740]]);
  assert.ok(p.every((x) => x.columns === 2));
  assert.deepEqual(p.map((x) => x.column), [0, 1, 0]);
});

test("packOverlaps: placements come back in input order", () => {
  // Deliberately unsorted input — the later-starting block is listed first.
  const p = packOverlaps([[600, 720], [540, 660]]);
  assert.equal(p[0].column, 1); // the 10:00 block
  assert.equal(p[1].column, 0); // the 09:00 block takes the left column
});

test("packOverlaps: empty input is safe", () => {
  assert.deepEqual(packOverlaps([]), []);
});
