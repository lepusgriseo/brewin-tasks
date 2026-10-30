import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPatch,
  deadline,
  deadlineLabel,
  isStalled,
  nextSteps,
  projectFromFrontmatter,
  ProjectInfo,
  plainText,
  promoteCandidates,
  statusPatch,
  stepText,
  tagStep,
  tickStep,
  withLogEntry,
  withNewStep,
  withProjectFields,
} from "../src/projects.ts";

const TODAY = "2026-10-21";

const project = (p: Partial<ProjectInfo> = {}): ProjectInfo => ({
  path: "03_Projects/EmuDeck.md",
  name: "EmuDeck",
  status: "active",
  waitingOn: "",
  due: null,
  completed: null,
  ...p,
});

// ── Reading a project note ───────────────────────────────────────────────────

test("reads the fields Project HQ uses, empty ones as empty — and ignores an old next: property", () => {
  const p = projectFromFrontmatter("03_Projects/Inventory List.md", "Inventory List", {
    status: "Active",
    next: "Count the cables",
    waiting_on: "",
    due: "2026-10-04",
    started: "2026-05-11",
    completed: false, // as one real note has it
  });
  assert.deepEqual(p, {
    path: "03_Projects/Inventory List.md",
    name: "Inventory List",
    status: "active",
    waitingOn: "",
    due: "2026-10-04",
    started: "2026-05-11",
    completed: null,
  });
  assert.equal(projectFromFrontmatter("p.md", "P", { status: "paused" }).status, null);
  assert.equal(projectFromFrontmatter("p.md", "P", undefined).status, null);
});

test("stalled is Life HQ's rule: an active project with no open #next step", () => {
  assert.equal(isStalled(project(), []), true);
  assert.equal(isStalled(project(), [{ isNext: false }]), true);
  assert.equal(isStalled(project(), [{ isNext: true }]), false);
  assert.equal(isStalled(project({ status: "waiting" }), []), false);
  assert.equal(isStalled(project({ status: "someday" }), []), false);
});

test("the deadline reads in days, and stops counting once the project is done", () => {
  const d = deadline(project({ due: "2026-10-04" }), TODAY)!;
  assert.deepEqual(d, { iso: "2026-10-04", days: -17, overdue: true });
  assert.equal(deadlineLabel(d), "17 days overdue");
  assert.equal(deadlineLabel({ days: -1 }), "1 day overdue");
  assert.equal(deadlineLabel({ days: 0 }), "due today");
  assert.equal(deadlineLabel({ days: 1 }), "due tomorrow");
  assert.equal(deadlineLabel({ days: 101 }), "in 101 days");
  assert.equal(deadline(project({ due: "2026-10-04", status: "done" }), TODAY), null);
  assert.equal(deadline(project(), TODAY), null);
});

// ── Steps ────────────────────────────────────────────────────────────────────

test("a step reads without its inline fields, #next tag or HTML comment", () => {
  assert.equal(
    stepText("Send the quote request to the roofer, in writing [due:: 2026-08-07] <!-- adjust once the survey is back -->"),
    "Send the quote request to the roofer, in writing"
  );
  assert.equal(stepText("Install Containerlab on the Pi #next"), "Install Containerlab on the Pi");
  assert.equal(stepText("#next Read the guide [scheduled:: 2026-10-22]"), "Read the guide");
});

test("on screen, links show their names and markdown marks drop away", () => {
  assert.equal(plainText("Read [[Pronunciation Guide]] once, out loud"), "Read Pronunciation Guide once, out loud");
  assert.equal(plainText("Note it in [[05_Resources/Spanish/Spanish HQ|the hub]]"), "Note it in the hub");
  assert.equal(plainText("**Book the exam** first, `any-handle` is fine, *really*"), "Book the exam first, any-handle is fine, really");
  assert.equal(plainText("snake_case_name stays"), "snake_case_name stays");
});

const step = (text: string, isNext = false, line = 0) => ({ text, isNext, line });

test("the next actions are the #next steps, in the note's order", () => {
  const s1 = step("one", true, 5);
  const s2 = step("two", false, 2);
  const s3 = step("three", true, 3);
  assert.deepEqual(nextSteps([s1, s2, s3]), [s3, s1]);
  assert.deepEqual(nextSteps([s2]), []);
});

test("steps are offered #next first, then the rest in note order, without the one being ticked", () => {
  const s1 = step("one", false, 1);
  const s2 = step("two", true, 2);
  const s3 = step("three", false, 3);
  const s4 = step("four", true, 4);
  assert.deepEqual(promoteCandidates([s1, s2, s3, s4]), [s2, s4, s1, s3]);
  assert.deepEqual(promoteCandidates([s1, s2, s3, s4], s2), [s4, s1, s3]);
});

// ── Writing the note ─────────────────────────────────────────────────────────

const NOTE = [
  "---",
  'up: "[[03_Projects]]"',
  "tags:",
  "  - project",
  "status: active",
  'waiting_on: ""',
  'area: "Gaming"',
  'goal: ""',
  "due:",
  "started:",
  "completed:",
  "modified: 2026-07-06",
  "---",
  "## Goal",
  "",
  "## Tasks",
  "- [ ] Download MediEvil (PS1) #next",
  "- [ ] Set up the controller",
  "",
  "## Log",
].join("\n");

test("a field change is a one-line change, quoted the way the template quotes it", () => {
  const out = withProjectFields(NOTE, { waiting_on: 'the "Back" button', modified: TODAY });
  const before = NOTE.split("\n");
  const after = out.split("\n");
  assert.equal(after.length, before.length);
  const changed = after.map((l, i) => (l === before[i] ? null : l)).filter(Boolean);
  assert.deepEqual(changed, ['waiting_on: "the \\"Back\\" button"', `modified: ${TODAY}`]);
});

test("dates are written bare, and a cleared one as an empty key", () => {
  assert.match(withProjectFields(NOTE, { due: "2027-01-30" }), /^due: 2027-01-30$/m);
  const cleared = withProjectFields(withProjectFields(NOTE, { due: "2027-01-30" }), { due: null });
  assert.equal(cleared, NOTE);
  assert.match(withProjectFields(NOTE, { status: "waiting", waiting_on: "parts" }), /^status: waiting\nwaiting_on: "parts"$/m);
});

test("a missing field is added beside the one it's read with", () => {
  const bare = NOTE.replace(/^waiting_on: .*\n/m, "").replace(/^modified: .*\n/m, "");
  const out = withProjectFields(bare, { waiting_on: "the dock", modified: TODAY });
  assert.match(out, /^status: active\nwaiting_on: "the dock"$/m);
  assert.match(out, /^completed:\nmodified: 2026-10-21\n---$/m);
});

test("a value written over several lines is replaced whole", () => {
  const folded = NOTE.replace('waiting_on: ""', "waiting_on: >\n  the parts\n  (PS1)");
  const out = withProjectFields(folded, { waiting_on: "nothing" });
  assert.match(out, /^waiting_on: "nothing"\narea: "Gaming"$/m);
  assert.doesNotMatch(out, /PS1\)\n/);
});

test("a note without frontmatter gets some", () => {
  assert.equal(withProjectFields("# Plan\n", { status: "active" }), "---\nstatus: active\n---\n# Plan\n");
  assert.equal(withProjectFields("---\n---\n# Plan\n", { status: "someday" }), "---\nstatus: someday\n---\n# Plan\n");
});

test("ticking and tagging find their line even after the note has moved", () => {
  const lines = NOTE.split("\n");
  const raw = "- [ ] Set up the controller";
  const at = lines.indexOf(raw);
  lines.splice(0, 0, "an extra line"); // the note changed since the step was read
  assert.equal(tickStep(lines, at, raw), true);
  assert.equal(lines[at + 1], "- [x] Set up the controller");
  assert.equal(tickStep(lines, at, raw), false); // gone: nothing else is ticked in its place

  const tagged = "- [ ] Download MediEvil (PS1) #next";
  assert.equal(tagStep(lines, lines.indexOf(tagged), tagged), false); // already the next action
  const untagged = "- [ ] Set up the pad [due:: 2026-11-02]";
  lines.push(untagged);
  assert.equal(tagStep(lines, 0, untagged), true);
  assert.equal(lines[lines.length - 1], "- [ ] Set up the pad [due:: 2026-11-02] #next");
});

test("a typed next action becomes a #next step, first under Tasks", () => {
  assert.match(withNewStep(NOTE, "  Map the  Back button "), /## Tasks\n- \[ \] Map the Back button #next\n- \[ \] Download MediEvil/);
  assert.equal(withNewStep("## Goal\nShip\n\n## Log\n- Created", "Plan"), "## Goal\nShip\n\n## Tasks\n- [ ] Plan #next\n\n## Log\n- Created");
  assert.equal(withNewStep("# Plan\n", "Plan"), "# Plan\n\n## Tasks\n- [ ] Plan #next\n");
});

test("a log entry goes under today, after the last entry and before the time-tracking callout", () => {
  const note = "## Log\n### 2026-07-07\n- Started project\n\n> [!info]- ⏱️ Time Tracking\n> ```dataviewjs\n> ```\n";
  const once = withLogEntry(note, TODAY, "Done: Count the cables");
  assert.equal(
    once,
    "## Log\n### 2026-07-07\n- Started project\n\n### 2026-10-21\n- Done: Count the cables\n\n> [!info]- ⏱️ Time Tracking\n> ```dataviewjs\n> ```\n"
  );
  const twice = withLogEntry(once, TODAY, "Done: Label the drawers");
  assert.match(twice, /### 2026-10-21\n- Done: Count the cables\n- Done: Label the drawers\n\n> \[!info\]/);
});

test("a log that is empty, or missing, still takes the entry", () => {
  assert.equal(withLogEntry("## Tasks\n- [ ] a\n\n## Log", TODAY, "Done: a"), "## Tasks\n- [ ] a\n\n## Log\n### 2026-10-21\n- Done: a");
  assert.equal(withLogEntry("## Goal\nShip it\n", TODAY, "Done: a"), "## Goal\nShip it\n\n## Log\n### 2026-10-21\n- Done: a\n");
  // The log ends at the next section.
  assert.equal(
    withLogEntry("## Log\n### 2026-07-24\n- Created\n\n## Notes\n- not a log entry", TODAY, "Done: a"),
    "## Log\n### 2026-07-24\n- Created\n\n### 2026-10-21\n- Done: a\n\n## Notes\n- not a log entry"
  );
});

// ── Status changes ───────────────────────────────────────────────────────────

test("a status change keeps waiting_on and completed in step with it", () => {
  assert.deepEqual(statusPatch(project(), "waiting", TODAY, " the landlord "), { status: "waiting", waiting_on: "the landlord" });
  assert.deepEqual(statusPatch(project({ status: "waiting", waitingOn: "parts" }), "active", TODAY), { status: "active", waiting_on: "" });
  assert.deepEqual(statusPatch(project(), "done", TODAY), { status: "done", completed: TODAY });
  assert.deepEqual(statusPatch(project({ status: "done", completed: "2026-09-01" }), "active", TODAY), { status: "active", completed: null });
  assert.deepEqual(statusPatch(project(), "someday", TODAY), { status: "someday" });
});

test("the project reads as written straight after a write", () => {
  const p = applyPatch(project({ due: "2026-10-04" }), { due: null, status: "waiting", waiting_on: " parts " });
  assert.equal(p.due, null);
  assert.equal(p.status, "waiting");
  assert.equal(p.waitingOn, "parts");
  assert.equal(applyPatch(p, {}).waitingOn, "parts");
});
