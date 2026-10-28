import { test } from "node:test";
import assert from "node:assert/strict";
import { readUri } from "../src/uri.ts";
import { lineAsTask } from "../src/inlineTask.ts";

const base = { action: "brewin-planner", vault: "MyVault" };

test("readUri: add, with or without the window; no words opens the window empty", () => {
  assert.deepEqual(readUri({ ...base, add: " Call the bank tomorrow 2pm " }), { kind: "add", text: "Call the bank tomorrow 2pm", window: false });
  assert.deepEqual(readUri({ ...base, add: "Bins", window: "true" }), { kind: "add", text: "Bins", window: true });
  assert.deepEqual(readUri({ ...base, add: "Bins", window: "0" }), { kind: "add", text: "Bins", window: false });
  assert.deepEqual(readUri({ ...base, add: "true" }), { kind: "add", text: "", window: true });
});

test("readUri: views, notes, and what it can't do said plainly", () => {
  assert.deepEqual(readUri({ ...base, view: "Calendar" }), { kind: "view", view: "calendar" });
  assert.deepEqual(readUri(base), { kind: "view", view: "today" });
  assert.deepEqual(readUri({ ...base, edit: "00_Systems/Tasks/Items/Pay rent" }), { kind: "edit", note: "00_Systems/Tasks/Items/Pay rent" });
  assert.deepEqual(readUri({ ...base, focus: "Pay rent.md" }), { kind: "focus", note: "Pay rent.md" });
  assert.equal(readUri({ ...base, view: "agenda" }).kind, "unknown");
  assert.equal(readUri({ ...base, edit: "true" }).kind, "unknown");
  assert.match((readUri({ ...base, delete: "x" }) as { reason: string }).reason, /delete/);
});

test("lineAsTask keeps the bullet and indent, takes the dates, and drops the box", () => {
  assert.deepEqual(lineAsTask("  - [ ] Return parcel 📅 2026-11-02"), { words: "Return parcel", scheduled: null, due: "2026-11-02", lead: "  - " });
  assert.deepEqual(lineAsTask("* Ring [[Gran]] [scheduled:: 2026-11-01]"), { words: "Ring [[Gran]]", scheduled: "2026-11-01", due: null, lead: "* " });
  assert.deepEqual(lineAsTask("Pay the plumber ⏳ 2026-11-03"), { words: "Pay the plumber", scheduled: "2026-11-03", due: null, lead: "" });
  assert.deepEqual(lineAsTask("Book the MOT"), { words: "Book the MOT", scheduled: null, due: null, lead: "" });
  for (const no of ["", "   ", "## Heading", "- [x] done already", "- [ ] [[A task note]]", "[[Just a link]]", "```", "---", "| a | b |"]) {
    assert.equal(lineAsTask(no), null, no);
  }
});
