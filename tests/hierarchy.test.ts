import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIndex,
  childrenOf,
  openChildren,
  progressOf,
  canComplete,
  ancestorsOf,
  descendantsOf,
  wouldCreateCycle,
  validParentCandidates,
} from "../src/hierarchy.ts";
import { Status, Task } from "../src/types.ts";

function mk(path: string, opts: { status?: Status; parent?: string | null } = {}): Task {
  return {
    path,
    title: path.replace(/\.md$/, ""),
    status: opts.status ?? "todo",
    scheduled: null,
    due: null,
    priority: "normal",
    contexts: [],
    recurrence: null,
    recurrenceAnchor: "scheduled",
    completeInstances: [],
    onCompletion: "keep",
    created: null,
    completed: null,
    parent: opts.parent ? `[[${opts.parent.replace(/\.md$/, "")}]]` : null,
    parentPath: opts.parent ?? null,
  };
}

// Ship v2 ← (Docs done, Bug open, Tag open)
function shipFixture(bugStatus: Status = "todo", tagStatus: Status = "todo") {
  const parent = mk("Ship v2.md");
  const docs = mk("Write docs.md", { status: "done", parent: "Ship v2.md" });
  const bug = mk("Fix bug.md", { status: bugStatus, parent: "Ship v2.md" });
  const tag = mk("Tag release.md", { status: tagStatus, parent: "Ship v2.md" });
  return { parent, docs, bug, tag, index: buildIndex([parent, docs, bug, tag]) };
}

test("children are derived from the child's parentPath", () => {
  const { index, parent } = shipFixture();
  assert.deepEqual(childrenOf(index, parent).map((c) => c.title), ["Fix bug", "Tag release", "Write docs"]);
});

test("a task with no children has none, and can always complete", () => {
  const solo = mk("Solo.md");
  const index = buildIndex([solo]);
  assert.equal(childrenOf(index, solo).length, 0);
  assert.equal(canComplete(index, solo), true);
});

test("THE INVARIANT: a parent cannot complete while any child is open", () => {
  const { index, parent } = shipFixture();
  assert.equal(openChildren(index, parent).length, 2);
  assert.equal(canComplete(index, parent), false);
});

test("a child on hold still blocks the parent", () => {
  const { index, parent } = shipFixture("hold", "done");
  assert.equal(openChildren(index, parent).map((c) => c.title).join(), "Fix bug");
  assert.equal(canComplete(index, parent), false);
});

test("parent unlocks only when every child is done", () => {
  const { index, parent } = shipFixture("done", "done");
  assert.equal(canComplete(index, parent), true);
  assert.deepEqual(progressOf(index, parent), { done: 3, total: 3 });
});

test("progress counts done children", () => {
  const { index, parent } = shipFixture();
  assert.deepEqual(progressOf(index, parent), { done: 1, total: 3 });
});

test("grandparent is transitively blocked via its blocked child", () => {
  // GP → P → C(open).  P is blocked by C, so GP cannot legitimately complete either.
  const gp = mk("Grandparent.md");
  const p = mk("Parent.md", { parent: "Grandparent.md" });
  const c = mk("Child.md", { parent: "Parent.md" });
  const index = buildIndex([gp, p, c]);
  assert.equal(canComplete(index, c), true); // leaf is free
  assert.equal(canComplete(index, p), false); // blocked by C
  assert.equal(canComplete(index, gp), false); // blocked by P (which can't be done)
});

test("ancestors are returned nearest-first", () => {
  const gp = mk("Grandparent.md");
  const p = mk("Parent.md", { parent: "Grandparent.md" });
  const c = mk("Child.md", { parent: "Parent.md" });
  const index = buildIndex([gp, p, c]);
  assert.deepEqual(ancestorsOf(index, c).map((t) => t.title), ["Parent", "Grandparent"]);
  assert.deepEqual(ancestorsOf(index, gp), []);
});

test("descendants walk the whole subtree", () => {
  const gp = mk("Grandparent.md");
  const p = mk("Parent.md", { parent: "Grandparent.md" });
  const c = mk("Child.md", { parent: "Parent.md" });
  const index = buildIndex([gp, p, c]);
  assert.deepEqual(descendantsOf(index, gp).map((t) => t.title).sort(), ["Child", "Parent"]);
});

test("cycles are rejected: self, direct child, and deep descendant", () => {
  const gp = mk("Grandparent.md");
  const p = mk("Parent.md", { parent: "Grandparent.md" });
  const c = mk("Child.md", { parent: "Parent.md" });
  const other = mk("Other.md");
  const index = buildIndex([gp, p, c, other]);

  assert.equal(wouldCreateCycle(index, gp, "Grandparent.md"), true); // self
  assert.equal(wouldCreateCycle(index, gp, "Parent.md"), true); // direct child
  assert.equal(wouldCreateCycle(index, gp, "Child.md"), true); // deep descendant (A→B→C→A)
  assert.equal(wouldCreateCycle(index, gp, "Other.md"), false); // unrelated is fine
  assert.equal(wouldCreateCycle(index, gp, null), false); // clearing is fine
});

test("parent candidates exclude self and descendants", () => {
  const gp = mk("Grandparent.md");
  const p = mk("Parent.md", { parent: "Grandparent.md" });
  const c = mk("Child.md", { parent: "Parent.md" });
  const other = mk("Other.md");
  const all = [gp, p, c, other];
  const index = buildIndex(all);
  assert.deepEqual(validParentCandidates(index, gp, all).map((t) => t.title), ["Other"]);
  assert.equal(validParentCandidates(index, null, all).length, 4);
});

test("a parent link pointing at a missing note is ignored (no phantom children)", () => {
  const orphan = mk("Orphan.md", { parent: "Deleted parent.md" });
  const index = buildIndex([orphan]);
  assert.equal(childrenOf(index, orphan).length, 0);
  assert.equal(canComplete(index, orphan), true);
  assert.deepEqual(ancestorsOf(index, orphan), []);
});

test("a corrupt self-referencing cycle does not hang traversal", () => {
  const a = mk("A.md", { parent: "B.md" });
  const b = mk("B.md", { parent: "A.md" });
  const index = buildIndex([a, b]);
  assert.deepEqual(ancestorsOf(index, a).map((t) => t.title), ["B"]); // stops, no infinite loop
  assert.deepEqual(descendantsOf(index, a).map((t) => t.title), ["B"]);
});
