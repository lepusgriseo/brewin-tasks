import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPatch,
  deadline,
  deadlineLabel,
  isStalled,
  matchStep,
  projectFromFrontmatter,
  ProjectInfo,
  plainText,
  promoteCandidates,
  statusPatch,
  stepText,
  tickStep,
  untagStep,
  withLogEntry,
  withProjectFields,
} from "../src/projects.ts";

const TODAY = "2026-10-21";

const project = (p: Partial<ProjectInfo> = {}): ProjectInfo => ({
  path: "03_Projects/EmuDeck.md",
  name: "EmuDeck",
  status: "active",
  next: "",
  waitingOn: "",
  due: null,
  completed: null,
  ...p,
});

// ── Reading a project note ───────────────────────────────────────────────────

test("reads the fields Project HQ uses, empty ones as empty", () => {
  const p = projectFromFrontmatter("03_Projects/Inventory List.md", "Inventory List", {
    status: "Active",
    next: null,
    waiting_on: "",
    due: "2026-10-04",
    started: "2026-05-11",
    completed: false, // as one real note has it
  });
  assert.deepEqual(p, {
    path: "03_Projects/Inventory List.md",
    name: "Inventory List",
    status: "active",
    next: "",
    waitingOn: "",
    due: "2026-10-04",
    started: "2026-05-11",
    completed: null,
  });
  assert.equal(projectFromFrontmatter("p.md", "P", { status: "paused" }).status, null);
  assert.equal(projectFromFrontmatter("p.md", "P", undefined).status, null);
});

test("stalled is HQ's rule: active, no next action, and no #next step waiting to be promoted", () => {
  assert.equal(isStalled(project(), []), true);
  assert.equal(isStalled(project(), [{ isNext: false }]), true);
  assert.equal(isStalled(project(), [{ isNext: true }]), false); // one just needs promoting
  assert.equal(isStalled(project({ next: "Download MediEvil (PS1)" }), []), false);
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

test("a finished next action finds the step it was copied from, even reworded", () => {
  const github = step("Create Codeberg account (`any-handle` is fine) + profile README repo named exactly your username", true);
  const readme = step("Write the profile README — one paragraph: who you are, what you build, what you're working toward. Not a CV.");
  assert.deepEqual(matchStep("Create the Codeberg account (any-handle) + profile README repo", [readme, github]), { step: github, sure: true });

  const email = step("Send the quote request to the roofer, in writing");
  assert.deepEqual(matchStep("Send the quote request to the roofer, in writing", [email]), { step: email, sure: true });
});

test("a short step the action repeats, or a long reword, is offered as a guess", () => {
  const medievil = step("MediEvil", true);
  const crash = step("Download Crash Bandicoot");
  assert.deepEqual(matchStep("Download MediEvil (PS1)", [crash, medievil]), { step: medievil, sure: false });

  const guide = step("Read [[Pronunciation Guide]] out loud, all the way through — it is the only lesson that must be done before the others");
  const accent = step("Decide Spain vs Latin America pronunciation and note it at the top of [[Spanish HQ]]");
  assert.deepEqual(
    matchStep("Read [[Pronunciation Guide]] once, out loud, and record yourself saying the five vowels", [guide, accent]),
    { step: guide, sure: false }
  );
});

test("nothing is offered when nothing is close", () => {
  const steps = [step("Write the profile README"), step("Pin the six repos as they ship")];
  assert.equal(matchStep("Book the ENCOR exam for late January 2027", steps), null);
  assert.deepEqual(matchStep("README", steps), { step: steps[0], sure: false }); // one word is never sure
  assert.equal(matchStep("", steps), null);
});

test("between equally close steps, the #next one wins", () => {
  const a = step("Set up the Python venv");
  const b = step("Set up the Python venv on Fedora", true);
  assert.deepEqual(matchStep("Set up Python venv", [a, b]), { step: a, sure: true }); // a is exactly the same words
  const c = step("Python venv setup notes");
  const d = step("Python venv setup script", true);
  assert.deepEqual(matchStep("venv setup python", [c, d]), { step: d, sure: true });
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
  'next: "Download MediEvil (PS1)"',
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
  const out = withProjectFields(NOTE, { next: 'Map the "Back" button', modified: TODAY });
  const before = NOTE.split("\n");
  const after = out.split("\n");
  assert.equal(after.length, before.length);
  const changed = after.map((l, i) => (l === before[i] ? null : l)).filter(Boolean);
  assert.deepEqual(changed, ['next: "Map the \\"Back\\" button"', `modified: ${TODAY}`]);
});

test("dates are written bare, and a cleared one as an empty key", () => {
  assert.match(withProjectFields(NOTE, { due: "2027-01-30" }), /^due: 2027-01-30$/m);
  const cleared = withProjectFields(withProjectFields(NOTE, { due: "2027-01-30" }), { due: null });
  assert.equal(cleared, NOTE);
  assert.match(withProjectFields(NOTE, { status: "waiting", waiting_on: "parts" }), /^status: waiting\nnext: .*\nwaiting_on: "parts"$/m);
});

test("a missing field is added beside the one it's read with", () => {
  const noNext = NOTE.replace(/^next: .*\n/m, "").replace(/^modified: .*\n/m, "");
  const out = withProjectFields(noNext, { next: "Plug the dock in", modified: TODAY });
  assert.match(out, /^status: active\nnext: "Plug the dock in"$/m);
  assert.match(out, /^completed:\nmodified: 2026-10-21\n---$/m);
});

test("a value written over several lines is replaced whole", () => {
  const folded = NOTE.replace('next: "Download MediEvil (PS1)"', "next: >\n  Download MediEvil\n  (PS1)");
  const out = withProjectFields(folded, { next: "Done with it" });
  assert.match(out, /^next: "Done with it"\nwaiting_on: ""$/m);
  assert.doesNotMatch(out, /MediEvil\n/);
});

test("a note without frontmatter gets some", () => {
  assert.equal(withProjectFields("# Plan\n", { status: "active" }), "---\nstatus: active\n---\n# Plan\n");
  assert.equal(withProjectFields("---\n---\n# Plan\n", { status: "someday" }), "---\nstatus: someday\n---\n# Plan\n");
});

test("ticking and untagging find their line even after the note has moved", () => {
  const lines = NOTE.split("\n");
  const raw = "- [ ] Set up the controller";
  const at = lines.indexOf(raw);
  lines.splice(0, 0, "an extra line"); // the note changed since the step was read
  assert.equal(tickStep(lines, at, raw), true);
  assert.equal(lines[at + 1], "- [x] Set up the controller");
  assert.equal(tickStep(lines, at, raw), false); // gone: nothing else is ticked in its place

  const tagged = "- [ ] Download MediEvil (PS1) #next";
  assert.equal(untagStep(lines, lines.indexOf(tagged), tagged), true);
  assert.ok(lines.includes("- [ ] Download MediEvil (PS1)"));
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
  const p = applyPatch(project({ next: "old", due: "2026-10-04" }), { next: " new ", due: null, status: "waiting", waiting_on: "parts" });
  assert.equal(p.next, "new");
  assert.equal(p.due, null);
  assert.equal(p.status, "waiting");
  assert.equal(p.waitingOn, "parts");
  assert.equal(applyPatch(p, {}).next, "new");
});
