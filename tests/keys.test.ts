import { test } from "node:test";
import assert from "node:assert/strict";
import { calKey, dashKey, isTyping } from "../src/keys.ts";

test("dashboard keys", () => {
  assert.deepEqual(dashKey({ key: "j" }), { kind: "move", by: 1 });
  assert.deepEqual(dashKey({ key: "ArrowUp" }), { kind: "move", by: -1 });
  assert.deepEqual(dashKey({ key: "x" }), { kind: "row", act: "tick" });
  assert.deepEqual(dashKey({ key: "3" }), { kind: "view", index: 2 });
  assert.deepEqual(dashKey({ key: "z", ctrlKey: true }), { kind: "undo" });
  assert.equal(dashKey({ key: "p", ctrlKey: true }), null); // Obsidian's own hotkey
  assert.equal(dashKey({ key: "0" }), null);
  assert.equal(dashKey({ key: "x", altKey: true }), null);
});

test("calendar keys", () => {
  assert.deepEqual(calKey({ key: "ArrowLeft" }), { kind: "step", by: -1 });
  assert.deepEqual(calKey({ key: "w" }), { kind: "view", view: "week" });
  assert.deepEqual(calKey({ key: "z", metaKey: true }), { kind: "undo" });
  assert.equal(calKey({ key: "j" }), null);
});

test("isTyping: inputs, text areas, selects and editable text keep their keys", () => {
  assert.equal(isTyping({ tagName: "INPUT" } as unknown as EventTarget), true);
  assert.equal(isTyping({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget), true);
  assert.equal(isTyping({ tagName: "BUTTON" } as unknown as EventTarget), false);
  assert.equal(isTyping(null), false);
});
