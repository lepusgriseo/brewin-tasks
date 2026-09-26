import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContextIndex,
  filterableContexts,
  hasContext,
  canonicaliseContext,
  parseContexts,
  strayContexts,
  toggleContext,
} from "../src/contexts.ts";

// Mirrors the real vault: obsidian ×25 / Obsidian ×1, work ×4 / Work ×1.
const USED = [
  ...Array(25).fill("obsidian"),
  "Obsidian",
  ...Array(4).fill("work"),
  "Work",
  ...Array(9).fill("home"),
  "Rasputin",
];
const CONFIGURED = ["home", "work", "shopping", "errand", "journal", "plants"];
const idx = buildContextIndex(USED, CONFIGURED);

test("the most-used spelling wins", () => {
  assert.equal(canonicaliseContext("Obsidian", idx), "obsidian");
  assert.equal(canonicaliseContext("obsidian", idx), "obsidian");
  assert.equal(canonicaliseContext("OBSIDIAN", idx), "obsidian");
  assert.equal(canonicaliseContext("Work", idx), "work");
});

test("counts are summed across variants, not split between them", () => {
  assert.equal(idx.counts.get("obsidian"), 26); // 25 + the stray capital
  assert.equal(idx.counts.get("work"), 5);
  assert.equal(idx.counts.has("Obsidian"), false); // the loser isn't a context in its own right
});

test("a genuinely new context is kept exactly as typed", () => {
  assert.equal(canonicaliseContext("Bicycles", idx), "Bicycles");
  assert.equal(canonicaliseContext("  Deep Work  ", idx), "Deep Work"); // trimmed only
});

test("a single-use context keeps its own capitalisation", () => {
  assert.equal(canonicaliseContext("rasputin", idx), "Rasputin"); // only spelling in use
});

test("configured-but-unused contexts are offered without outranking real usage", () => {
  assert.ok(idx.suggestions.includes("plants")); // configured, zero uses
  assert.equal(idx.counts.get("plants"), 0);
  assert.equal(idx.suggestions[0], "obsidian"); // most used leads
});

test("suggestions are ordered by use, then alphabetically", () => {
  assert.deepEqual(idx.suggestions.slice(0, 3), ["obsidian", "home", "work"]);
});

test("ties are settled deterministically, preferring a configured spelling", () => {
  // "Home" and "home" both used once; "home" is the configured one.
  const tied = buildContextIndex(["Home", "home"], ["home"]);
  assert.equal(canonicaliseContext("HOME", tied), "home");
  // With nothing configured it falls back to alphabetical, never read order.
  const a = buildContextIndex(["Zeta", "zeta"], []);
  const b = buildContextIndex(["zeta", "Zeta"], []);
  assert.equal(canonicaliseContext("ZETA", a), canonicaliseContext("ZETA", b));
});

test("parseContexts canonicalises, trims and de-duplicates", () => {
  assert.deepEqual(parseContexts("Obsidian, home", idx), ["obsidian", "home"]);
  // "work" and "Work" are the same context — one survives, not two.
  assert.deepEqual(parseContexts("work, Work", idx), ["work"]);
  assert.deepEqual(parseContexts("  obsidian ,, home , ", idx), ["obsidian", "home"]);
  assert.deepEqual(parseContexts("", idx), []);
});

test("toggleContext adds and removes case-insensitively", () => {
  assert.deepEqual(toggleContext([], "Obsidian", idx), ["obsidian"]);
  assert.deepEqual(toggleContext(["obsidian"], "Obsidian", idx), []); // matched despite the case
  assert.deepEqual(toggleContext(["home"], "work", idx), ["home", "work"]);
});

test("strayContexts lists exactly what needs tidying", () => {
  assert.deepEqual(strayContexts(idx, USED), [
    { from: "Obsidian", to: "obsidian", uses: 1 },
    { from: "Work", to: "work", uses: 1 },
  ]);
});

test("an empty vault degrades gracefully", () => {
  const empty = buildContextIndex([], []);
  assert.deepEqual(empty.suggestions, []);
  assert.equal(canonicaliseContext("anything", empty), "anything");
  assert.deepEqual(parseContexts("a, b", empty), ["a", "b"]);
});

test("hasContext matches regardless of case", () => {
  assert.equal(hasContext(["Obsidian", "home"], "obsidian"), true);
  assert.equal(hasContext(["obsidian"], "OBSIDIAN"), true);
  assert.equal(hasContext(["home"], "work"), false);
});

test("a context carried only by DONE tasks isn't offered as a filter", () => {
  // Exactly the reported bug: `Obsidian` sat in the dropdown but every view came back empty,
  // because its only task was completed.
  const opts = filterableContexts([
    { contexts: ["Obsidian"], status: "done" },
    { contexts: ["obsidian"], status: "todo" },
    { contexts: ["shopping"], status: "todo" },
    { contexts: ["retired"], status: "done" },
  ]);
  assert.deepEqual(opts.map((o) => o.value), ["obsidian", "shopping"]);
  assert.equal(opts.find((o) => o.value === "retired"), undefined);
});

test("filter counts reflect OPEN tasks only, and merge case variants", () => {
  const opts = filterableContexts([
    { contexts: ["obsidian"], status: "todo" },
    { contexts: ["Obsidian"], status: "todo" },
    { contexts: ["obsidian"], status: "done" }, // finished — not counted
    { contexts: ["home"], status: "hold" }, // parked, but still open work
  ]);
  assert.deepEqual(opts, [
    { value: "obsidian", count: 2 },
    { value: "home", count: 1 },
  ]);
});
