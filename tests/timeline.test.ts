import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline } from "../src/timeline.ts";

test("buildTimeline: a week back to four weeks on, widened to the projects, months across the top", () => {
  const tl = buildTimeline(
    [
      { path: "A.md", name: "CCNP", status: "active", started: "2026-09-30", due: "2027-01-30", items: [{ key: "s1", label: "Lab 3", date: "2026-11-02", kind: "step" }] },
      { path: "B.md", name: "Shed", status: "active", started: null, due: "2026-10-20", items: [{ key: "t1", label: "Felt the roof", date: "2026-10-24", end: "2026-10-26", kind: "task" }] },
      { path: "C.md", name: "Spanish", status: "waiting", started: "2026-10-01", due: null, items: [] },
      { path: "D.md", name: "Someday-ish", status: "active", started: null, due: null, items: [] },
    ],
    "2026-10-28"
  );
  assert.equal(tl.from, "2026-09-30");
  assert.equal(tl.to, "2027-01-30");
  assert.equal(tl.today, 28);
  assert.deepEqual(tl.months.map((m) => [m.label, m.at]), [["Sep 2026", 0], ["Oct", 1], ["Nov", 32], ["Dec", 62], ["Jan 2027", 93]]);
  const [ccnp, shed, spanish, bare] = tl.rows;
  assert.deepEqual(ccnp.bar, { from: 0, to: 122, openStart: false, openEnd: false, overdue: false });
  assert.deepEqual(ccnp.marks.map((m) => [m.label, m.at, m.to, m.overdue]), [["Lab 3", 33, 33, false]]);
  // No start: the bar runs from today back to its deadline — which has passed.
  assert.deepEqual(shed.bar, { from: 20, to: 28, openStart: true, openEnd: false, overdue: true });
  assert.deepEqual(shed.marks.map((m) => [m.at, m.to, m.overdue]), [[24, 26, true]]);
  assert.deepEqual(spanish.bar, { from: 1, to: 28, openStart: false, openEnd: true, overdue: false });
  assert.equal(bare.bar, null);
});

test("buildTimeline holds an old project to six months back", () => {
  const tl = buildTimeline([{ path: "Old.md", name: "Old", status: "active", started: "2023-01-01", due: null, items: [] }], "2026-10-28");
  assert.equal(tl.from, "2026-04-28");
  assert.deepEqual(tl.rows[0].bar && [tl.rows[0].bar.from, tl.rows[0].bar.openStart], [0, false]);
});
