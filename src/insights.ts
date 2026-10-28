// The Time report's other tabs: how estimates compare with the time logged, how much gets done and
// whether by its deadline, and how focus time is kept up — over the report's period. Pure, no Obsidian
// imports. Weeks start on Monday, as the report's own do.

import type { Task } from "./types";
import { shiftISO } from "./dates";

export interface EstimateInsight {
  /** Tasks finished in the period with both an estimate and time logged. */
  count: number;
  /** Logged ÷ estimated for the middle one of them: 1.5 means things take half as long again. */
  median: number | null;
  /** The furthest over their estimate, most first. */
  worst: { path: string; title: string; estimate: number; logged: number; ratio: number }[];
  /** By context, where a context has at least two. */
  byContext: { context: string; count: number; median: number }[];
}

export interface CompletionInsight {
  total: number;
  /** One-offs with a deadline: finished by it, or after. */
  onTime: number;
  late: number;
  byWeek: { weekStart: string; count: number }[];
  /** Monday first. */
  byWeekday: number[];
  byContext: { label: string; count: number }[];
  byProject: { label: string; count: number }[];
}

export interface FocusInsight {
  total: number;
  byDay: { date: string; minutes: number }[];
  /** Days in a row with focus time, up to today (or yesterday, until today has some); the longest in the period. */
  streak: number;
  longest: number;
  top: { path: string; title: string; minutes: number }[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const logged = (t: Task) => (t.timeLog ?? []).reduce((n, s) => n + s.minutes, 0);
const finishedIn = (t: Task, from: string, to: string) => t.status === "done" && !!t.completed && t.completed >= from && t.completed <= to;

/** Monday of the week a day is in. */
export function weekStartOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return shiftISO(iso, -((d.getUTCDay() + 6) % 7)) ?? iso;
}

export function estimateInsight(tasks: Task[], from: string, to: string): EstimateInsight {
  const rows = tasks
    .filter((t) => finishedIn(t, from, to) && (t.estimate ?? 0) > 0 && logged(t) > 0)
    .map((t) => ({ t, estimate: t.estimate!, logged: logged(t), ratio: logged(t) / t.estimate! }));
  const contexts = new Map<string, number[]>();
  for (const r of rows) for (const c of r.t.contexts) contexts.set(c.toLowerCase(), [...(contexts.get(c.toLowerCase()) ?? []), r.ratio]);
  return {
    count: rows.length,
    median: median(rows.map((r) => r.ratio)),
    worst: rows
      .filter((r) => r.ratio > 1)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 5)
      .map((r) => ({ path: r.t.path, title: r.t.title, estimate: r.estimate, logged: r.logged, ratio: r.ratio })),
    byContext: [...contexts]
      .filter(([, xs]) => xs.length >= 2)
      .map(([context, xs]) => ({ context, count: xs.length, median: median(xs)! }))
      .sort((a, b) => b.median - a.median),
  };
}

export function completionInsight(tasks: Task[], from: string, to: string): CompletionInsight {
  // Each finished one-off once, on the day it was ticked; a repeat once for each time it was done.
  const done: { t: Task; day: string }[] = [];
  for (const t of tasks) {
    if (t.recurrence) for (const d of t.completeInstances) if (d >= from && d <= to) done.push({ t, day: d });
    if (!t.recurrence && finishedIn(t, from, to)) done.push({ t, day: t.completed! });
  }
  const oneOffs = done.filter((d) => !d.t.recurrence && d.t.due);
  const tally = (labels: (x: { t: Task }) => string[]) => {
    const m = new Map<string, number>();
    for (const d of done) for (const l of labels(d)) m.set(l, (m.get(l) ?? 0) + 1);
    return [...m].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 8);
  };
  const weeks = new Map<string, number>();
  for (let w = weekStartOf(from); w <= to; w = shiftISO(w, 7) ?? to) weeks.set(w, 0);
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  for (const d of done) {
    const w = weekStartOf(d.day);
    weeks.set(w, (weeks.get(w) ?? 0) + 1);
    byWeekday[(new Date(`${d.day}T00:00:00Z`).getUTCDay() + 6) % 7]++;
  }
  return {
    total: done.length,
    onTime: oneOffs.filter((d) => d.day <= d.t.due!).length,
    late: oneOffs.filter((d) => d.day > d.t.due!).length,
    byWeek: [...weeks].map(([weekStart, count]) => ({ weekStart, count })),
    byWeekday,
    byContext: tally(({ t }) => (t.contexts.length ? t.contexts.map((c) => `@${c.toLowerCase()}`) : ["no context"])),
    byProject: tally(({ t }) => [t.projectPath ? t.projectPath.split("/").pop()!.replace(/\.md$/, "") : "no project"]),
  };
}

export function focusInsight(tasks: Task[], from: string, to: string, today: string): FocusInsight {
  const perDay = new Map<string, number>();
  const perTask = new Map<string, { path: string; title: string; minutes: number }>();
  for (const t of tasks) {
    for (const s of t.timeLog ?? []) {
      perDay.set(s.day, (perDay.get(s.day) ?? 0) + s.minutes);
      if (s.day < from || s.day > to) continue;
      const cur = perTask.get(t.path) ?? { path: t.path, title: t.title, minutes: 0 };
      cur.minutes += s.minutes;
      perTask.set(t.path, cur);
    }
  }
  const byDay: FocusInsight["byDay"] = [];
  let run = 0;
  let longest = 0;
  for (let d = from; d <= to; d = shiftISO(d, 1) ?? to) {
    const minutes = perDay.get(d) ?? 0;
    byDay.push({ date: d, minutes });
    run = minutes ? run + 1 : 0;
    longest = Math.max(longest, run);
    if (d === to) break;
  }
  // The streak runs back from today — or from yesterday, while today has nothing yet.
  let streak = 0;
  let d = (perDay.get(today) ?? 0) > 0 ? today : shiftISO(today, -1) ?? today;
  while ((perDay.get(d) ?? 0) > 0) {
    streak++;
    d = shiftISO(d, -1) ?? d;
  }
  return {
    total: byDay.reduce((n, x) => n + x.minutes, 0),
    byDay,
    streak,
    longest,
    top: [...perTask.values()].sort((a, b) => b.minutes - a.minutes || a.title.localeCompare(b.title)).slice(0, 5),
  };
}
