// A starter Base of the Planner's tasks — the command "Create a Base of your tasks" writes it — so
// views of one's own can be made in Obsidian's Bases from a working start rather than a blank file.
// Built from the settings: the task folders, and the user's attributes as columns. Each view is an
// ordinary Bases view, to change or copy in Bases itself. Pure, no Obsidian imports.

import type { TaskAttribute } from "./attributes";

/** A Bases expression as a YAML string, quoted so `!`, `:` and `"` inside it stay text. */
const q = (expr: string) => `'${expr.replace(/'/g, "''")}'`;

/** A property name Bases can take as it stands (`cost`); one with spaces or symbols is left out. */
const plainName = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);

export function tasksBaseYaml(o: { itemsFolder: string; routinesFolder: string; attributes: readonly TaskAttribute[] }): string {
  const attrCols = o.attributes.filter((a) => plainName(a.key)).map((a) => a.key);
  const L: string[] = [];
  const list = (indent: string, items: string[]) => items.forEach((i) => L.push(`${indent}- ${i}`));

  L.push("# Brewin Planner's tasks, as a Base. Change, copy or add views here; the notes are the tasks.");
  L.push("filters:", "  and:", `    - ${q("file.hasTag(\"task\")")}`, "    - or:");
  list("        ", [q(`file.inFolder("${o.itemsFolder}")`), q(`file.inFolder("${o.routinesFolder}")`)]);
  L.push("formulas:");
  L.push(`  overdue: ${q('if(status != "done" && due && due < today(), "⚠️ overdue", "")')}`);
  // Priority is text, so sorting by it puts "low" before "normal"; this ranks it.
  L.push(`  rank: ${q('if(priority == "high", 1, if(priority == "low", 3, 2))')}`);
  L.push("properties:");
  // Note properties by their bare names, as Obsidian itself saves a Base.
  const names: [string, string][] = [
    ["status", "Status"], ["flag", "Own status"], ["scheduled", "Scheduled"], ["due", "Due"],
    ["priority", "Priority"], ["contexts", "Contexts"], ["project", "Project"],
    ["estimate", "Estimate (min)"], ["time_spent", "Focused (min)"], ["completed", "Completed"],
    ["formula.overdue", "Overdue"], ["formula.rank", "Priority rank"],
    ...o.attributes.filter((a) => plainName(a.key)).map((a): [string, string] => [a.key, a.label]),
  ];
  for (const [k, label] of names) L.push(`  ${k}:`, `    displayName: ${JSON.stringify(label)}`);

  const view = (v: { type: string; name: string; filters?: string[]; anyOf?: string[]; order: string[]; sort?: [string, "ASC" | "DESC"][]; groupBy?: string; summaries?: Record<string, string> }) => {
    L.push(`  - type: ${v.type}`, `    name: ${JSON.stringify(v.name)}`);
    if (v.filters?.length || v.anyOf?.length) {
      L.push("    filters:", "      and:");
      list("        ", (v.filters ?? []).map(q));
      if (v.anyOf?.length) {
        L.push("        - or:");
        list("            ", v.anyOf.map(q));
      }
    }
    if (v.groupBy) L.push("    groupBy:", `      property: ${v.groupBy}`, "      direction: ASC");
    L.push("    order:");
    list("      ", v.order);
    if (v.sort?.length) {
      L.push("    sort:");
      for (const [p, d] of v.sort) L.push(`      - property: ${p}`, `        direction: ${d}`);
    }
    if (v.summaries) {
      L.push("    summaries:");
      for (const [p, s] of Object.entries(v.summaries)) L.push(`      ${p}: ${s}`);
    }
  };

  L.push("views:");
  view({
    type: "table",
    name: "Open",
    filters: ['status != "done"'],
    order: ["file.name", "status", "flag", "scheduled", "due", "formula.overdue", "priority", "contexts", "project", "estimate", ...attrCols],
    sort: [["scheduled", "ASC"], ["due", "ASC"]],
  });
  view({
    type: "table",
    name: "Today",
    filters: ['status == "todo"'],
    anyOf: ["scheduled <= today()", "due <= today()"],
    order: ["file.name", "scheduled", "due", "formula.overdue", "priority", "contexts", ...attrCols],
    sort: [["formula.rank", "ASC"], ["due", "ASC"]],
  });
  view({
    type: "table",
    name: "By status",
    filters: ['status != "done"'],
    groupBy: "status",
    order: ["file.name", "flag", "scheduled", "due", "priority", "contexts"],
    sort: [["scheduled", "ASC"]],
  });
  view({
    type: "cards",
    name: "Cards",
    filters: ['status != "done"'],
    groupBy: "status",
    order: ["file.name", "scheduled", "due", "contexts", ...attrCols],
  });
  view({
    type: "table",
    name: "Done this week",
    filters: ['status == "done"', 'completed >= today() - "7d"'],
    order: ["file.name", "completed", "contexts", "project", "time_spent"],
    sort: [["completed", "DESC"]],
  });
  view({
    type: "table",
    name: "Time focused",
    filters: ["time_spent > 0"],
    order: ["file.name", "status", "time_spent", "estimate", "project"],
    sort: [["time_spent", "DESC"]],
    summaries: { time_spent: "Sum", estimate: "Sum" },
  });
  return L.join("\n") + "\n";
}
