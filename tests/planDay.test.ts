import { test } from "node:test";
import assert from "node:assert/strict";
import { dayClose, dayPlan, toggleTop, TOP_LIMIT } from "../src/planDay.ts";
import { CalendarItem, Task } from "../src/types.ts";

const TODAY = "2026-10-27";
let n = 0;
const task = (p: Partial<Task>): Task => ({
  path: `t/${p.title ?? "T" + ++n}.md`, title: p.title ?? `T${n}`, status: "todo", scheduled: null, endDate: null, startTime: null, endTime: null,
  due: null, priority: "normal", estimate: null, remind: null, remindStart: null, contexts: [], recurrence: null, recurrenceAnchor: "scheduled",
  completeInstances: [], exdates: [], times: [], completeSlots: {}, onCompletion: "keep", created: null, completed: null, parent: null,
  parentPath: null, dependsOn: [], dependsOnPaths: [], project: null, projectPath: null, month: null, week: null, top: null, ...p,
});
const event = (start: string, end: string, title = "Meeting"): CalendarItem => ({
  kind: "event", path: `e/${title}.md`, title, date: TODAY, allDay: false, start, end, done: false, category: "Work", recurring: false,
});

test("dayPlan: leftovers, the day's own work, the top three, candidates and how full the day is", () => {
  const tasks = [
    task({ title: "Old plan", scheduled: "2026-10-20" }),
    task({ title: "Missed deadline", due: "2026-10-25" }),
    task({ title: "Timed", scheduled: TODAY, startTime: "09:00", endTime: "10:00", estimate: 60 }),
    task({ title: "Anytime", scheduled: TODAY, estimate: 30 }),
    task({ title: "Unestimated", scheduled: TODAY }),
    task({ title: "Starred", scheduled: TODAY, top: TODAY }),
    task({ title: "Inbox one" }),
    task({ title: "Someday one", status: "someday" }),
    task({ title: "Thursday", scheduled: "2026-10-29" }),
    task({ title: "Far off", scheduled: "2026-12-01" }),
  ];
  const plan = dayPlan({ tasks, items: [event("13:00", "15:00")], day: TODAY, trackedMinutes: 16 * 60 });
  const titles = (l: Task[]) => l.map((t) => t.title);
  assert.deepEqual(titles(plan.leftovers).sort(), ["Missed deadline", "Old plan"]);
  assert.equal(plan.planned[0].title, "Timed"); // the timed work first
  assert.deepEqual(titles(plan.planned).slice(1).sort(), ["Anytime", "Starred", "Unestimated"]);
  assert.deepEqual(titles(plan.top), ["Starred"]);
  assert.deepEqual(titles(plan.inbox), ["Inbox one"]); // not Someday, not dated
  assert.deepEqual(titles(plan.soon), ["Thursday"]); // within 7 days only
  assert.deepEqual(plan.busy.map((b) => b.start), ["13:00"]);
  assert.equal(plan.load.estimated, 90);
  assert.equal(plan.load.withoutEstimate, 2);
  assert.equal(plan.load.free, 16 * 60 - 120);
});

test("dayClose: done today, what's still open, and the top three's outcome", () => {
  const tasks = [
    task({ title: "Done one", status: "done", completed: TODAY, scheduled: TODAY, top: TODAY }),
    task({ title: "Open top", scheduled: TODAY, top: TODAY }),
    task({ title: "Open plain", scheduled: TODAY }),
    task({ title: "Tomorrow", scheduled: "2026-10-28" }),
  ];
  const close = dayClose(tasks, TODAY, TODAY);
  assert.deepEqual(close.done.map((t) => t.title), ["Done one"]);
  assert.deepEqual(close.open.map((t) => t.title).sort(), ["Open plain", "Open top"]);
  assert.deepEqual({ done: close.top.done, total: close.top.total, open: close.top.open.map((t) => t.title) }, { done: 1, total: 2, open: ["Open top"] });
});

test("toggleTop stars up to three open tasks, unstars, and refuses a fourth", () => {
  const starred = [1, 2, 3].map((i) => task({ title: `S${i}`, top: TODAY }));
  const other = task({ title: "Fourth" });
  assert.equal(TOP_LIMIT, 3);
  assert.equal(toggleTop([...starred, other], other, TODAY), undefined); // refused
  assert.equal(toggleTop([...starred, other], starred[0], TODAY), null); // unstar
  const twoDone = [{ ...starred[0], status: "done" as const }, starred[1], starred[2], other];
  assert.equal(toggleTop(twoDone, other, TODAY), TODAY); // a done one doesn't hold a place
});
