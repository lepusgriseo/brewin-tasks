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
}

export interface FitnessBacklog {
  missedSessionsCount: number;
}

export function habitsBacklogFromFrontmatter(fm: Record<string, unknown>): HabitsBacklog {
  return { dueUnmetCount: num(fm.due_unmet_count), backlogDays: num(fm.backlog_days) };
}

export function fitnessBacklogFromFrontmatter(fm: Record<string, unknown>): FitnessBacklog {
  return { missedSessionsCount: num(fm.missed_sessions_count) };
}
