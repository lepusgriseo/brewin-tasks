// The focus timer: one clock at a time, on one task. It lives on the task note (`timer_started:`),
// so it survives Obsidian closing, a phone sleeping, and shows on another device after a sync; and
// every stopped session is logged there (`time_log:`, `time_spent:`) and, if settings say so, filed
// as a calendar event under the focus category. The maths is in timeTrack.ts.

import { Notice, TFile } from "obsidian";
import type BrewinTasksPlugin from "./main";
import { formatSession, formatStarted, parseTimeLog, sessionMinutes, totalMinutes } from "./timeTrack";
import { todayISO } from "./dates";
import { toWikilink } from "./task";
import { Task } from "./types";

/** Long enough for our own write to reach the metadata cache before the cache is trusted again. */
const OWN_WRITE_MS = 3000;

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localHM = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)]);

export class TaskTimer {
  private run: { path: string; start: number } | null = null;
  private listeners = new Set<() => void>();
  /** Until then, the cache may still hold what we just overwrote — `reload` leaves the clock alone. */
  private ownWriteUntil = 0;

  constructor(private plugin: BrewinTasksPlugin) {}

  /** The running clock, if any: which task, and since when (epoch ms). */
  get running(): { path: string; start: number } | null {
    return this.run;
  }

  isRunning(path?: string): boolean {
    return !!this.run && (path === undefined || this.run.path === path);
  }

  elapsed(now = Date.now()): number {
    return this.run ? now - this.run.start : 0;
  }

  /** Told whenever the clock starts or stops, here or (after a sync) elsewhere. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * Read the clock from the task notes: one left running before Obsidian closed, or started on another
   * device. With two running (two devices, one sync apart), the later one is shown.
   */
  reload(): void {
    if (Date.now() < this.ownWriteUntil) return;
    const top = this.plugin.store
      .getTasks()
      .filter((t) => t.timerStarted != null)
      .sort((a, b) => (b.timerStarted ?? 0) - (a.timerStarted ?? 0))[0];
    const next = top ? { path: top.path, start: top.timerStarted! } : null;
    if (next?.path === this.run?.path && next?.start === this.run?.start) return;
    this.run = next;
    this.changed();
  }

  /** Start timing a task. Another task's clock is paused (and logged) first: one at a time. */
  async start(task: Task): Promise<void> {
    if (this.run?.path === task.path) return;
    if (this.run) {
      const other = this.plugin.store.getByPath(this.run.path)?.title ?? "the other task";
      const min = await this.pause();
      new Notice(min ? `Paused “${other}” — ${min} min logged.` : `Paused “${other}”.`);
    }
    const start = Date.now();
    this.run = { path: task.path, start };
    this.changed();
    await this.write(task.path, (fm) => {
      fm.timer_started = formatStarted(start);
    });
  }

  /** Stop the clock and log the session. Returns the minutes logged — 0 for a few seconds. */
  async pause(): Promise<number> {
    const run = this.run;
    if (!run) return 0;
    this.run = null;
    this.changed();
    const end = Date.now();
    const minutes = sessionMinutes(run.start, end);
    const line = minutes ? formatSession(run.start, end) : null;
    await this.write(run.path, (fm) => {
      delete fm.timer_started;
      if (line) appendSession(fm, line);
    });
    if (line) await this.fileSession(run.path, run.start, end, line);
    return minutes;
  }

  /** Stop the clock if it's on this task, then tick the task done. Returns why not, if it can't be. */
  async finish(task: Task): Promise<string | null> {
    if (this.run?.path === task.path) await this.pause();
    const fresh = this.plugin.store.getByPath(task.path) ?? task;
    const res = await this.plugin.store.complete(fresh);
    if (res.ok) return null;
    return [res.open ? `${res.open} subtask${res.open === 1 ? "" : "s"} still open` : "", res.blocked ? `waiting on ${res.blocked} other task${res.blocked === 1 ? "" : "s"}` : ""]
      .filter(Boolean)
      .join(" and ");
  }

  /** Log time worked without the clock — typed in the focus window. */
  async addSession(path: string, start: number, end: number): Promise<void> {
    const line = formatSession(start, end);
    await this.write(path, (fm) => appendSession(fm, line));
    await this.fileSession(path, start, end, line);
  }

  /** Change a logged session's times; its calendar event moves with it. */
  async editSession(path: string, old: string, start: number, end: number): Promise<void> {
    const line = formatSession(start, end);
    await this.write(path, (fm) => {
      const log = asList(fm.time_log).map((l) => (l.trim() === old ? line : l));
      setLog(fm, log);
    });
    await this.unfileSession(path, old);
    await this.fileSession(path, start, end, line);
  }

  /** Remove a logged session, and its calendar event. */
  async deleteSession(path: string, line: string): Promise<void> {
    await this.write(path, (fm) => setLog(fm, asList(fm.time_log).filter((l) => l.trim() !== line)));
    await this.unfileSession(path, line);
  }

  private async write(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    this.ownWriteUntil = Date.now() + OWN_WRITE_MS;
    await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
      fn(fm);
      fm.modified = todayISO();
    });
  }

  /** The session as a calendar event, under the focus category (created the first time it's needed). */
  private async fileSession(path: string, start: number, end: number, line: string): Promise<void> {
    const s = this.plugin.settings;
    if (!s.timerToCalendar) return;
    const task = this.plugin.store.getByPath(path);
    const name = task?.title ?? path.split("/").pop()!.replace(/\.md$/, "");
    const category = s.timerCategory.trim() || "Focus";
    if (!s.categories.some((c) => c.name === category)) {
      s.categories.push({ name: category, color: "#2a78d6" });
      await this.plugin.saveSettings();
    }
    const startDay = localDay(start);
    const endDay = localDay(end);
    try {
      await this.plugin.events.createEvent({
        title: name,
        date: startDay,
        endDate: endDay !== startDay ? endDay : null,
        allDay: false,
        startTime: localHM(start),
        endTime: localHM(end),
        category,
        remind: "none",
        task: toWikilink(path.split("/").pop()!.replace(/\.md$/, "")),
        session: line,
        body: `Focus session on ${toWikilink(path.split("/").pop()!.replace(/\.md$/, ""))}.`,
      });
    } catch (e) {
      console.error("Brewin Planner: could not file the session in the calendar", e);
      new Notice("The session is logged on the task, but its calendar event couldn't be made.");
    }
  }

  private async unfileSession(path: string, line: string): Promise<void> {
    for (const file of this.plugin.events.sessionEvents(path, line)) await this.plugin.app.fileManager.trashFile(file);
  }
}

function setLog(fm: Record<string, unknown>, log: string[]): void {
  if (log.length) {
    fm.time_log = log;
    fm.time_spent = totalMinutes(parseTimeLog(log));
  } else {
    delete fm.time_log;
    delete fm.time_spent;
  }
}

function appendSession(fm: Record<string, unknown>, line: string): void {
  setLog(fm, [...asList(fm.time_log), line]);
}
