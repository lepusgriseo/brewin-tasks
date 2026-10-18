// Pure frontmatter → typed-shape parsing for the sibling plugins' shared backlog notes. No
// Obsidian imports → unit-testable. Defensive throughout: a missing, partial, or malformed note
// (sibling plugin not installed, disabled, or hasn't written yet) reads as all-zero, never throws.

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

export interface HabitsBacklog {
  dueUnmetCount: number;
  backlogDays: number;
  /** How many habits are behind — Brewin Habits' own backlog figure (each habit with a missed
   *  due-day in its window, once; today excluded). What the digest reports. */
  habitsBehind: number;
}

export interface FitnessBacklog {
  missedSessionsCount: number;
}

export function habitsBacklogFromFrontmatter(fm: Record<string, unknown>): HabitsBacklog {
  const dueUnmetCount = num(fm.due_unmet_count);
  const backlogDays = num(fm.backlog_days);
  // Brewin Habits ≥1.4 writes `habits_behind`. An older one doesn't, so fall back to the sum it
  // used to imply — that overcounted (today's not-yet-done habits, every missed day separately),
  // which is why the newer field exists.
  const habitsBehind = fm.habits_behind === undefined || fm.habits_behind === null ? dueUnmetCount + backlogDays : num(fm.habits_behind);
  return { dueUnmetCount, backlogDays, habitsBehind };
}

export function fitnessBacklogFromFrontmatter(fm: Record<string, unknown>): FitnessBacklog {
  return { missedSessionsCount: num(fm.missed_sessions_count) };
}
