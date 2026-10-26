// Status flags: statuses of the user's own ("In progress", "Waiting on a reply", "Cancelled"),
// added in settings. Each flag stands for one of the four built-in statuses and behaves exactly
// like it — where the task is listed, whether it counts, what the reviews and the shared backlog
// make of it. So a flag never needs a rule of its own anywhere else in the Planner.
//
// On disk the built-in status stays in `status:` and the flag goes in its own `flag:` field, so
// every Dataview query, plugin and fallback note that reads `status: todo` keeps working. A flag
// shows only while the task's status is still the one the flag stands for: completing an
// "In progress" task, or dropping a "Waiting" one on Today, clears it.
// Pure, no Obsidian imports.

import { Status } from "./types";

export interface StatusFlag {
  /** What `flag:` holds — fixed when the flag is made, so renaming it later loses no tasks. */
  id: string;
  label: string;
  /** An emoji or a short symbol, shown on the task row and in the menu. */
  icon: string;
  /** The built-in status it stands for. */
  base: Status;
}

/** The built-in statuses, as the settings explain them. */
export const BUILTIN_STATUSES: { id: Status; label: string; icon: string; meaning: string }[] = [
  { id: "todo", label: "To do", icon: "☐", meaning: "listed by date in Today, Week and the inbox; counts towards everything" },
  { id: "hold", label: "On hold", icon: "⏸", meaning: "kept under On hold; not planned or counted until it is taken off hold" },
  { id: "someday", label: "Someday", icon: "💭", meaning: "undated and never nagged about; its own list" },
  { id: "done", label: "Done", icon: "✓", meaning: "finished: given a completed date, counted as done, and filed away later" },
];

/** One tap to add in settings — the flags most task managers grow first. */
export const FLAG_SUGGESTIONS: StatusFlag[] = [
  { id: "in-progress", label: "In progress", icon: "▶️", base: "todo" },
  { id: "waiting", label: "Waiting on someone", icon: "⏳", base: "hold" },
  { id: "blocked", label: "Blocked", icon: "🚧", base: "hold" },
  { id: "cancelled", label: "Cancelled", icon: "✖️", base: "done" },
];

const BASES: Status[] = ["todo", "hold", "someday", "done"];

/** "Waiting on a reply" → "waiting-on-a-reply": lower case, letters, digits and dashes. */
export function flagId(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * An id for a new flag: from its label, never one of the built-in statuses (a flag called
 * "done" would read as the real thing), and never one another flag already has.
 */
export function uniqueFlagId(label: string, existing: readonly StatusFlag[]): string {
  const base = flagId(label) || "flag";
  const taken = new Set<string>([...BASES, ...existing.map((f) => f.id)]);
  let id = taken.has(base) ? `${base}-2` : base;
  for (let n = 3; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Saved flags, as settings hold them — anything malformed dropped, repeated ids kept once. */
export function sanitizeFlags(raw: unknown): StatusFlag[] {
  if (!Array.isArray(raw)) return [];
  const out: StatusFlag[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = flagId(String(o.id ?? ""));
    if (!id || BASES.includes(id as Status) || out.some((f) => f.id === id)) continue;
    const base = BASES.includes(o.base as Status) ? (o.base as Status) : "todo";
    out.push({ id, label: String(o.label ?? "").trim() || id, icon: String(o.icon ?? "").trim() || "🏷", base });
  }
  return out;
}

/** The flag a `flag:` value names, matched without regard to case. */
export function findFlag(flags: readonly StatusFlag[], value: unknown): StatusFlag | null {
  if (value == null || value === "") return null;
  const id = flagId(String(value));
  return flags.find((f) => f.id === id) ?? null;
}

/** The flag a task shows: the one `flag:` names, while its status is still the flag's own. */
export function flagFor(flags: readonly StatusFlag[], value: unknown, status: Status): StatusFlag | null {
  const f = findFlag(flags, value);
  return f && f.base === status ? f : null;
}

/** What `flag:` should hold after a write: the flag while it still matches the status, else nothing. */
export function flagToWrite(flag: StatusFlag | null | undefined, status: Status): string | null {
  return flag && flag.base === status ? flag.id : null;
}

/**
 * How many tasks carry each flag, for the menu. Flags standing for Done count nothing — their
 * tasks are finished, and the number would only ever grow.
 */
export function flagCounts(tasks: { flag?: StatusFlag | null }[], flags: readonly StatusFlag[]): Map<string, number | null> {
  const out = new Map<string, number | null>(flags.map((f) => [f.id, f.base === "done" ? null : 0]));
  for (const t of tasks) {
    const id = t.flag?.id;
    if (!id) continue;
    const n = out.get(id);
    if (typeof n === "number") out.set(id, n + 1);
  }
  return out;
}

/** Move one flag up (-1) or down (+1) a place; a move off either end changes nothing. */
export function moveFlag(flags: readonly StatusFlag[], id: string, delta: -1 | 1): StatusFlag[] {
  const out = [...flags];
  const i = out.findIndex((f) => f.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** "▶️ In progress" — how a flag is shown wherever there's room for its name. */
export const flagText = (f: StatusFlag): string => `${f.icon} ${f.label}`;

/**
 * Why a task can't take a flag, or null when it can. A repeating task's dates belong to its rule,
 * so it can't be made Someday or Done by a flag — the same reason it can't be dropped on Someday.
 * Open subtasks are the store's to check, as they are for ticking a task done.
 */
export function flagRefusal(task: { recurrence: string | null; flag?: StatusFlag | null }, flag: StatusFlag): string | null {
  if (task.flag?.id === flag.id) return `is already ${flag.label}`;
  if (task.recurrence && (flag.base === "someday" || flag.base === "done")) return "repeats on its own schedule";
  return null;
}
