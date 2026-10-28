import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, scoreMatch, search, searchTasks } from "../src/search.ts";
import type { Task } from "../src/types.ts";

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


function qtask(p: Partial<Task>): Task {
  return {
    path: `${p.title}.md`, title: "T", status: "todo", scheduled: null, endDate: null, startTime: null,
    endTime: null, due: null, priority: "normal", contexts: [], recurrence: null,
    recurrenceAnchor: "scheduled", completeInstances: [], exdates: [], times: [], completeSlots: {},
    onCompletion: "keep", created: null, completed: null, parent: null, parentPath: null, dependsOnPaths: [],
    ...p,
  } as Task;
}

test("parseQuery reads operators, phrases and leave-outs, and keeps words with colons as words", () => {
  const q = parseQuery('@home -@work !high due:week sched:none is:recurring -is:hold has:estimate project:ccnp energy:High "phone the" -bins Re: dentist is:nonsense', ["energy"]);
  assert.deepEqual(q.filters, [
    { kind: "context", value: "home", negate: false },
    { kind: "context", value: "work", negate: true },
    { kind: "priority", value: "high", negate: false },
    { kind: "date", field: "due", when: "week", negate: false },
    { kind: "date", field: "scheduled", when: "none", negate: false },
    { kind: "is", value: "recurring", negate: false },
    { kind: "is", value: "hold", negate: true },
    { kind: "has", value: "estimate", negate: false },
    { kind: "project", value: "ccnp", negate: false },
    { kind: "attr", key: "energy", value: "high", negate: false },
  ]);
  assert.deepEqual([q.phrases, q.exclude, q.text, q.unknown], [["phone the"], ["bins"], "Re: dentist", ["is:nonsense"]]);
  assert.deepEqual(parseQuery("due:<2026-11-02").filters[0], { kind: "date", field: "due", when: { before: "2026-11-02" }, negate: false });
});

test("searchTasks filters first, then ranks by the words left", () => {
  const ctx = { today: "2026-10-28", blocked: (t: Task) => t.title === "Blocked one" };
  const tasks = [
    qtask({ title: "Phone the bank", contexts: ["home"], priority: "high", due: "2026-10-30" }),
    qtask({ title: "Phone the garage", contexts: ["home"], due: "2026-11-20" }),
    qtask({ title: "Put the bins out", contexts: ["home"], recurrence: "FREQ=WEEKLY", scheduled: "2026-10-29" }),
    qtask({ title: "Blocked one", contexts: ["work"], estimate: 30 }),
    qtask({ title: "Done one", status: "done", top: "2026-10-28" }),
  ];
  const titles = (q: string) => searchTasks(tasks, parseQuery(q), ctx).map((t) => t.title);
  assert.deepEqual(titles("@home due:week"), ["Phone the bank"]);
  assert.deepEqual(titles("@home -is:recurring garage"), ["Phone the garage"]);
  assert.deepEqual(titles('"phone the" -bank'), ["Phone the garage"]);
  assert.deepEqual(titles("is:blocked has:estimate"), ["Blocked one"]);
  assert.deepEqual(titles("is:done is:top"), ["Done one"]);
  assert.deepEqual(titles("due:none sched:any"), ["Put the bins out"]);
  assert.deepEqual(titles("!high"), ["Phone the bank"]);
});
