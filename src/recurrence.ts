// Pure recurrence-advance logic. When a recurring occurrence is completed, log it and
// roll the anchored date (scheduled or due) forward to the next occurrence, preserving
// the gap between scheduled and due. No Obsidian imports.

import { addDays, dayDelta, daysBetween, formatISO, parseISO, shiftISO } from "./dates";
import { effectiveStart, nextAfter, parseRRule } from "./rrule";
import { Task } from "./types";

export interface AdvanceResult {
  task: Task;
  /** True when the series has ended and the note should be archived (onCompletion: archive). */
  archive: boolean;
  /** True when the series ended (task marked done). */
  ended: boolean;
}

/**
 * Shared engine behind `completeRecurringOccurrence` and `skipRecurringOccurrence`: advance the
 * anchor (`scheduled`/`due`) past `occurrenceISO`, preserving the scheduled↔due gap, or end the
 * series if there's no next occurrence. Does NOT touch `completeInstances` — the two callers
 * differ only in whether the occurrence counts as done or was simply moved elsewhere.
 */
function advancePast(task: Task, occurrenceISO: string, todayISO: string): AdvanceResult {
  const rule = parseRRule(task.recurrence);
  const next = { ...task };

  if (!rule) {
    // Not actually recurring — treat as a one-off completion.
    next.status = "done";
    next.completed = todayISO;
    return { task: next, archive: task.onCompletion === "archive", ended: true };
  }

  const anchorField = task.recurrenceAnchor;
  const anchorISO = anchorField === "due" ? task.due : task.scheduled;
  const anchorDate = parseISO(anchorISO) ?? parseISO(occurrenceISO)!;
  const fallback = parseISO(todayISO)!;
  const start = effectiveStart(rule, anchorDate, fallback);
  const from = parseISO(occurrenceISO) ?? anchorDate;

  const nextDate = nextAfter(rule, start, from);

  if (!nextDate) {
    next.status = "done";
    next.completed = todayISO;
    return { task: next, archive: task.onCompletion === "archive", ended: true };
  }

  const nextISO = formatISO(nextDate);

  // Preserve the scheduled↔due gap if both exist.
  if (task.scheduled && task.due) {
    const gap = daysBetween(parseISO(task.scheduled)!, parseISO(task.due)!);
    if (anchorField === "due") {
      next.due = nextISO;
      next.scheduled = formatISO(addDays(nextDate, -gap));
    } else {
      next.scheduled = nextISO;
      next.due = formatISO(addDays(nextDate, gap));
    }
  } else if (anchorField === "due") {
    next.due = nextISO;
  } else {
    next.scheduled = nextISO;
  }

  next.status = "todo";
  return { task: next, archive: false, ended: false };
}

/**
 * Complete the occurrence dated `occurrenceISO` (defaults to the task's current anchor
 * date) and advance. Returns a new Task object; caller persists it.
 */
export function completeRecurringOccurrence(task: Task, occurrenceISO: string, todayISO: string): AdvanceResult {
  const completeInstances = task.completeInstances.includes(occurrenceISO)
    ? task.completeInstances
    : [...task.completeInstances, occurrenceISO];
  return advancePast({ ...task, completeInstances }, occurrenceISO, todayISO);
}

/**
 * Advance the anchor past `occurrenceISO` WITHOUT logging it as completed — used when a single
 * occurrence is detached (edited/moved onto its own note) rather than done. Without this, the
 * original note would be left sitting on a date it no longer owns, colliding with the detached
 * note at the same date.
 */
export function skipRecurringOccurrence(task: Task, occurrenceISO: string, todayISO: string): AdvanceResult {
  return advancePast(task, occurrenceISO, todayISO);
}

/**
 * Pure delta-shift: move the whole series by however far `occurrenceISO` moved to `newDateISO`,
 * preserving the scheduled↔due gap — the "shift the whole series" math for an "all scope" edit
 * or drag, correct regardless of whether the grabbed occurrence was the current anchor or a
 * future virtual one (mirrors `EventStore.applyRecurringEdit`'s "all" branch for events).
 */
export function shiftAnchor(task: Task, occurrenceISO: string, newDateISO: string): { scheduled: string | null; due: string | null } {
  const delta = dayDelta(occurrenceISO, newDateISO);
  return {
    scheduled: task.scheduled ? shiftISO(task.scheduled, delta) : null,
    due: task.due ? shiftISO(task.due, delta) : null,
  };
}

/**
 * The occurrence date a recurring task is currently "on" — its anchored date, or the
 * first occurrence on/after today if the anchor is in the past and already completed.
 */
export function currentOccurrenceISO(task: Task): string | null {
  return task.recurrenceAnchor === "due" ? task.due : task.scheduled;
}
