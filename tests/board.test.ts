import { test } from "node:test";
import assert from "node:assert/strict";
import { boardColumns, boardDrop, boardFields, BoardContext } from "../src/board.ts";
import { Task } from "../src/types.ts";
import { TaskAttribute } from "../src/attributes.ts";
import { StatusFlag } from "../src/statusFlags.ts";

function task(p: Partial<Task>): Task {
  return {
    path: `${p.title ?? "t"}.md`, title: "T", status: "todo", scheduled: null, endDate: null, startTime: null,
    endTime: null, due: null, priority: "normal", contexts: [], recurrence: null,
    recurrenceAnchor: "scheduled", completeInstances: [], times: [], completeSlots: {},
    onCompletion: "keep", created: null, completed: null, parent: null, parentPath: null,
    ...p,
  } as Task;
}
const waiting: StatusFlag = { id: "waiting", label: "Waiting", icon: "⏳", base: "hold" };
const cancelled: StatusFlag = { id: "cancelled", label: "Cancelled", icon: "✖️", base: "done" };
const energy: TaskAttribute = { key: "energy", label: "Energy", icon: "⚡", kind: "choice", options: ["low", "high"], onRow: true };
const parts: TaskAttribute = { key: "needs_parts", label: "Needs parts", icon: "🔧", kind: "bool", onRow: true };
const cost: TaskAttribute = { key: "cost", label: "Cost", icon: "💷", kind: "number", onRow: true };
const ctx: BoardContext = { flags: [waiting, cancelled], attributes: [energy, parts, cost], projects: [{ path: "P/Garden.md", name: "Garden" }] };

const titles = (cols: { key: string; tasks: Task[] }[]) => cols.map((c) => [c.key, c.tasks.map((t) => t.title)]);

test("boardFields: day only for the Week view; number and date attributes left out", () => {
  assert.deepEqual(boardFields([energy, parts, cost], false).map((f) => f.field), ["status", "context", "priority", "project", "attr:energy", "attr:needs_parts"]);
  assert.equal(boardFields([], true)[0].field, "day");
});

test("status columns: each built-in, with the user's own statuses beside the one they stand for", () => {
  const tasks = [task({ title: "A" }), task({ title: "B", status: "hold", flag: waiting }), task({ title: "C", status: "hold" })];
  assert.deepEqual(titles(boardColumns("status", tasks, ctx)), [
    ["status:todo", ["A"]], ["status:hold", ["C"]], ["flag:waiting", ["B"]], ["status:someday", []], ["status:done", []], ["flag:cancelled", []],
  ]);
});

test("context columns: merged case-insensitively, busiest first, a task in each of its contexts, none last", () => {
  const tasks = [task({ title: "A", contexts: ["home"] }), task({ title: "B", contexts: ["Home", "computer"] }), task({ title: "C" })];
  assert.deepEqual(titles(boardColumns("context", tasks, ctx)), [["context:home", ["A", "B"]], ["context:computer", ["B"]], ["context:", ["C"]]]);
});

test("project and attribute columns", () => {
  const tasks = [
    task({ title: "A", projectPath: "P/Garden.md", attrs: { energy: "high", needs_parts: true } }),
    task({ title: "B", projectPath: "P/Old.md", attrs: { energy: "medium" } }),
    task({ title: "C" }),
  ];
  assert.deepEqual(titles(boardColumns("project", tasks, ctx)), [["project:P/Garden.md", ["A"]], ["project:P/Old.md", ["B"]], ["project:", ["C"]]]);
  // Choices in their own order (even empty), then values not in the list, then none.
  assert.deepEqual(titles(boardColumns("attr:energy", tasks, ctx)), [["attrval:low", []], ["attrval:high", ["A"]], ["attrval:medium", ["B"]], ["attrval:", ["C"]]]);
  assert.deepEqual(titles(boardColumns("attr:needs_parts", tasks, ctx)), [["attrval:yes", ["A"]], ["attrval:", ["B", "C"]]]);
  assert.deepEqual(boardColumns("attr:gone", tasks, ctx), []);
});

test("boardDrop: status and the user's own statuses", () => {
  const t = task({ title: "A" });
  assert.deepEqual(boardDrop("status", t, "status:todo", "status:todo", ctx), { kind: "none" });
  assert.deepEqual(boardDrop("status", t, "status:todo", "status:done", ctx), { kind: "status", status: "done" });
  assert.deepEqual(boardDrop("status", t, "status:todo", "flag:waiting", ctx), { kind: "flag", flag: waiting });
  // A flagged task dropped on its plain status takes the flag off.
  assert.deepEqual(boardDrop("status", task({ status: "hold", flag: waiting }), "flag:waiting", "status:hold", ctx), { kind: "status", status: "hold" });
  const rec = task({ recurrence: "FREQ=DAILY" });
  assert.equal(boardDrop("status", rec, "status:todo", "status:someday", ctx).kind, "refuse");
  assert.equal(boardDrop("status", rec, "status:todo", "flag:cancelled", ctx).kind, "refuse");
});

test("boardDrop: contexts swap one for the other and keep the rest", () => {
  const t = task({ contexts: ["home", "computer"] });
  assert.deepEqual(boardDrop("context", t, "context:home", "context:work", ctx), { kind: "contexts", contexts: ["computer", "work"] });
  assert.deepEqual(boardDrop("context", t, "context:home", "context:computer", ctx), { kind: "contexts", contexts: ["computer"] });
  assert.deepEqual(boardDrop("context", t, "context:home", "context:", ctx), { kind: "contexts", contexts: ["computer"] });
  assert.deepEqual(boardDrop("context", task({}), "context:", "context:home", ctx), { kind: "contexts", contexts: ["home"] });
});

test("boardDrop: priority, project and attributes", () => {
  assert.deepEqual(boardDrop("priority", task({}), "priority:normal", "priority:high", ctx), { kind: "priority", priority: "high" });
  assert.deepEqual(boardDrop("project", task({ projectPath: "P/Garden.md" }), "project:P/Garden.md", "project:", ctx), { kind: "project", path: null });
  assert.deepEqual(boardDrop("attr:energy", task({}), "attrval:", "attrval:high", ctx), { kind: "attr", attr: energy, value: "high" });
  assert.deepEqual(boardDrop("attr:needs_parts", task({}), "attrval:yes", "attrval:", ctx), { kind: "attr", attr: parts, value: null });
});
