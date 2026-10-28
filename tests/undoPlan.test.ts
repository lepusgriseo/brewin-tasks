import { test } from "node:test";
import assert from "node:assert/strict";
import { compactChanges, propertyChanges, restoreProperties, restoreText } from "../src/undoPlan.ts";

test("propertyChanges keeps only what a write changed, as it was — including what it added or removed", () => {
  const before = { status: "todo", scheduled: "2026-10-27", contexts: ["home"], flag: "waiting", modified: "2026-10-26" };
  const after = { status: "done", scheduled: "2026-10-27", contexts: ["home"], completed: "2026-10-27", modified: "2026-10-27" };
  assert.deepEqual(propertyChanges(before, after), {
    status: { had: true, value: "todo" },
    flag: { had: true, value: "waiting" },
    completed: { had: false },
    modified: { had: true, value: "2026-10-26" },
  });
  assert.deepEqual(propertyChanges(before, { ...before }), {});
});

test("restoreProperties puts back only those properties, leaving anything written since", () => {
  const fm: Record<string, unknown> = { status: "done", completed: "2026-10-27", contexts: ["home"], energy: "high" };
  restoreProperties(fm, { status: { had: true, value: "todo" }, completed: { had: false } });
  assert.deepEqual(fm, { status: "todo", contexts: ["home"], energy: "high" }); // energy came later and stays
});

test("restored values are copies: undoing twice from the same record can't share an array", () => {
  const keys = { contexts: { had: true, value: ["home"] } };
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  restoreProperties(a, keys);
  restoreProperties(b, keys);
  (a.contexts as string[]).push("work");
  assert.deepEqual(b.contexts, ["home"]);
});

test("restoreText refuses when the note changed after the edit", () => {
  const c = { before: "- [ ] Book train", after: "- [x] Book train [completion:: 2026-10-27]" };
  assert.equal(restoreText(c.after, c), c.before);
  assert.equal(restoreText(c.after + "\nanother line", c), null);
});

test("compactChanges folds repeated writes to one note, keeping each property's earliest state", () => {
  const out = compactChanges([
    { kind: "fm", path: "a.md", keys: { status: { had: true, value: "todo" } } },
    { kind: "fm", path: "a.md", keys: { status: { had: true, value: "hold" }, flag: { had: false } } },
    { kind: "rename", from: "a.md", to: "Done/a.md" },
    { kind: "fm", path: "Done/a.md", keys: { modified: { had: true, value: "x" } } },
    { kind: "text", path: "p.md", before: "1", after: "2" },
    { kind: "text", path: "p.md", before: "2", after: "3" },
  ]);
  assert.deepEqual(out, [
    { kind: "fm", path: "a.md", keys: { status: { had: true, value: "todo" }, flag: { had: false } } },
    { kind: "rename", from: "a.md", to: "Done/a.md" },
    { kind: "fm", path: "Done/a.md", keys: { modified: { had: true, value: "x" } } },
    { kind: "text", path: "p.md", before: "1", after: "3" },
  ]);
});
