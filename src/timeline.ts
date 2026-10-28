// The Projects view as a timeline: each active or waiting project a bar from the day it started to
// its deadline, its dated steps and task notes as marks along it (a multi-day task as a thin bar),
// with a line for today and the months across the top. Pure, no Obsidian imports.

import { dayDelta, shiftISO } from "./dates";

export interface TimelineInput {
  path: string;
  name: string;
  status: string | null;
  started: string | null;
  due: string | null;
  /** Its dated work: steps and task notes on their do-date (else deadline); a multi-day task to its end. */
  items: { key: string; label: string; date: string; end?: string | null; kind: "step" | "task" }[];
}

export interface TimelineRow {
  path: string;
  name: string;
  status: string | null;
  /** Day indexes, inclusive. Null when it has neither a start nor a deadline. An open side has no date. */
  bar: { from: number; to: number; openStart: boolean; openEnd: boolean; overdue: boolean } | null;
  marks: { key: string; label: string; kind: "step" | "task"; date: string; at: number; to: number; overdue: boolean }[];
}

export interface Timeline {
  from: string;
  to: string;
  days: number;
  /** Today's index in the range. */
  today: number;
  months: { label: string; at: number }[];
  rows: TimelineRow[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * From a week before today (or the earliest start) to four weeks on (or the latest deadline), held to
 * six months back and a year ahead so one old project can't stretch the rest into slivers.
 */
export function buildTimeline(projects: TimelineInput[], today: string): Timeline {
  const floor = shiftISO(today, -183) ?? today;
  const ceil = shiftISO(today, 365) ?? today;
  const dates = projects.flatMap((p) => [p.started, p.due, ...p.items.flatMap((i) => [i.date, i.end ?? null])]).filter((d): d is string => !!d);
  const from = [shiftISO(today, -7) ?? today, ...dates].reduce((a, b) => (b < a ? b : a));
  const to = [shiftISO(today, 28) ?? today, ...dates].reduce((a, b) => (b > a ? b : a));
  const start = from < floor ? floor : from;
  const end = to > ceil ? ceil : to;
  const days = dayDelta(start, end) + 1;
  const at = (iso: string) => Math.min(days - 1, Math.max(0, dayDelta(start, iso)));
  const now = at(today);

  const months: Timeline["months"] = [];
  for (let d = start; d <= end; ) {
    const [y, m] = d.split("-").map(Number);
    if (d === start || d.endsWith("-01")) months.push({ label: m === 1 || !months.length ? `${MONTHS[m - 1]} ${y}` : MONTHS[m - 1], at: at(d) });
    d = `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, "0")}-01`;
  }

  const rows = projects.map((p): TimelineRow => {
    let bar: TimelineRow["bar"] = null;
    if (p.started || p.due) {
      const from = p.started ? at(p.started) : now;
      const to = p.due ? at(p.due) : Math.max(from, now);
      bar = { from: Math.min(from, to), to: Math.max(from, to), openStart: !p.started, openEnd: !p.due, overdue: !!p.due && p.due < today && p.status === "active" };
    }
    const marks = p.items
      .map((i) => ({ key: i.key, label: i.label, kind: i.kind, date: i.date, at: at(i.date), to: i.end && i.end > i.date ? at(i.end) : at(i.date), overdue: (i.end ?? i.date) < today }))
      .sort((a, b) => a.at - b.at);
    return { path: p.path, name: p.name, status: p.status, bar, marks };
  });
  return { from: start, to: end, days, today: now, months, rows };
}
