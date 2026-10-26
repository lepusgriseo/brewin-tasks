import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attrChip,
  attrKeyFrom,
  attrMatches,
  attrMenuValues,
  formatAttr,
  groupByAttr,
  parseAttrInput,
  readAttr,
  readAttrs,
  sanitizeAttributes,
  TaskAttribute,
  uniqueAttrKey,
} from "../src/attributes.ts";

const cost: TaskAttribute = { key: "cost", label: "Cost", icon: "💷", kind: "number", unit: "£", onRow: true };
const dist: TaskAttribute = { key: "distance", label: "Distance", icon: "📏", kind: "number", unit: "km", onRow: true };
const client: TaskAttribute = { key: "client", label: "Client", icon: "🏷", kind: "link", onRow: true };
const energy: TaskAttribute = { key: "energy", label: "Energy", icon: "⚡", kind: "choice", options: ["low", "medium", "high"], onRow: true };
const parts: TaskAttribute = { key: "needs_parts", label: "Needs parts", icon: "🔧", kind: "bool", onRow: true };
const ordered: TaskAttribute = { key: "ordered", label: "Ordered", icon: "📆", kind: "date", onRow: false };
const room: TaskAttribute = { key: "room", label: "Room", icon: "📍", kind: "text", onRow: true };

test("keys: a slug from the name, never a key the Planner uses, never one taken", () => {
  assert.equal(attrKeyFrom("Needs parts!"), "needs_parts");
  assert.equal(attrKeyFrom("Café — Room"), "cafe_room");
  assert.equal(uniqueAttrKey("Cost", []), "cost");
  assert.equal(uniqueAttrKey("Cost", [cost]), "cost_2");
  assert.equal(uniqueAttrKey("Priority", []), "priority_2"); // the Planner's own
  assert.equal(uniqueAttrKey("Tags", []), "tags_2");
  assert.equal(uniqueAttrKey("???", []), "attribute");
});

test("sanitizeAttributes: malformed and repeated dropped; defaults filled in", () => {
  const out = sanitizeAttributes([
    cost,
    { key: "cost", label: "Again", kind: "text" },
    { key: "status", label: "Shadowing", kind: "text" },
    { key: "Energy", label: "", kind: "choice", options: ["low", "low", " high ", ""] },
    { key: "x", kind: "nonsense" },
    null,
  ]);
  assert.deepEqual(out, [cost, { key: "energy", label: "energy", icon: "🔘", kind: "choice", onRow: true, options: ["low", "high"] }]);
});

test("readAttr: each kind read from what a note might hold", () => {
  assert.equal(readAttr(cost, 120), 120);
  assert.equal(readAttr(cost, "£1,200.50"), 1200.5);
  assert.equal(readAttr(cost, "lots"), null);
  assert.equal(readAttr(parts, true), true);
  assert.equal(readAttr(parts, "no"), false);
  assert.equal(readAttr(ordered, "2026-10-20T10:00"), "2026-10-20");
  assert.equal(readAttr(ordered, "soon"), null);
  assert.equal(readAttr(client, "Mum"), "[[Mum]]");
  assert.equal(readAttr(client, "[[People/Mum|Mum]]"), "[[People/Mum|Mum]]");
  assert.equal(readAttr(client, ["[[Mum]]", "[[Dad]]"]), "[[Mum]]"); // a list keeps its first
  assert.equal(readAttr(room, "  "), null);
  assert.deepEqual(readAttrs([cost, room, parts], { cost: 40, room: "Kitchen", other: 1 }), { cost: 40, room: "Kitchen" });
});

test("parseAttrInput: typed text, or a toggle for yes/no; empty clears", () => {
  assert.equal(parseAttrInput(cost, "45.5"), 45.5);
  assert.equal(parseAttrInput(cost, ""), null);
  assert.equal(parseAttrInput(parts, true), true);
  assert.equal(parseAttrInput(room, " Hall "), "Hall");
});

test("formatAttr / attrChip: units before or after, link names, yes/no by name", () => {
  assert.equal(formatAttr(cost, 1200), "£1,200");
  assert.equal(formatAttr(dist, 12.345), "12.35 km");
  assert.equal(formatAttr(client, "[[People/Mum|Mummy]]"), "Mummy");
  assert.equal(formatAttr(client, "[[People/Mum]]"), "Mum");
  assert.equal(attrChip(cost, 120), "💷 £120");
  assert.equal(attrChip(parts, true), "🔧 Needs parts");
  assert.equal(attrChip(parts, false), null);
});

test("filters: text and links by value (case ignored), yes/no by yes, numbers by having one", () => {
  assert.equal(attrMatches(client, { client: "[[People/Mum|Mum]]" }, "mum"), true);
  assert.equal(attrMatches(room, { room: "Kitchen" }, "KITCHEN"), true);
  assert.equal(attrMatches(parts, { needs_parts: false }, "yes"), false);
  assert.equal(attrMatches(cost, { cost: 3 }, "any"), true);
  assert.equal(attrMatches(cost, {}, "any"), false);
});

test("attrMenuValues: values on open tasks with counts; choices in their own order", () => {
  const tasks = [
    { status: "todo", attrs: { energy: "high", client: "[[Mum]]" } },
    { status: "todo", attrs: { energy: "low", client: "[[Mum]]" } },
    { status: "hold", attrs: { energy: "high", client: "[[Dad]]" } },
    { status: "done", attrs: { energy: "medium" } },
  ];
  assert.deepEqual(attrMenuValues(energy, tasks).map((r) => [r.value, r.count]), [["low", 1], ["high", 2]]);
  assert.deepEqual(attrMenuValues(client, tasks).map((r) => [r.label, r.count]), [["Mum", 2], ["Dad", 1]]);
  assert.deepEqual(attrMenuValues(cost, [{ status: "todo", attrs: { cost: 5 } }, { status: "todo", attrs: { cost: 9 } }]), [{ value: "any", label: "Has one", count: 2 }]);
});

test("groupByAttr: a group per value in a sensible order, the rest last, done left out", () => {
  const t = (title: string, attrs: Record<string, string | number | boolean>, status = "todo") => ({ title, status, scheduled: null, attrs });
  const groups = groupByAttr(energy, [t("A", { energy: "high" }), t("B", {}), t("C", { energy: "low" }), t("D", { energy: "low" }, "done")]);
  assert.deepEqual(groups.map((g) => [g.label, g.tasks.map((x) => x.title)]), [["low", ["C"]], ["high", ["A"]], [null, ["B"]]]);
  const byCost = groupByAttr(cost, [t("A", { cost: 120 }), t("B", { cost: 15 })]);
  assert.deepEqual(byCost.map((g) => g.label), ["£15", "£120"]);
});

// ── Search, drops and saved filters ─────────────────────────────────────────

import { search } from "../src/search.ts";
import { matchesFilter, resolveDrop, suggestFilterName, DashState } from "../src/dashMenu.ts";

test("search: an attribute's value finds the task, but never outranks a title", () => {
  const items = [
    { title: "Kitchen tap", contexts: [] },
    { title: "Fix the shelf", contexts: [], attrs: { room: "Kitchen", needs_parts: true } },
    { title: "Call Mum", contexts: [], attrs: { client: "[[Mum]]" } },
  ];
  assert.deepEqual(search(items, "kitchen").map((i) => i.title), ["Kitchen tap", "Fix the shelf"]);
  assert.deepEqual(search(items, "true").map((i) => i.title), []); // a yes/no isn't text to find
});

test("resolveDrop: dropping on a value sets it; numbers and dates aren't drop targets", () => {
  const task = { status: "todo" as const, scheduled: null, recurrence: null, contexts: [], flag: null, attrs: { energy: "low" } };
  const attrs = [energy, cost, parts];
  assert.deepEqual(resolveDrop("attrval:energy=high", task, "2026-10-26", 1, [], attrs), { kind: "attr", attr: energy, value: "high" });
  assert.deepEqual(resolveDrop("attrval:energy=low", task, "2026-10-26", 1, [], attrs), { kind: "refuse", reason: "already has Energy" });
  assert.deepEqual(resolveDrop("attrval:needs_parts=yes", task, "2026-10-26", 1, [], attrs), { kind: "attr", attr: parts, value: "yes" });
  assert.equal(resolveDrop("attrval:cost=any", task, "2026-10-26", 1, [], attrs), null);
  assert.equal(resolveDrop("attrval:gone=x", task, "2026-10-26", 1, [], attrs), null);
});

test("saved filters carry the attribute and value", () => {
  const s: DashState = { view: "all", project: null, context: null, attr: { key: "client", value: "mum" }, query: "", groupBy: "attr:energy" };
  assert.equal(matchesFilter(s, s), true);
  assert.equal(matchesFilter({ ...s, attr: { key: "client", value: "dad" } }, s), false);
  assert.equal(matchesFilter({ ...s, attr: null }, s), false);
  assert.equal(suggestFilterName(s, null, null, "Client: Mum"), "All · Client: Mum");
});
