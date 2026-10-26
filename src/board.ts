// Boards for the dashboard's views: a view's tasks in columns by one field — status (with the
// user's own statuses), context, priority, project, or one of the user's attributes — and what
// dropping a card into another column means. The Week view's board by day stays in the view itself.
// Pure, no Obsidian imports.

import { attrMenuValues, filterValue, TaskAttribute } from "./attributes";
import { hasContext } from "./contexts";
import { StatusFlag, flagRefusal } from "./statusFlags";
import { Priority, Status, Task } from "./types";

/** What a board's columns are. `attr:<key>` is one of the user's attributes. */
export type BoardField = "status" | "context" | "priority" | "project" | "day" | `attr:${string}`;

export interface BoardColumn {
  /** `status:todo`, `flag:waiting`, `context:home`, `context:` (none), `priority:high`, `project:<path>`, `attrval:<value>`. */
  key: string;
  label: string;
  icon: string;
  tasks: Task[];
}

export interface BoardContext {
  flags: readonly StatusFlag[];
  attributes: readonly TaskAttribute[];
  /** Projects to offer as columns (active ones, in the menu's order). */
  projects: readonly { path: string; name: string }[];
}

const STATUS: { id: Status; label: string; icon: string }[] = [
  { id: "todo", label: "To do", icon: "☐" },
  { id: "hold", label: "On hold", icon: "⏸" },
  { id: "someday", label: "Someday", icon: "💭" },
  { id: "done", label: "Done", icon: "✓" },
];
const PRIORITY: { id: Priority; label: string; icon: string }[] = [
  { id: "high", label: "High", icon: "🔴" },
  { id: "normal", label: "Normal", icon: "⚪" },
  { id: "low", label: "Low", icon: "🔵" },
];

/**
 * The fields a board can use, for the "Columns" picker. Number and date attributes are left out —
 * every value differs, so each card would get a column of its own. `day` is the Week view's.
 */
export function boardFields(attributes: readonly TaskAttribute[], withDay: boolean): { field: BoardField; label: string }[] {
  return [
    ...(withDay ? [{ field: "day" as BoardField, label: "Day" }] : []),
    { field: "status", label: "Status" },
    { field: "context", label: "Context" },
    { field: "priority", label: "Priority" },
    { field: "project", label: "Project" },
    ...attributes.filter((a) => a.kind !== "number" && a.kind !== "date").map((a) => ({ field: `attr:${a.key}` as BoardField, label: a.label })),
  ];
}

const projectName = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");

/** The columns for a field, every one present even when empty — an empty column is somewhere to drop. */
export function boardColumns(field: BoardField, tasks: readonly Task[], ctx: BoardContext): BoardColumn[] {
  if (field === "status") {
    const cols: BoardColumn[] = [];
    for (const s of STATUS) {
      cols.push({ key: `status:${s.id}`, label: s.label, icon: s.icon, tasks: tasks.filter((t) => t.status === s.id && !t.flag) });
      for (const f of ctx.flags.filter((x) => x.base === s.id)) {
        cols.push({ key: `flag:${f.id}`, label: f.label, icon: f.icon, tasks: tasks.filter((t) => t.flag?.id === f.id) });
      }
    }
    return cols;
  }
  if (field === "priority") {
    return PRIORITY.map((p) => ({ key: `priority:${p.id}`, label: p.label, icon: p.icon, tasks: tasks.filter((t) => t.priority === p.id) }));
  }
  if (field === "context") {
    // Contexts merge without regard to case, spelt as first seen; the busiest first.
    const seen = new Map<string, { label: string; tasks: Task[] }>();
    const none: Task[] = [];
    for (const t of tasks) {
      if (!t.contexts.length) none.push(t);
      for (const c of t.contexts) {
        const k = c.toLowerCase();
        const e = seen.get(k) ?? { label: c, tasks: [] };
        if (!e.tasks.includes(t)) e.tasks.push(t);
        seen.set(k, e);
      }
    }
    const cols = [...seen.values()]
      .sort((a, b) => b.tasks.length - a.tasks.length || a.label.localeCompare(b.label))
      .map((e) => ({ key: `context:${e.label}`, label: `@${e.label}`, icon: "＠", tasks: e.tasks }));
    return [...cols, { key: "context:", label: "No context", icon: "∅", tasks: none }];
  }
  if (field === "project") {
    const known = new Map(ctx.projects.map((p) => [p.path, p.name]));
    for (const t of tasks) if (t.projectPath && !known.has(t.projectPath)) known.set(t.projectPath, projectName(t.projectPath));
    const cols = [...known].map(([path, name]) => ({ key: `project:${path}`, label: name, icon: "⚡", tasks: tasks.filter((t) => t.projectPath === path) }));
    return [...cols, { key: "project:", label: "No project", icon: "∅", tasks: tasks.filter((t) => !t.projectPath) }];
  }
  if (field.startsWith("attr:")) {
    const attr = ctx.attributes.find((a) => a.key === field.slice(5));
    if (!attr) return [];
    const valueOf = (t: Task) => {
      const v = t.attrs?.[attr.key];
      return v === undefined ? null : filterValue(attr, v);
    };
    if (attr.kind === "bool") {
      return [
        { key: "attrval:yes", label: attr.label, icon: attr.icon, tasks: tasks.filter((t) => valueOf(t) === "yes") },
        { key: "attrval:", label: `Not ${attr.label.toLowerCase()}`, icon: "∅", tasks: tasks.filter((t) => valueOf(t) !== "yes") },
      ];
    }
    // Choices in their own order, even unused ones; text and links as they occur.
    const values = attrMenuValues(attr, tasks.map((t) => ({ ...t, status: "todo" })));
    const order: { value: string; label: string }[] =
      attr.kind === "choice"
        ? [
            ...(attr.options ?? []).map((o) => ({ value: o.toLowerCase(), label: o })),
            ...values.filter((v) => !(attr.options ?? []).some((o) => o.toLowerCase() === v.value)),
          ]
        : values;
    const cols = order.map((v) => ({ key: `attrval:${v.value}`, label: v.label, icon: attr.icon, tasks: tasks.filter((t) => valueOf(t) === v.value) }));
    return [...cols, { key: "attrval:", label: `No ${attr.label.toLowerCase()}`, icon: "∅", tasks: tasks.filter((t) => valueOf(t) === null) }];
  }
  return [];
}

/** What dropping a card into a column does. The caller carries it out with the store. */
export type BoardDrop =
  | { kind: "none" }
  | { kind: "refuse"; reason: string }
  | { kind: "status"; status: Status }
  | { kind: "flag"; flag: StatusFlag }
  | { kind: "priority"; priority: Priority }
  | { kind: "contexts"; contexts: string[] }
  | { kind: "project"; path: string | null }
  /** `value` as the menu has it (lower case; "yes" for a tick), or null to clear the attribute. */
  | { kind: "attr"; attr: TaskAttribute; value: string | null };

export function boardDrop(field: BoardField, task: Task, fromKey: string | null, toKey: string, ctx: BoardContext): BoardDrop {
  if (fromKey === toKey) return { kind: "none" };
  const [kind, ...rest] = toKey.split(":");
  const to = rest.join(":");

  if (field === "status") {
    if (kind === "flag") {
      const flag = ctx.flags.find((f) => f.id === to);
      if (!flag) return { kind: "none" };
      const reason = flagRefusal(task, flag);
      return reason ? { kind: "refuse", reason } : { kind: "flag", flag };
    }
    const status = to as Status;
    if (!STATUS.some((s) => s.id === status)) return { kind: "none" };
    if (task.status === status && !task.flag) return { kind: "none" };
    if (task.recurrence && status === "someday") return { kind: "refuse", reason: "repeats on its own schedule" };
    return { kind: "status", status };
  }
  if (field === "priority") {
    const priority = to as Priority;
    return task.priority === priority || !PRIORITY.some((p) => p.id === priority) ? { kind: "none" } : { kind: "priority", priority };
  }
  if (field === "context") {
    // Moving between context columns swaps the one context for the other; others are kept.
    const from = fromKey?.startsWith("context:") ? fromKey.slice("context:".length) : "";
    let contexts = from ? task.contexts.filter((c) => c.toLowerCase() !== from.toLowerCase()) : [...task.contexts];
    if (to && !hasContext(contexts, to)) contexts = [...contexts, to];
    if (!to && !from) return { kind: "none" };
    return { kind: "contexts", contexts };
  }
  if (field === "project") {
    const path = to || null;
    return (task.projectPath ?? null) === path ? { kind: "none" } : { kind: "project", path };
  }
  if (field.startsWith("attr:")) {
    const attr = ctx.attributes.find((a) => a.key === field.slice(5));
    if (!attr) return { kind: "none" };
    return { kind: "attr", attr, value: to || null };
  }
  return { kind: "none" };
}
