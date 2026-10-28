import { test } from "node:test";
import assert from "node:assert/strict";
import { noteTaskLines, noteTasksToItems } from "../src/noteTasks.ts";

const base = { path: "n.md", name: "n", isTaskLink: (l: string) => l === "Call the bank" };

test("in a day note every open box is a task, on the note's own day unless it says otherwise", () => {
  const text = ["# 2026-10-14", "- [ ] lemons", "- [x] bread", "- [ ] Return parcel 📅 2026-10-22", "- [ ] Dentist [scheduled:: 2026-10-30]", "- [ ] [[Call the bank]]", "Just a line"].join("\n");
  const got = noteTaskLines({ ...base, text, dayDate: "2026-10-14", dated: true });
  assert.deepEqual(got.map((t) => [t.text, t.scheduled, t.due, t.line]), [
    ["lemons", "2026-10-14", null, 1],
    ["Return parcel", null, "2026-10-22", 3], // a deadline of its own: not also put on the note's day
    ["Dentist", "2026-10-30", null, 4],
  ]); // the box that only links to a task note is that task, already shown
});

test("elsewhere only dated or #task boxes count — a plain checklist stays a checklist", () => {
  const text = ["- [ ] milk", "- [ ] Book train ⏳ 2026-11-02", "- [ ] Ring Mum #task", "- [ ] Renew passport [due:: 2026-12-01] #next"].join("\n");
  const got = noteTaskLines({ ...base, text, dayDate: null, dated: true });
  assert.deepEqual(got.map((t) => [t.text, t.scheduled, t.due, t.isNext]), [
    ["Book train", "2026-11-02", null, false],
    ["Ring Mum", null, null, false],
    ["Renew passport", null, "2026-12-01", true],
  ]);
  assert.deepEqual(noteTaskLines({ ...base, text, dayDate: null, dated: false }), []);
});

test("noteTasksToItems places a task on its do-date, else its deadline, within the range", () => {
  const tasks = noteTaskLines({ ...base, text: "- [ ] A ⏳ 2026-11-02\n- [ ] B 📅 2026-11-05\n- [ ] C #task", dayDate: null, dated: true });
  assert.deepEqual(noteTasksToItems(tasks, "2026-11-01", "2026-11-30").map((i) => [i.kind, i.title, i.date, i.line]), [
    ["note", "A", "2026-11-02", 0],
    ["note", "B", "2026-11-05", 1],
  ]);
});
