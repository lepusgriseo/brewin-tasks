// Goals over projects: each goal note (tagged `goal`, with `status`, `area`, `period` and
// `target_date`) with the projects that name it in `goal:`, how far along each is, and the time
// left. The 🎯 Goals view and `api.goals()` both read this. Pure, no Obsidian imports.

import { dayDelta } from "./dates";

export interface GoalInfo {
  path: string;
  name: string;
  /** As written: active, done, someday… "" when unset. */
  status: string;
  area: string;
  period: string;
  targetDate: string | null;
  completed: string | null;
}

export interface GoalProject {
  path: string;
  name: string;
  status: string | null;
  next: string;
  due: string | null;
  /** The goal its `goal:` links to, resolved — null for none, or a link to nothing. */
  goalPath: string | null;
  /** Its steps and task notes: how many are done, of how many. */
  done: number;
  total: number;
}

export interface GoalProgress {
  goal: GoalInfo;
  /** Days to the target date — negative once it has passed — or null without one. */
  daysLeft: number | null;
  projects: GoalProject[];
  done: number;
  total: number;
}

export interface GoalsOverview {
  /** Goals being worked towards: active, or with no status — soonest target first. */
  open: GoalProgress[];
  /** Goals parked (someday, paused…) or finished, in name order. */
  other: GoalProgress[];
  /** Active projects serving no goal. */
  unlinked: GoalProject[];
}

const FINISHED = new Set(["done", "achieved", "complete", "completed", "dropped", "abandoned"]);

/** Whether a goal is being worked towards. */
export function goalIsOpen(g: GoalInfo): boolean {
  return !g.completed && (g.status === "" || g.status === "active");
}

export function goalsOverview(goals: GoalInfo[], projects: GoalProject[], today: string): GoalsOverview {
  const live = projects.filter((p) => p.status !== "done");
  const progress = (goal: GoalInfo): GoalProgress => {
    const mine = live.filter((p) => p.goalPath === goal.path).sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.name.localeCompare(b.name));
    return {
      goal,
      daysLeft: goal.targetDate ? dayDelta(today, goal.targetDate) : null,
      projects: mine,
      done: mine.reduce((n, p) => n + p.done, 0),
      total: mine.reduce((n, p) => n + p.total, 0),
    };
  };
  const all = goals.map(progress);
  const goalPaths = new Set(goals.map((g) => g.path));
  return {
    open: all.filter((g) => goalIsOpen(g.goal)).sort((a, b) => (a.goal.targetDate ?? "9999").localeCompare(b.goal.targetDate ?? "9999") || a.goal.name.localeCompare(b.goal.name)),
    other: all
      .filter((g) => !goalIsOpen(g.goal))
      .sort((a, b) => Number(FINISHED.has(a.goal.status) || !!a.goal.completed) - Number(FINISHED.has(b.goal.status) || !!b.goal.completed) || a.goal.name.localeCompare(b.goal.name)),
    unlinked: live.filter((p) => p.status === "active" && !(p.goalPath && goalPaths.has(p.goalPath))).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
