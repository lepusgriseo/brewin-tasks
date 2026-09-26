import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreMatch, search } from "../src/search.ts";

const item = (title: string, contexts: string[] = []) => ({ title, contexts });

// Real titles from the vault, including the near-duplicate pair.
const TASKS = [
  item("Bleed hydraulics", ["home"]),
  item("Bleed hydraulics 2", ["home"]),
  item("Change handlebar wraps", ["home"]),
  item("Update inventory list", ["obsidian"]),
  item("Turn 650b wheels into tubeless", ["home"]),
  item("Recycle Samsung galaxy tab s6", ["shopping"]),
];

test("an exact title beats a prefix beats a word-start beats a substring", () => {
  const exact = scoreMatch(item("gym"), "gym")!;
  const prefix = scoreMatch(item("gym session"), "gym")!;
  const wordStart = scoreMatch(item("morning gym run"), "gym")!;
  const substring = scoreMatch(item("hygymnastics"), "gym")!;
  assert.ok(exact > prefix, "exact > prefix");
  assert.ok(prefix > wordStart, "prefix > word-start");
  assert.ok(wordStart > substring, "word-start > substring");
});

test("subsequence matching finds a title from initials", () => {
  assert.notEqual(scoreMatch(item("Bleed hydraulics"), "blhy"), null);
  assert.equal(scoreMatch(item("Bleed hydraulics"), "zzz"), null);
});

test("a scattered subsequence never outranks a real word match", () => {
  const results = search(TASKS, "hyd");
  assert.equal(results[0].title, "Bleed hydraulics");
});

test("near-identical titles rank the shorter, more specific one first", () => {
  const results = search(TASKS, "bleed hydraulics");
  assert.deepEqual(results.map((r) => r.title), ["Bleed hydraulics", "Bleed hydraulics 2"]);
});

test("context matches count but rank below title matches", () => {
  const results = search(TASKS, "shopping");
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Recycle Samsung galaxy tab s6");

  const titleWins = search(
    [item("Shopping list"), item("Buy milk", ["shopping"])],
    "shopping"
  );
  assert.equal(titleWins[0].title, "Shopping list");
});

test("search is case-insensitive and ignores surrounding space", () => {
  assert.equal(search(TASKS, "  BLEED  ")[0].title, "Bleed hydraulics");
});

test("an empty query returns everything, stably ordered", () => {
  const a = search(TASKS, "");
  const b = search([...TASKS].reverse(), "");
  assert.equal(a.length, TASKS.length);
  assert.deepEqual(a.map((x) => x.title), b.map((x) => x.title)); // order can't depend on input order
});

test("no match returns nothing rather than everything", () => {
  assert.deepEqual(search(TASKS, "qqqq"), []);
});
