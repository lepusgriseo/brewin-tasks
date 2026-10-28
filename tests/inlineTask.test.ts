import { test } from "node:test";
import assert from "node:assert/strict";
import { displayText, parseInlineTask, writeInlineTask } from "../src/inlineTask.ts";

const TODAY = "2026-10-27";

test("reads both ways of dating a step", () => {
  const dv = parseInlineTask("- [ ] Book train [scheduled:: 2026-11-02] [due:: 2026-11-06] #next");
  assert.deepEqual(
    { text: dv?.text, scheduled: dv?.scheduled, due: dv?.due, next: dv?.next, style: dv?.style, done: dv?.done },
    { text: "Book train", scheduled: "2026-11-02", due: "2026-11-06", next: true, style: "dataview", done: false }
  );
  const em = parseInlineTask("  * [x] #Planner/Task Change wheel setup ⏫ 🛫 2022-08-10 ⏳ 2022-08-11 📅 2022-08-12 ✅ 2022-08-13");
  assert.deepEqual(
    { indent: em?.indent, bullet: em?.bullet, text: em?.text, start: em?.start, scheduled: em?.scheduled, due: em?.due, completed: em?.completed, style: em?.style },
    { indent: "  ", bullet: "*", text: "#Planner/Task Change wheel setup ⏫", start: "2022-08-10", scheduled: "2022-08-11", due: "2022-08-12", completed: "2022-08-13", style: "emoji" }
  );
  assert.equal(parseInlineTask("Just a line"), null);
  assert.equal(parseInlineTask("- a bullet, not a box"), null);
  assert.equal(parseInlineTask("1. [ ] numbered step")?.text, "numbered step");
});

test("ticking adds today's completion date in the line's own style; unticking takes it off", () => {
  const dv = "- [ ] #project/game Download UE5";
  const ticked = writeInlineTask(dv, { done: true }, TODAY);
  assert.equal(ticked, "- [x] #project/game Download UE5 [completion:: 2026-10-27]");
  assert.equal(writeInlineTask(ticked, { done: false }, TODAY), dv);
  const em = "- [ ] Pack the bike bag 📅 2026-11-06";
  assert.equal(writeInlineTask(em, { done: true }, TODAY), "- [x] Pack the bike bag 📅 2026-11-06 ✅ 2026-10-27");
});

test("dates are set, moved or taken off without touching the rest of the line", () => {
  const line = "  - [ ] Call the landlord <!-- from the viewing --> [due:: 2026-11-06] ⏫";
  assert.equal(writeInlineTask(line, { due: "2026-11-09" }, TODAY), "  - [ ] Call the landlord <!-- from the viewing --> ⏫ [due:: 2026-11-09]");
  assert.equal(writeInlineTask(line, { due: null }, TODAY), "  - [ ] Call the landlord <!-- from the viewing --> ⏫");
  assert.equal(writeInlineTask(line, { scheduled: "2026-11-02" }, TODAY), line + " [scheduled:: 2026-11-02]");
  assert.equal(writeInlineTask("- [ ] Pack 📅 2026-11-06", { scheduled: "2026-11-05" }, TODAY), "- [ ] Pack 📅 2026-11-06 ⏳ 2026-11-05");
});

test("new words keep the line's fields, tags and comments; #next comes and goes", () => {
  const line = "- [ ] Bok train <!-- c --> [due:: 2026-11-06] #next";
  assert.equal(writeInlineTask(line, { text: "Book the train to the coast" }, TODAY), "- [ ] Book the train to the coast <!-- c --> [due:: 2026-11-06] #next");
  assert.equal(writeInlineTask(line, { next: false }, TODAY), "- [ ] Bok train <!-- c --> [due:: 2026-11-06]");
  assert.equal(writeInlineTask("- [ ] Plan", { next: true }, TODAY), "- [ ] Plan #next");
  assert.equal(writeInlineTask("not a task", { done: true }, TODAY), "not a task");
});

test("displayText takes out any Dataview field, emoji dates and #next — as the old stepText did, and more", () => {
  assert.equal(displayText("Buy parts [cost:: 40] (due:: 2026-11-06) ➕ 2026-10-01 #next"), "Buy parts");
});
