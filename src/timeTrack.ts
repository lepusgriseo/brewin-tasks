// Time tracked on a task: the focus timer's sessions, and the clock that is running now.
// Pure, no Obsidian imports.
//
// On the task note:
//   time_log:                       one line per session, local time, ISO 8601 interval style
//     - "2026-10-26T14:05/14:47"    — the end's date is left out when it's the same day
//     - "2026-10-26T23:40/2026-10-27T00:15"
//   time_spent: 107                 — total minutes, kept for Dataview and other plugins
//   timer_started: "2026-10-26T14:05:12"   — only while a clock is running
//
// The running clock is stored as the moment it started, not as seconds counted: JavaScript timers
// stop while a phone sleeps or Obsidian is closed, but the wall clock doesn't, so elapsed time is
// always worked out from it — and a clock started on one device shows on another after a sync.

export interface TimeSession {
  /** The line as it is stored, which also identifies the session (and its calendar event). */
  raw: string;
  /** Local start and end, epoch milliseconds. */
  start: number;
  end: number;
  minutes: number;
  /** Local ISO day the session started on — the day it counts towards. */
  day: string;
}

/** A session shorter than this is a slip of the finger, not work: it isn't logged. */
export const MIN_SESSION_MS = 30_000;

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localHM = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "YYYY-MM-DDTHH:MM[:SS]" as local time, or null. */
export function parseLocal(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Epoch ms → "YYYY-MM-DDTHH:MM:SS", local time — how `timer_started` is written. */
export function formatStarted(ms: number): string {
  const d = new Date(ms);
  return `${localDay(d)}T${localHM(d)}:${pad(d.getSeconds())}`;
}

/** The running clock's start from `timer_started`, or null when nothing is running. */
export function parseStarted(v: unknown): number | null {
  if (v == null || v === "") return null;
  return parseLocal(String(v));
}

/** Whole minutes a session counts for: at least one, or 0 when too short to log. */
export function sessionMinutes(start: number, end: number): number {
  const ms = end - start;
  if (ms < MIN_SESSION_MS) return 0;
  return Math.max(1, Math.round(ms / 60_000));
}

/** A session as stored: the end's date only when it differs from the start's. */
export function formatSession(start: number, end: number): string {
  const s = new Date(start);
  const e = new Date(end);
  const endText = localDay(e) === localDay(s) ? localHM(e) : `${localDay(e)}T${localHM(e)}`;
  return `${localDay(s)}T${localHM(s)}/${endText}`;
}

/** One stored line back into a session, or null when it can't be read. */
export function parseSession(raw: unknown): TimeSession | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  const [a, b] = text.split("/");
  if (!a || !b) return null;
  const start = parseLocal(a);
  if (start == null) return null;
  let end: number | null;
  if (/^\d{1,2}:\d{2}$/.test(b.trim())) {
    end = parseLocal(`${a.trim().slice(0, 10)}T${b.trim()}`);
    if (end != null && end < start) end += 86_400_000; // "23:40/00:15" written by hand: the next day
  } else end = parseLocal(b);
  if (end == null || end < start) return null;
  return { raw: text, start, end, minutes: Math.max(0, Math.round((end - start) / 60_000)), day: localDay(new Date(start)) };
}

/** Every readable session in a `time_log` value, oldest first. */
export function parseTimeLog(v: unknown): TimeSession[] {
  const list = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
  return list
    .map(parseSession)
    .filter((s): s is TimeSession => !!s)
    .sort((x, y) => x.start - y.start);
}

export const totalMinutes = (log: readonly TimeSession[]): number => log.reduce((n, s) => n + s.minutes, 0);

/** Minutes logged on days inside [fromISO, toISO] — a session counts on the day it started. */
export function minutesInRange(log: readonly TimeSession[], fromISO: string, toISO: string): number {
  return log.reduce((n, s) => (s.day >= fromISO && s.day <= toISO ? n + s.minutes : n), 0);
}

/** Per task, the time tracked in [fromISO, toISO], most first — for the day note and the reviews. */
export function trackedInRange(
  tasks: readonly { path: string; title: string; timeLog?: TimeSession[] }[],
  fromISO: string,
  toISO: string
): { path: string; title: string; minutes: number }[] {
  return tasks
    .map((t) => ({ path: t.path, title: t.title, minutes: minutesInRange(t.timeLog ?? [], fromISO, toISO) }))
    .filter((x) => x.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || a.title.localeCompare(b.title));
}

/** "00:42:17" — a running clock, hours always shown so the width doesn't jump at the hour. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** "1h 55m" · "42m" · "0m". */
export function minutesText(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/**
 * A session typed by hand in the focus window: "14:05-14:47" or "14:05–14:47" on a given day (an
 * end before the start runs past midnight), or a duration ("45", "45m", "1h 30m") ending at `endMs`.
 * Returns [start, end] in epoch ms, or null.
 */
export function parseManualSession(text: string, dayISO: string, endMs: number): [number, number] | null {
  const t = text.trim().toLowerCase();
  const range = /^(\d{1,2}):(\d{2})\s*[-–—to ]+\s*(\d{1,2}):(\d{2})$/.exec(t);
  if (range) {
    const start = parseLocal(`${dayISO}T${range[1]}:${range[2]}`);
    let end = parseLocal(`${dayISO}T${range[3]}:${range[4]}`);
    if (start == null || end == null) return null;
    if (end <= start) end += 86_400_000;
    return [start, end];
  }
  const dur = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(t);
  const plain = /^\d+$/.exec(t);
  const minutes = plain ? Number(t) : dur && (dur[1] || dur[2]) ? Math.round(Number(dur[1] ?? 0) * 60 + Number(dur[2] ?? 0)) : 0;
  if (!minutes || minutes > 24 * 60) return null;
  return [endMs - minutes * 60_000, endMs];
}

// ── Pomodoro ──────────────────────────────────────────────────────────────────────────────────
// Work, a short break, work… and a long break every few rounds. Which phase a session is in is
// worked out from how long its clock has run, so it survives Obsidian closing and agrees across
// devices; nothing about it is stored. Only the work is logged.

export interface PomodoroSettings {
  /** Minutes. */
  work: number;
  short: number;
  long: number;
  /** Rounds of work before the long break. */
  every: number;
}

export interface PomodoroPhase {
  kind: "work" | "short" | "long";
  /** Which round of work this is, or follows — from 1. */
  round: number;
  /** Where the phase starts and ends, in ms since the clock started; and how long is left. */
  from: number;
  to: number;
  left: number;
}

/** The phase a session is in `elapsed` ms after its clock started. */
export function pomodoroPhase(elapsed: number, p: PomodoroSettings): PomodoroPhase {
  const min = 60_000;
  const work = Math.max(1, p.work) * min;
  const short = Math.max(0, p.short) * min;
  const long = Math.max(0, p.long) * min;
  const every = Math.max(1, Math.floor(p.every));
  const cycle = every * work + (every - 1) * short + long;
  const at = Math.max(0, elapsed);
  const n = Math.floor(at / cycle);
  let t = n * cycle;
  for (let r = 1; ; r++) {
    if (at < t + work) return { kind: "work", round: n * every + r, from: t, to: t + work, left: t + work - at };
    t += work;
    const rest = r === every ? long : short;
    if (at < t + rest) return { kind: r === every ? "long" : "short", round: n * every + r, from: t, to: t + rest, left: t + rest - at };
    t += rest;
  }
}

/** The work in a session from `start` to `end` (epoch ms), as [start, end] stretches — what is logged. */
export function workStretches(start: number, end: number, p: PomodoroSettings): [number, number][] {
  const out: [number, number][] = [];
  for (let at = 0; at < end - start; ) {
    const phase = pomodoroPhase(at, p);
    if (phase.kind === "work") out.push([start + at, start + Math.min(phase.to, end - start)]);
    at = phase.to;
  }
  return out;
}
