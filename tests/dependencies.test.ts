import { test } from "node:test";
import assert from "node:assert/strict";
import { openDependencies, validDependencyCandidates, wouldCreateDependencyCycle } from "../src/dependencies.ts";
import { Task } from "../src/types.ts";

function mk(p: Partial<Task>): Task {
  return {
    path: (p.title ?? "t") + ".md", title: p.title ?? "t", status: "todo", scheduled: null,
    endDate: null, startTime: null, endTime: null, due: null, priority: "normal", estimate: null,
    remind: null, remindStart: null, contexts: [], recurrence: null, recurrenceAnchor: "scheduled",
    completeInstances: [], exdates: [], times: [], completeSlots: {}, onCompletion: "keep",
    created: null, completed: null, parent: null, parentPath: null, dependsOn: [], dependsOnPaths: [],
    ...p,
  };
}

// ── openDependencies ─────────────────────────────────────────────────────────

test("openDependencies returns only the not-done ones", () => {
  const buyPaint = mk({ title: "Buy paint", status: "done" });
  const primeWall = mk({ title: "Prime wall", status: "todo" });
  const paint = mk({ title: "Paint wall", dependsOnPaths: [buyPaint.path, primeWall.path] });
  assert.deepEqual(openDependencies([buyPaint, primeWall, paint], paint), [primeWall]);
});

test("openDependencies is empty when there are no dependencies", () => {
  const solo = mk({ title: "Solo" });
  assert.deepEqual(openDependencies([solo], solo), []);
});

test("openDependencies ignores a dependency path that no longer resolves to a real task", () => {
  const t = mk({ title: "Orphaned dep", dependsOnPaths: ["Gone.md"] });
  assert.deepEqual(openDependencies([t], t), []);
});

// ── wouldCreateDependencyCycle ───────────────────────────────────────────────

test("a task can't depend on itself", () => {
  const a = mk({ title: "A" });
  assert.equal(wouldCreateDependencyCycle([a], a, a.path), true);
});

test("a direct two-task cycle is rejected", () => {
  const a = mk({ title: "A" });
  const b = mk({ title: "B", dependsOnPaths: [a.path] }); // B already depends on A
  // Making A depend on B would close the loop A -> B -> A.
  assert.equal(wouldCreateDependencyCycle([a, b], a, b.path), true);
});

test("a longer transitive cycle is rejected", () => {
  const a = mk({ title: "A" });
  const b = mk({ title: "B", dependsOnPaths: [a.path] });
  const c = mk({ title: "C", dependsOnPaths: [b.path] }); // C -> B -> A
  // Making A depend on C would close A -> C -> B -> A.
  assert.equal(wouldCreateDependencyCycle([a, b, c], a, c.path), true);
});

test("an unrelated task is not a cycle", () => {
  const a = mk({ title: "A" });
  const b = mk({ title: "B" });
  assert.equal(wouldCreateDependencyCycle([a, b], a, b.path), false);
});

// ── validDependencyCandidates ────────────────────────────────────────────────

test("candidates exclude self, existing dependencies, and anything that would cycle", () => {
  const a = mk({ title: "A" });
  const b = mk({ title: "B", dependsOnPaths: [a.path] }); // B -> A
  const c = mk({ title: "C" }); // free-standing
  const already = mk({ title: "Already", dependsOnPaths: [] });
  const task = mk({ title: "Task", dependsOnPaths: [already.path] });
  const all = [a, b, c, already, task];
  const candidates = validDependencyCandidates(all, task).map((t) => t.title);
  assert.deepEqual(candidates.sort(), ["A", "B", "C"]);
});

test("a brand-new (unsaved) task has no candidates excluded on cycle grounds", () => {
  const a = mk({ title: "A" });
  const b = mk({ title: "B" });
  assert.deepEqual(validDependencyCandidates([a, b], null), [a, b]);
});
