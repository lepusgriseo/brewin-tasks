// Pure task <-> frontmatter mapping. No Obsidian imports so it is unit-testable.
// The store layer (taskStore.ts) reads/writes files and calls these helpers.

import { coerceISO } from "./dates";
import { formatSlot, parseSlots } from "./slots";
import { parseEstimate } from "./estimate";
import { parseRemindStart } from "./reminders";
import { OnCompletion, Priority, RecurrenceAnchor, Status, Task } from "./types";

export const TASK_TAG = "task";

function asStatus(v: unknown): Status {
  const s = String(v ?? "todo").toLowerCase();
  return s === "hold" || s === "done" ? (s as Status) : "todo";
}

function asPriority(v: unknown): Priority {
  const s = String(v ?? "normal").toLowerCase();
  return s === "low" || s === "high" ? (s as Priority) : "normal";
}

function asAnchor(v: unknown): RecurrenceAnchor {
  return String(v ?? "scheduled").toLowerCase() === "due" ? "due" : "scheduled";
}

function asOnCompletion(v: unknown): OnCompletion {
  return String(v ?? "keep").toLowerCase() === "archive" ? "archive" : "keep";
}

/** Normalise a time value to "HH:MM", or null when absent/unparseable. */
function asHM(v: unknown): string | null {
  if (v == null || v === "") return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function asStringList(v: unknown): string[] {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x.trim() !== "");
  return [String(v)];
}

function asISOList(v: unknown): string[] {
  return asStringList(v).map((x) => coerceISO(x)).filter((x): x is string => !!x);
}

/**
 * Read the `complete_slots:` map. Keys must be real dates and values lists of times —
 * anything else is dropped rather than becoming a phantom day.
 */
function asSlotLog(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const day = coerceISO(k);
    if (!day) continue;
    const times = asStringList(val);
    if (times.length) out[day] = times;
  }
  return out;
}

/** True if the metadata cache tags for a note mark it as a Brewin task. */
export function hasTaskTag(tags: string[] | undefined): boolean {
  if (!tags) return false;
  return tags.some((t) => t.replace(/^#/, "") === TASK_TAG);
}

/** Build a Task from a raw frontmatter record. `title` defaults to the note basename. */
export function taskFromFrontmatter(fm: Record<string, unknown>, path: string, basename: string): Task {
  const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : basename;
  return {
    path,
    title,
    status: asStatus(fm.status),
    scheduled: coerceISO(fm.scheduled),
    endDate: coerceISO(fm.endDate),
    startTime: asHM(fm.startTime),
    endTime: asHM(fm.endTime),
    due: coerceISO(fm.due),
    priority: asPriority(fm.priority),
    estimate: parseEstimate(fm.estimate),
    remind: fm.remind == null || fm.remind === "" ? null : String(fm.remind).trim(),
    remindStart: parseRemindStart(fm.remind_start),
    contexts: asStringList(fm.contexts),
    recurrence: fm.recurrence ? String(fm.recurrence) : null,
    recurrenceAnchor: asAnchor(fm.recurrence_anchor),
    completeInstances: asISOList(fm.complete_instances),
    exdates: asISOList(fm.recurrence_exdates),
    times: parseSlots(fm.times),
    completeSlots: asSlotLog(fm.complete_slots),
    onCompletion: asOnCompletion(fm.on_completion),
    created: coerceISO(fm.created),
    completed: coerceISO(fm.completed),
    parent: fm.parent ? String(fm.parent).trim() || null : null,
    parentPath: null, // resolved by the store (needs the metadata cache)
    dependsOn: asStringList(fm.depends_on),
    dependsOnPaths: [], // resolved by the store (needs the metadata cache)
    month: fm.month ? String(fm.month).trim() || null : null,
    week: fm.week ? String(fm.week).trim() || null : null,
  };
}

/** Extract the link target from a stored parent value (`"[[Ship v2|alias]]"` → `Ship v2`). */
export function parentLinkpath(parent: string | null): string | null {
  if (!parent) return null;
  const m = /^\[\[([^\]|#]+)/.exec(parent.trim());
  const raw = m ? m[1] : parent.trim();
  return raw.trim() || null;
}

/** Wrap a note basename as a wikilink for writing into frontmatter. */
export function toWikilink(basename: string): string {
  return `[[${basename}]]`;
}

/**
 * Turn a task title into a safe note filename (without extension). Strips characters
 * Obsidian/filesystems reject and collapses whitespace; returns "" when nothing usable
 * is left, so callers can decide on a fallback.
 */
export function sanitizeFilename(title: string): string {
  return title
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mutate a frontmatter record in place to reflect a Task (used inside processFrontMatter). */
export function applyTaskToFrontmatter(fm: Record<string, unknown>, task: Task): void {
  const tags = asStringList(fm.tags);
  if (!tags.map((t) => t.replace(/^#/, "")).includes(TASK_TAG)) tags.push(TASK_TAG);
  fm.tags = tags;

  fm.status = task.status;
  fm.scheduled = task.scheduled ?? "";
  if (task.endDate) fm.endDate = task.endDate;
  else delete fm.endDate;
  if (task.startTime) fm.startTime = task.startTime;
  else delete fm.startTime;
  if (task.endTime) fm.endTime = task.endTime;
  else delete fm.endTime;
  fm.due = task.due ?? "";
  fm.priority = task.priority;
  if (task.estimate) fm.estimate = task.estimate;
  else delete fm.estimate;
  if (task.remind) fm.remind = task.remind;
  else delete fm.remind;
  if (task.remindStart != null) fm.remind_start = task.remindStart;
  else delete fm.remind_start;
  fm.contexts = task.contexts;
  if (task.recurrence) {
    fm.recurrence = task.recurrence;
    fm.recurrence_anchor = task.recurrenceAnchor;
    fm.complete_instances = task.completeInstances;
    fm.on_completion = task.onCompletion;
    if (task.exdates?.length) fm.recurrence_exdates = task.exdates;
    else delete fm.recurrence_exdates;
  }
  // Multi-slot repeats. Both keys are dropped when empty so ordinary tasks stay clean.
  if (task.times?.length) fm.times = task.times.map(formatSlot);
  else delete fm.times;
  if (Object.keys(task.completeSlots ?? {}).length) fm.complete_slots = task.completeSlots;
  else delete fm.complete_slots;
  if (task.completed) fm.completed = task.completed;

  if (task.parent) fm.parent = task.parent;
  else delete fm.parent;

  if (task.dependsOn?.length) fm.depends_on = task.dependsOn;
  else delete fm.depends_on;

  if (task.month) fm.month = task.month;
  else delete fm.month;

  if (task.week) fm.week = task.week;
  else delete fm.week;
}

export function isRecurring(task: Task): boolean {
  return !!task.recurrence;
}

// ── Multi-day tasks ──────────────────────────────────────────────────────────

/**
 * The last day a task occupies. `endDate` is **inclusive**, and is ignored when it's
 * earlier than the start — a backwards range is a typo, not a zero-day task.
 */
export function taskLastDay(task: Task): string | null {
  const start = task.scheduled;
  if (!start) return null;
  return task.endDate && task.endDate > start ? task.endDate : start;
}

/** Does the task occupy `dateISO`? True for any day in an inclusive span. */
export function taskCoversDay(task: Task, dateISO: string): boolean {
  const start = task.scheduled;
  if (!start) return false;
  const end = taskLastDay(task)!;
  return dateISO >= start && dateISO <= end;
}

/** How many days the task spans (1 for an ordinary single-day task). */
export function taskSpanDays(task: Task): number {
  const start = task.scheduled;
  if (!start) return 0;
  const end = taskLastDay(task)!;
  return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000) + 1;
}

/** 1-based position of `dateISO` within the span, or 0 when the task doesn't cover it. */
export function taskDayIndex(task: Task, dateISO: string): number {
  if (!taskCoversDay(task, dateISO)) return 0;
  return Math.round((Date.parse(dateISO + "T00:00:00Z") - Date.parse(task.scheduled! + "T00:00:00Z")) / 86400000) + 1;
}
