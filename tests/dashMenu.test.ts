import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canHideView,
  linkedTaskCounts,
  matchesFilter,
  moveView,
  newFilterId,
  orderedViews,
  resolveDrop,
  SavedFilter,
  suggestFilterName,
  todayProgress,
  toggleHidden,
  viewCounts,
  viewKey,
} from "../src/dashMenu.ts";
import { DASH_VIEWS } from "../src/views.ts";
import { Task } from "../src/types.ts";

const TODAY = "2026-10-19"; // a Monday

function task(p: Partial<Task>): Task {
  return {
    path: p.title ?? "t", title: "T", status: "todo", scheduled: null, endDate: null, startTime: null,
    endTime: null, due: null, priority: "normal", contexts: [], recurrence: null,
    recurrenceAnchor: "scheduled", completeInstances: [], times: [], completeSlots: {},
    onCompletion: "keep", created: null, completed: null, parent: null, parentPath: null,
    project: null, projectPath: null,
    ...p,
  } as Task;
}

// ── Order and hiding ─────────────────────────────────────────────────────────

test("an empty saved order is the default order", () => {
  assert.deepEqual(orderedViews([]), DASH_VIEWS.map((v) => v.id));
});

test("a saved order wins, unknown ids are dropped and forgotten views come back at the end", () => {
  const order = orderedViews(["inbox", "gone", "today", "inbox"]);
  assert.deepEqual(order.slice(0, 2), ["inbox", "today"]);
  assert.equal(order.length, DASH_VIEWS.length);
  assert.ok(!order.includes("gone" as never));
  assert.equal(order[2], "week"); // first view the saved order didn't mention, in default order
});

test("moving a view swaps it with its neighbour and stops at the ends", () => {
  assert.deepEqual(moveView([], "week", -1).slice(0, 2), ["week", "today"]);
  assert.deepEqual(moveView([], "today", -1), orderedViews([]));
  assert.deepEqual(moveView([], DASH_VIEWS[DASH_VIEWS.length - 1].id, 1), orderedViews([]));
});

test("hiding toggles, and the last showing view can't be hidden", () => {
  assert.deepEqual(toggleHidden([], "view:all"), ["view:all"]);
  assert.deepEqual(toggleHidden(["view:all"], "view:all"), []);
  const allButToday = DASH_VIEWS.filter((v) => v.id !== "today").map((v) => viewKey(v.id));
  assert.equal(canHideView(allButToday, "today"), false);
  assert.equal(canHideView(allButToday, "week"), true); // already hidden: showing it is fine
  assert.equal(canHideView([], "today"), true);
});

// ── Counts ───────────────────────────────────────────────────────────────────

test("view counts are what is left to do in each view", () => {
  const tasks = [
    task({ title: "Today A", scheduled: TODAY }),
    task({ title: "Today done", scheduled: TODAY, status: "done", completed: TODAY }),
    task({ title: "Thursday", scheduled: "2026-10-22" }),
    task({ title: "Undated" }),
    task({ title: "Missed deadline", due: "2026-10-10" }),
    task({ title: "Wish", status: "someday" }),
  ];
  const c = viewCounts(tasks, TODAY);
  assert.equal(c.today, 2); // Today A + the overdue one, pinned on top of Today
  assert.equal(c.inbox, 1);
  assert.equal(c.attention, 1);
  assert.equal(c.all, 5); // everything not done, Someday included
  assert.equal(c.review, null);
  assert.equal(c.projects, null);
  assert.ok((c.week ?? 0) >= 2);
});

test("today's progress counts done out of planned", () => {
  const p = todayProgress(
    [
      task({ title: "A", scheduled: TODAY }),
      task({ title: "B", scheduled: TODAY, status: "done", completed: TODAY }),
      task({ title: "C", scheduled: TODAY, status: "done", completed: TODAY }),
    ],
    TODAY
  );
  assert.deepEqual(p, { done: 2, total: 3 });
});

test("linked task notes are counted per project, open ones only", () => {
  const m = linkedTaskCounts([
    task({ projectPath: "03_Projects/Smart home.md" }),
    task({ projectPath: "03_Projects/Smart home.md", status: "done" }),
    task({ projectPath: "03_Projects/EmuDeck.md", status: "hold" }),
    task({}),
  ]);
  assert.equal(m.get("03_Projects/Smart home.md"), 1);
  assert.equal(m.get("03_Projects/EmuDeck.md"), 1);
  assert.equal(m.size, 2);
});

// ── Saved filters ────────────────────────────────────────────────────────────

const base = { view: "today" as const, project: null, context: null, query: "", groupBy: "date" as const };

test("a filter matches regardless of search case and spacing, and grouping only matters in All", () => {
  assert.ok(matchesFilter({ ...base, query: "Lab " }, { ...base, query: "lab" }));
  assert.ok(matchesFilter({ ...base, context: "Home" }, { ...base, context: "home" }));
  assert.ok(!matchesFilter({ ...base, context: "home" }, base));
  assert.ok(matchesFilter({ ...base, groupBy: "context" }, base)); // Today has no grouping
  assert.ok(!matchesFilter({ ...base, view: "all", groupBy: "context" }, { ...base, view: "all" }));
  assert.ok(!matchesFilter({ ...base, project: "p.md" }, base));
});

test("the suggested name reads like the state it saves", () => {
  assert.equal(suggestFilterName({ ...base, context: "work", query: "ccnp" }, null), "Today · @work · “ccnp”");
  assert.equal(suggestFilterName({ ...base, project: "03_Projects/EmuDeck.md" }, "EmuDeck"), "EmuDeck");
  assert.equal(suggestFilterName({ ...base, view: "all", groupBy: "context" }, null), "All · by context");
});

test("filter ids never collide", () => {
  const first = newFilterId([], 1000);
  const second = newFilterId([{ ...base, id: first, name: "x" } as SavedFilter], 1000);
  assert.notEqual(first, second);
});

// ── Drops ────────────────────────────────────────────────────────────────────

test("dropping on Today, Tomorrow and Next week schedules the task", () => {
  const t = task({ scheduled: "2026-10-01" });
  assert.deepEqual(resolveDrop("view:today", t, TODAY, 1), { kind: "schedule", iso: TODAY });
  assert.deepEqual(resolveDrop("drop:tomorrow", t, TODAY, 1), { kind: "schedule", iso: "2026-10-20" });
  assert.deepEqual(resolveDrop("drop:nextweek", t, TODAY, 1), { kind: "schedule", iso: "2026-10-26" });
});

test("a Someday or on-hold task dropped on Today is scheduled, not refused", () => {
  assert.equal(resolveDrop("view:today", task({ status: "someday" }), TODAY, 1)?.kind, "schedule");
  assert.equal(resolveDrop("view:today", task({ status: "hold", scheduled: TODAY }), TODAY, 1)?.kind, "schedule");
  assert.equal(resolveDrop("view:today", task({ scheduled: TODAY }), TODAY, 1)?.kind, "refuse");
});

test("a recurring task refuses the date targets but takes a context or a project", () => {
  const r = task({ recurrence: "FREQ=DAILY", scheduled: TODAY });
  for (const key of ["view:today", "drop:tomorrow", "drop:nextweek", "view:inbox", "drop:someday"]) {
    assert.equal(resolveDrop(key, r, TODAY, 1)?.kind, "refuse", key);
  }
  assert.deepEqual(resolveDrop("context:home", r, TODAY, 1), { kind: "context", value: "home" });
  assert.deepEqual(resolveDrop("project:03_Projects/EmuDeck.md", r, TODAY, 1), { kind: "project", path: "03_Projects/EmuDeck.md" });
});

test("inbox, someday, context and project drops refuse what is already true", () => {
  assert.equal(resolveDrop("view:inbox", task({}), TODAY, 1)?.kind, "refuse");
  assert.equal(resolveDrop("view:inbox", task({ scheduled: TODAY }), TODAY, 1)?.kind, "inbox");
  assert.equal(resolveDrop("view:inbox", task({ status: "someday" }), TODAY, 1)?.kind, "inbox");
  assert.equal(resolveDrop("drop:someday", task({ status: "someday" }), TODAY, 1)?.kind, "refuse");
  assert.equal(resolveDrop("context:Home", task({ contexts: ["home"] }), TODAY, 1)?.kind, "refuse");
  assert.equal(resolveDrop("project:p.md", task({ projectPath: "p.md" }), TODAY, 1)?.kind, "refuse");
});

test("views that aren't drop targets return null", () => {
  for (const key of ["view:week", "view:all", "view:review", "view:attention", "view:projects", "link:calendar", "context:", "project:"]) {
    assert.equal(resolveDrop(key, task({}), TODAY, 1), null, key);
  }
});
