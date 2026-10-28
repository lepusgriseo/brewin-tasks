import { test } from "node:test";
import assert from "node:assert/strict";
import { completionInsight, estimateInsight, focusInsight, weekStartOf } from "../src/insights.ts";
import { Task } from "../src/types.ts";

const session = (day: string, minutes: number) => ({ raw: "", start: 0, end: 0, minutes, day });
function task(p: Partial<Task>): Task {
  return {
    path: `${p.title}.md`, title: "T", status: "todo", scheduled: null, endDate: null, startTime: null,
    endTime: null, due: null, priority: "normal", contexts: [], recurrence: null,
    recurrenceAnchor: "scheduled", completeInstances: [], exdates: [], times: [], completeSlots: {},
    onCompletion: "keep", created: null, completed: null, parent: null, parentPath: null,
    ...p,
  } as Task;
}

test("estimateInsight: logged against estimated, the middle one, the furthest over, by context", () => {
  const tasks = [
    task({ title: "A", status: "done", completed: "2026-10-20", estimate: 30, timeLog: [session("2026-10-20", 60)], contexts: ["home"] }),
    task({ title: "B", status: "done", completed: "2026-10-21", estimate: 60, timeLog: [session("2026-10-21", 30)], contexts: ["home"] }),
    task({ title: "C", status: "done", completed: "2026-10-22", estimate: 20, timeLog: [session("2026-10-22", 30)], contexts: ["work"] }),
    task({ title: "Open", estimate: 10, timeLog: [session("2026-10-22", 50)] }), // not finished: not counted
  ];
  const e = estimateInsight(tasks, "2026-10-19", "2026-10-25");
  assert.equal(e.count, 3);
  assert.equal(e.median, 1.5);
  assert.deepEqual(e.worst.map((w) => [w.title, w.ratio]), [["A", 2], ["C", 1.5]]);
  assert.deepEqual(e.byContext, [{ context: "home", count: 2, median: 1.25 }]);
});

test("completionInsight: each done once, repeats each time, on time against the deadline", () => {
  const tasks = [
    task({ title: "On time", status: "done", completed: "2026-10-20", due: "2026-10-21", contexts: ["home"] }),
    task({ title: "Late", status: "done", completed: "2026-10-27", due: "2026-10-23", projectPath: "03_Projects/CCNP.md" }),
    task({ title: "Bins", recurrence: "FREQ=WEEKLY", completeInstances: ["2026-10-19", "2026-10-26", "2026-09-01"], contexts: ["home"] }),
  ];
  const c = completionInsight(tasks, "2026-10-19", "2026-11-01");
  assert.deepEqual([c.total, c.onTime, c.late], [4, 1, 1]);
  assert.deepEqual(c.byWeek, [{ weekStart: "2026-10-19", count: 2 }, { weekStart: "2026-10-26", count: 2 }]);
  assert.deepEqual(c.byWeekday, [2, 2, 0, 0, 0, 0, 0]);
  assert.deepEqual(c.byContext[0], { label: "@home", count: 3 });
  assert.deepEqual(c.byProject.map((p) => p.label), ["no project", "CCNP"]);
  assert.equal(weekStartOf("2026-11-01"), "2026-10-26");
});

test("focusInsight: by day, the streak back from today, the longest run, the top tasks", () => {
  const tasks = [
    task({ title: "CCNP", timeLog: [session("2026-10-24", 50), session("2026-10-25", 30), session("2026-10-27", 45)] }),
    task({ title: "Bikes", timeLog: [session("2026-10-26", 20), session("2026-10-27", 10)] }),
  ];
  const f = focusInsight(tasks, "2026-10-22", "2026-10-28", "2026-10-28");
  assert.equal(f.total, 155);
  assert.deepEqual(f.byDay.map((d) => d.minutes), [0, 0, 50, 30, 20, 55, 0]);
  assert.equal(f.streak, 4); // nothing yet today: the run up to yesterday
  assert.equal(f.longest, 4);
  assert.deepEqual(f.top.map((t) => [t.title, t.minutes]), [["CCNP", 125], ["Bikes", 30]]);
});
