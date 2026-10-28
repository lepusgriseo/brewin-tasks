// The property types the Planner's task notes need, so Obsidian's Properties panel and Bases read
// them right — a date picker for `due`, a number for `estimate`, a list for `contexts` — and a Base can
// compare `due < today()` instead of comparing text. Obsidian holds one type per property name for the
// whole vault (`.obsidian/types.json`), so a type is only ever *added* where none is assigned; the one
// exception is `completed`, which every Planner note (tasks, events, projects) writes as a date and
// which a yes/no type would show wrongly. Pure, no Obsidian imports.

import type { TaskAttribute } from "./attributes";

/** Obsidian's property widget names. */
export type PropertyType = "text" | "multitext" | "number" | "checkbox" | "date" | "datetime";

/** Every property the Planner writes on a task note, and its type. `title`, `up` and `tags` are left to Obsidian. */
export const TASK_PROPERTY_TYPES: Record<string, PropertyType> = {
  status: "text",
  flag: "text",
  scheduled: "date",
  due: "date",
  endDate: "date",
  startTime: "text",
  endTime: "text",
  priority: "text",
  contexts: "multitext",
  estimate: "number",
  created: "date",
  completed: "date",
  modified: "date",
  recurrence: "text",
  recurrence_anchor: "text",
  recurrence_from: "text",
  complete_instances: "multitext",
  recurrence_exdates: "multitext",
  times: "multitext",
  on_completion: "text",
  parent: "text",
  project: "text",
  depends_on: "multitext",
  month: "text",
  week: "text",
  remind: "text",
  remind_start: "checkbox",
  time_log: "multitext",
  time_spent: "number",
  timer_started: "datetime",
  top: "date",
};

/** The type an attribute of the user's own wants. Links are text: Obsidian finds the link inside it. */
export function attributeType(a: Pick<TaskAttribute, "kind">): PropertyType {
  return a.kind === "number" ? "number" : a.kind === "date" ? "date" : a.kind === "bool" ? "checkbox" : "text";
}

/** Assigned types that are replaced when found: they only ever held what the Planner writes. */
const REPLACE: Record<string, { from: string; to: PropertyType }> = {
  completed: { from: "checkbox", to: "date" },
};

export interface TypeChange {
  name: string;
  from: string | null;
  to: PropertyType;
}

export interface TypePlan {
  /** Types to set. */
  changes: TypeChange[];
  /** Names Obsidian already types differently — left alone, and said. */
  conflicts: { name: string; assigned: string; wanted: PropertyType }[];
}

/**
 * What to set, given what Obsidian has assigned (`assigned(name)` → its type, or null for none).
 * Unassigned names get the Planner's type; the one known-wrong assignment is replaced; any other
 * difference is the user's choice and is reported, not overridden.
 */
export function planPropertyTypes(assigned: (name: string) => string | null, attributes: readonly TaskAttribute[] = []): TypePlan {
  const wanted: [string, PropertyType][] = [...Object.entries(TASK_PROPERTY_TYPES), ...attributes.map((a): [string, PropertyType] => [a.key, attributeType(a)])];
  const changes: TypeChange[] = [];
  const conflicts: TypePlan["conflicts"] = [];
  const seen = new Set<string>();
  for (const [name, type] of wanted) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const now = assigned(name);
    if (now == null || now === "") changes.push({ name, from: null, to: type });
    else if (now === type) continue;
    else if (REPLACE[name]?.from === now && REPLACE[name].to === type) changes.push({ name, from: now, to: type });
    else conflicts.push({ name, assigned: now, wanted: type });
  }
  return { changes, conflicts };
}
