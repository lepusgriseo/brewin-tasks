// The dashboard's menu pane: which entries it lists and in what order, what each one counts, the
// saved filters, and what dropping a task on an entry does. No Obsidian imports → unit-testable.

import { attentionTasks, DASH_VIEWS, DashView, inboxTasks, todayAgenda, weekAgenda } from "./views";
import { isOpen, nextWeekStart } from "./status";
import { hasContext } from "./contexts";
import { shiftISO } from "./dates";
import { Task } from "./types";

/** The menu's groups, top to bottom. Each can be folded, or hidden from the menu altogether. */
export type MenuSection = "progress" | "projects" | "contexts" | "filters" | "links";

/**
 * Entries are addressed by key so one hidden-list covers every kind: `view:today`,
 * `section:links`, `project:<vault path>`, `context:<lower-case name>`.
 */
export const viewKey = (id: DashView): string => `view:${id}`;
export const sectionKey = (id: MenuSection): string => `section:${id}`;
export const projectKey = (path: string): string => `project:${path}`;
export const contextKey = (value: string): string => `context:${value.toLowerCase()}`;

/**
 * The views in the user's order. A saved order may predate a view (or name one that has since
 * gone), so unknown ids are dropped and any view it doesn't mention keeps its default place at
 * the end — a new view is never silently lost from the menu.
 */
export function orderedViews(saved: readonly string[]): DashView[] {
  const known = new Set<string>(DASH_VIEWS.map((v) => v.id));
  const out: DashView[] = [];
  for (const id of saved) if (known.has(id) && !out.includes(id as DashView)) out.push(id as DashView);
  for (const v of DASH_VIEWS) if (!out.includes(v.id)) out.push(v.id);
  return out;
}

/** Move one view up (-1) or down (+1) a place. A move off either end changes nothing. */
export function moveView(saved: readonly string[], id: DashView, delta: -1 | 1): DashView[] {
  const order = orderedViews(saved);
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return order;
  [order[i], order[j]] = [order[j], order[i]];
  return order;
}

/** Hide an entry, or show it again. */
export function toggleHidden(hidden: readonly string[], key: string): string[] {
  return hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
}

/**
 * May this view be hidden? Not if it is the last one showing — a menu with no views left would
 * have no way back to the task list.
 */
export function canHideView(hidden: readonly string[], id: DashView): boolean {
  if (hidden.includes(viewKey(id))) return true; // showing it again is always fine
  return DASH_VIEWS.filter((v) => v.id !== id && !hidden.includes(viewKey(v.id))).length > 0;
}

/**
 * The number beside each view: what is still to do there. Review has none — it is a page to
 * read, not a list to clear. Projects and Birthdays are counted by the caller, which has the
 * project and people notes.
 */
export function viewCounts(tasks: Task[], today: string): Record<DashView, number | null> {
  const att = attentionTasks(tasks, today);
  return {
    today: todayAgenda(tasks, [], today).openCount,
    week: weekAgenda(tasks, today, 7).reduce((n, d) => n + d.tasks.length, 0),
    inbox: inboxTasks(tasks).length,
    projects: null,
    attention: att.overdue.length + att.slipped.length,
    review: null,
    all: tasks.filter(isOpen).length,
    birthdays: null,
  };
}

/** Today's plan, as done out of planned — the same figures as Today's own "N left · M done". */
export function todayProgress(tasks: Task[], today: string): { done: number; total: number } {
  const a = todayAgenda(tasks, [], today);
  return { done: a.doneCount, total: a.doneCount + a.openCount };
}

/** Open task notes per project note path. Inline checkboxes are counted by the caller. */
export function linkedTaskCounts(tasks: Pick<Task, "status" | "projectPath">[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tasks) {
    if (!t.projectPath || !isOpen(t)) continue;
    out.set(t.projectPath, (out.get(t.projectPath) ?? 0) + 1);
  }
  return out;
}

// ── Saved filters ─────────────────────────────────────────────────────────────

/** What the dashboard is showing: a view (or one project) narrowed by a context and a search. */
export interface DashState {
  view: DashView;
  /** Vault path of the project note being shown on its own, or null. */
  project: string | null;
  context: string | null;
  query: string;
  groupBy: "date" | "context";
}

/** A dashboard state kept under a name, to come back to in one tap. */
export interface SavedFilter extends DashState {
  id: string;
  name: string;
}

/**
 * Does the dashboard currently show exactly this saved filter? Grouping only exists in All, so
 * it only counts there; a search differing by case or surrounding spaces is the same search.
 */
export function matchesFilter(f: DashState, s: DashState): boolean {
  if (f.view !== s.view || (f.project ?? null) !== (s.project ?? null)) return false;
  if ((f.context ?? "").toLowerCase() !== (s.context ?? "").toLowerCase()) return false;
  if (f.query.trim().toLowerCase() !== s.query.trim().toLowerCase()) return false;
  if (!s.project && s.view === "all" && f.groupBy !== s.groupBy) return false;
  return true;
}

/** A name to offer when saving: the view (or project), then the context and the search. */
export function suggestFilterName(s: DashState, projectName: string | null): string {
  const base = s.project ? projectName ?? "Project" : DASH_VIEWS.find((v) => v.id === s.view)?.label ?? s.view;
  const parts = [base];
  if (s.context) parts.push(`@${s.context}`);
  if (s.query.trim()) parts.push(`“${s.query.trim()}”`);
  if (!s.project && s.view === "all" && s.groupBy === "context") parts.push("by context");
  return parts.join(" · ");
}

/** A fresh id, unique among `existing`. `now` is passed in so tests are deterministic. */
export function newFilterId(existing: readonly SavedFilter[], now: number): string {
  let n = now;
  let id = `f${n.toString(36)}`;
  while (existing.some((f) => f.id === id)) id = `f${(++n).toString(36)}`;
  return id;
}

// ── Dropping a task on the menu ───────────────────────────────────────────────

/**
 * Drop targets beyond the views themselves. They only appear while a task is being dragged,
 * so they cost no room the rest of the time.
 */
export const DROP_ONLY: { key: string; label: string; icon: string }[] = [
  { key: "drop:tomorrow", label: "Tomorrow", icon: "☀️" },
  { key: "drop:nextweek", label: "Next week", icon: "⏭" },
  { key: "drop:someday", label: "Someday", icon: "💭" },
];

export type DropAction =
  | { kind: "schedule"; iso: string }
  | { kind: "inbox" }
  | { kind: "someday" }
  | { kind: "context"; value: string }
  | { kind: "project"; path: string }
  | { kind: "refuse"; reason: string };

type DropTask = Pick<Task, "status" | "scheduled" | "recurrence" | "contexts"> & { projectPath?: string | null };

/**
 * What a task dropped on a menu entry should become. `null` means the entry is not a drop
 * target at all; `refuse` means it is, but this task can't go there (and says why).
 *
 * A recurring task's dates belong to its rule, so the date targets refuse it — the same reason
 * the week board won't let one be dragged. Giving it a context or a project is fine.
 */
export function resolveDrop(key: string, task: DropTask, today: string, firstDayOfWeek: number): DropAction | null {
  const dated = (iso: string): DropAction => {
    if (task.recurrence) return { kind: "refuse", reason: "repeats on its own schedule" };
    if (task.scheduled === iso && task.status === "todo") return { kind: "refuse", reason: "is already scheduled then" };
    return { kind: "schedule", iso };
  };
  if (key === "view:today") return dated(today);
  if (key === "drop:tomorrow") return dated(shiftISO(today, 1) ?? today);
  if (key === "drop:nextweek") return dated(nextWeekStart(today, firstDayOfWeek));
  if (key === "view:inbox") {
    if (task.recurrence) return { kind: "refuse", reason: "repeats on its own schedule" };
    if (!task.scheduled && task.status === "todo") return { kind: "refuse", reason: "has no date already" };
    return { kind: "inbox" };
  }
  if (key === "drop:someday") {
    if (task.recurrence) return { kind: "refuse", reason: "repeats on its own schedule" };
    if (task.status === "someday") return { kind: "refuse", reason: "is already in Someday" };
    return { kind: "someday" };
  }
  if (key.startsWith("context:")) {
    const value = key.slice("context:".length);
    if (!value) return null;
    if (hasContext(task.contexts, value)) return { kind: "refuse", reason: `is already @${value}` };
    return { kind: "context", value };
  }
  if (key.startsWith("project:")) {
    const path = key.slice("project:".length);
    if (!path) return null;
    if (task.projectPath === path) return { kind: "refuse", reason: "is already in that project" };
    return { kind: "project", path };
  }
  return null;
}
