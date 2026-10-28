import { test } from "node:test";
import assert from "node:assert/strict";
import { addChecklistItem, checklistItems, setChecklistItem } from "../src/checklist.ts";

const NOTE = ["---", "tags: [task]", "list:", "  - [x] not a box", "---", "Pack for the trip:", "- [ ] passport", "- [x] charger", "  - [ ] spare cable", "* [-] umbrella", "```", "- [ ] in code", "```", "1. [ ] numbered"].join("\n");

test("checklistItems reads the boxes outside the frontmatter and code, any mark but a space as done", () => {
  assert.deepEqual(checklistItems(NOTE), [
    { line: 6, text: "passport", done: false },
    { line: 7, text: "charger", done: true },
    { line: 8, text: "spare cable", done: false },
    { line: 9, text: "umbrella", done: true },
    { line: 13, text: "numbered", done: false },
  ]);
});

test("setChecklistItem ticks and unticks in place, and refuses a line that has changed", () => {
  const ticked = setChecklistItem(NOTE, { line: 6, text: "passport" }, true)!;
  assert.equal(ticked.split("\n")[6], "- [x] passport");
  assert.equal(setChecklistItem(ticked, { line: 9, text: "umbrella" }, false)!.split("\n")[9], "* [ ] umbrella");
  assert.equal(setChecklistItem(NOTE, { line: 6, text: "visa" }, true), null);
  assert.equal(setChecklistItem(NOTE, { line: 5, text: "Pack for the trip:" }, true), null);
});

test("addChecklistItem goes after the last item and what's nested under it, at the first item's level", () => {
  const body = "Shopping:\n- [ ] milk\n  - [ ] oat, not cow\n\nAfterwards, the rest.";
  assert.equal(addChecklistItem(body, "  bread "), "Shopping:\n- [ ] milk\n  - [ ] oat, not cow\n- [ ] bread\n\nAfterwards, the rest.");
  assert.equal(addChecklistItem("* [ ] a", "b"), "* [ ] a\n* [ ] b");
  assert.equal(addChecklistItem("Some notes.\n", "first"), "Some notes.\n\n- [ ] first");
  assert.equal(addChecklistItem("", "first"), "- [ ] first");
  assert.equal(addChecklistItem("x", "   "), "x");
});
