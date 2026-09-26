import { test } from "node:test";
import assert from "node:assert/strict";
import { taskFromFrontmatter, applyTaskToFrontmatter, parentLinkpath, toWikilink, sanitizeFilename } from "../src/task.ts";

test("sanitizeFilename strips characters a note filename can't contain", () => {
  assert.equal(sanitizeFilename("Ship v2"), "Ship v2");
  assert.equal(sanitizeFilename("Fix bug #42"), "Fix bug 42");
  assert.equal(sanitizeFilename("A/B: test?"), "AB test");
  assert.equal(sanitizeFilename("  spaced   out  "), "spaced out"); // collapsed + trimmed
  assert.equal(sanitizeFilename("[[link]]"), "link");
  assert.equal(sanitizeFilename("///"), ""); // nothing usable → caller decides
});

test("a renamed title survives the wikilink round-trip children rely on", () => {
  const newName = sanitizeFilename("Ship v2 — final");
  assert.equal(parentLinkpath(toWikilink(newName)), newName);
});

test("parentLinkpath extracts the note name from a wikilink", () => {
  assert.equal(parentLinkpath("[[Ship v2]]"), "Ship v2");
  assert.equal(parentLinkpath("  [[Ship v2]]  "), "Ship v2");
  assert.equal(parentLinkpath("[[Ship v2|the release]]"), "Ship v2"); // alias stripped
  assert.equal(parentLinkpath("[[Ship v2#Heading]]"), "Ship v2"); // heading stripped
  assert.equal(parentLinkpath("Ship v2"), "Ship v2"); // bare name tolerated
  assert.equal(parentLinkpath(null), null);
  assert.equal(parentLinkpath(""), null);
});

test("toWikilink round-trips through parentLinkpath", () => {
  const name = "Ship v2 (Q3)";
  assert.equal(parentLinkpath(toWikilink(name)), name);
});

test("frontmatter → Task reads the parent link", () => {
  const t = taskFromFrontmatter({ status: "todo", parent: "[[Ship v2]]" }, "Items/Fix bug.md", "Fix bug");
  assert.equal(t.parent, "[[Ship v2]]");
  assert.equal(t.parentPath, null); // resolved later by the store (needs the metadata cache)
});

test("a task with no parent stays top-level", () => {
  const t = taskFromFrontmatter({ status: "todo" }, "Items/Solo.md", "Solo");
  assert.equal(t.parent, null);
  assert.equal(t.parentPath, null);
});

test("Task → frontmatter writes the parent, and clearing it removes the key", () => {
  const t = taskFromFrontmatter({ status: "todo", parent: "[[Ship v2]]" }, "Items/Fix bug.md", "Fix bug");

  const fm: Record<string, unknown> = {};
  applyTaskToFrontmatter(fm, t);
  assert.equal(fm.parent, "[[Ship v2]]");

  // Clearing the parent must delete the key rather than leave an empty value behind.
  const cleared = { ...t, parent: null };
  const fm2: Record<string, unknown> = { parent: "[[Ship v2]]" };
  applyTaskToFrontmatter(fm2, cleared);
  assert.equal("parent" in fm2, false);
});

test("frontmatter → Task reads which month a task is dedicated to", () => {
  const dedicated = taskFromFrontmatter({ status: "todo", month: "2026-09" }, "Items/Strength training.md", "Strength training");
  assert.equal(dedicated.month, "2026-09");

  // An ordinary, undated task (most tasks) has no month at all — must read as null, not "".
  const ordinary = taskFromFrontmatter({ status: "todo" }, "Items/Call plumber.md", "Call plumber");
  assert.equal(ordinary.month, null);
});

test("Task → frontmatter writes month, and clearing it removes the key rather than a stale value", () => {
  const t = taskFromFrontmatter({ status: "todo", month: "2026-09" }, "Items/Strength training.md", "Strength training");

  const fm: Record<string, unknown> = {};
  applyTaskToFrontmatter(fm, t);
  assert.equal(fm.month, "2026-09");

  const cleared = { ...t, month: null };
  const fm2: Record<string, unknown> = { month: "2026-09" };
  applyTaskToFrontmatter(fm2, cleared);
  assert.equal("month" in fm2, false);
});

test("Task.week round-trips through frontmatter, and clearing removes the key", () => {
  const dedicated = taskFromFrontmatter({ status: "todo", week: "2026-W37" }, "Items/Book flights.md", "Book flights");
  assert.equal(dedicated.week, "2026-W37");

  // A bare task has no week — must read as null, not "".
  assert.equal(taskFromFrontmatter({ status: "todo" }, "Items/x.md", "x").week, null);

  const fm: Record<string, unknown> = {};
  applyTaskToFrontmatter(fm, dedicated);
  assert.equal(fm.week, "2026-W37");

  const fm2: Record<string, unknown> = { week: "2026-W37" };
  applyTaskToFrontmatter(fm2, { ...dedicated, week: null });
  assert.equal("week" in fm2, false);
});

test("task times round-trip, and clearing them removes the keys", () => {
  const timed = taskFromFrontmatter({ status: "todo", scheduled: "2026-07-24", startTime: "9:00", endTime: "10:30" }, "t.md", "t");
  assert.equal(timed.startTime, "09:00"); // normalised to HH:MM
  assert.equal(timed.endTime, "10:30");

  const fm: Record<string, unknown> = {};
  applyTaskToFrontmatter(fm, timed);
  assert.equal(fm.startTime, "09:00");
  assert.equal(fm.endTime, "10:30");
  assert.deepEqual(taskFromFrontmatter(fm, "t.md", "t").startTime, "09:00");

  // Back to all-day → the keys go away rather than lingering as empty values.
  const cleared = { ...timed, startTime: null, endTime: null };
  const fm2: Record<string, unknown> = { startTime: "09:00", endTime: "10:30" };
  applyTaskToFrontmatter(fm2, cleared);
  assert.equal("startTime" in fm2, false);
  assert.equal("endTime" in fm2, false);
});

test("an unparseable task time is ignored rather than corrupting the note", () => {
  const t = taskFromFrontmatter({ status: "todo", startTime: "nonsense", endTime: "25:99" }, "t.md", "t");
  assert.equal(t.startTime, null);
  assert.equal(t.endTime, null);
});

test("round-trip: write then read preserves the parent link", () => {
  const original = taskFromFrontmatter({ status: "todo", parent: toWikilink("Ship v2") }, "a.md", "a");
  const fm: Record<string, unknown> = {};
  applyTaskToFrontmatter(fm, original);
  const reread = taskFromFrontmatter(fm, "a.md", "a");
  assert.equal(reread.parent, original.parent);
  assert.equal(parentLinkpath(reread.parent), "Ship v2");
});
