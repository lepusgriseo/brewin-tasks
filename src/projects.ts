// A project note's own fields — status, next action, what it waits on, its deadline — and the
// rules Project HQ runs on. No Obsidian imports → unit-testable.
//
// Project HQ (03_Projects.md) reads the same frontmatter through Dataview. The rules here are its
// rules, so the Planner and the HQ note can never disagree about which projects are stalled.

import { coerceISO } from "./dates";
import { displayText, writeInlineTask } from "./inlineTask";

export type ProjectStatus = "active" | "waiting" | "someday" | "done";
export const PROJECT_STATUSES: ProjectStatus[] = ["active", "waiting", "someday", "done"];

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: "Active",
  waiting: "Waiting",
  someday: "Someday",
  done: "Done",
};

/** The glyphs Project HQ's weekly transfer already uses on paper: ● active, ◐ waiting. */
export const STATUS_GLYPH: Record<ProjectStatus, string> = {
  active: "●",
  waiting: "◐",
  someday: "○",
  done: "✓",
};

export interface ProjectInfo {
  path: string;
  name: string;
  /** Null when the note has no status, or one HQ wouldn't recognise. */
  status: ProjectStatus | null;
  waitingOn: string;
  due: string | null;
  /** The day it began (`started:`), for the timeline. */
  started: string | null;
  completed: string | null;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** Read a project note's frontmatter. Missing and null fields read as empty. */
export function projectFromFrontmatter(path: string, name: string, fm: Record<string, unknown> | undefined): ProjectInfo {
  const raw = text(fm?.status).toLowerCase();
  return {
    path,
    name,
    status: (PROJECT_STATUSES as string[]).includes(raw) ? (raw as ProjectStatus) : null,
    waitingOn: text(fm?.waiting_on),
    due: coerceISO(fm?.due),
    started: coerceISO(fm?.started),
    completed: coerceISO(fm?.completed),
  };
}

/**
 * A project's next actions: its open steps tagged `#next`, in the note's order. The tag is the one
 * place a next action lives — Life HQ and Project HQ read the same thing.
 */
export function nextSteps<T extends { isNext: boolean; line: number }>(steps: readonly T[]): T[] {
  return steps.filter((s) => s.isNext).sort((a, b) => a.line - b.line);
}

/** The 🚩 Stalled rule, as Life HQ has it: an active project with no open `#next` step. */
export function isStalled(p: ProjectInfo, openSteps: readonly { isNext: boolean }[]): boolean {
  return p.status === "active" && !openSteps.some((s) => s.isNext);
}

const dayNumber = (iso: string) => Math.round(Date.parse(iso + "T00:00:00Z") / 86400000);

/** How far off the project's deadline is. Null with no deadline, or once the project is done. */
export function deadline(p: ProjectInfo, today: string): { iso: string; days: number; overdue: boolean } | null {
  if (!p.due || p.status === "done") return null;
  const days = dayNumber(p.due) - dayNumber(today);
  return { iso: p.due, days, overdue: days < 0 };
}

/** "17 days overdue", "due today", "due tomorrow", "in 12 days". */
export function deadlineLabel(d: { days: number }): string {
  if (d.days < 0) return `${-d.days} day${d.days === -1 ? "" : "s"} overdue`;
  if (d.days === 0) return "due today";
  if (d.days === 1) return "due tomorrow";
  return `in ${d.days} days`;
}

// ── Steps (the checkbox lines in the note) ────────────────────────────────────

/** A checkbox line read as an action: inline fields, `#next` and HTML comments taken out. */
export function stepText(body: string): string {
  return displayText(body); // one reading of a step's words, shared with inlineTask.ts
}

/**
 * A next action or step as it reads on screen: `[[Note|label]]` shows its label, `[[Note]]` its
 * name, and bold, italic and code marks drop away. The note keeps its own markdown — Project HQ
 * renders it.
 */
export function plainText(s: string): string {
  return s
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, (_, target: string) => target.split("#")[0].split("/").pop() ?? target)
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2");
}

/** Steps to offer as the next action: any already tagged `#next` first, then the rest in note order. */
export function promoteCandidates<T extends { isNext: boolean }>(steps: readonly T[], except: T | null = null): T[] {
  const rest = steps.filter((s) => s !== except);
  return [...rest.filter((s) => s.isNext), ...rest.filter((s) => !s.isNext)];
}

// ── Writing the note ──────────────────────────────────────────────────────────

export interface ProjectPatch {
  status?: ProjectStatus;
  waiting_on?: string;
  due?: string | null;
  completed?: string | null;
  modified?: string;
}

/** Where a key goes when the note doesn't have it yet — beside the field it is read with. */
const AFTER: Record<keyof ProjectPatch, string[]> = {
  status: ["tags"],
  waiting_on: ["status"],
  due: ["goal", "area", "waiting_on"],
  completed: ["started", "due"],
  modified: ["completed", "started"],
};

const STRING_KEYS = new Set<keyof ProjectPatch>(["waiting_on"]);

function yamlLine(key: keyof ProjectPatch, value: string | null): string {
  if (STRING_KEYS.has(key)) return `${key}: ${JSON.stringify(value ?? "")}`; // a JSON string is a valid YAML one
  return value ? `${key}: ${value}` : `${key}:`;
}

/**
 * Set project fields in a note's frontmatter, line by line. Every other byte stays as it was, so a
 * change is a one-line diff in git — re-serialising the whole block would requote every field.
 * Strings are written quoted (`waiting_on: "…"`), dates bare, and a cleared date as `due:`, the way the
 * project template writes them.
 */
export function withProjectFields(text: string, patch: ProjectPatch): string {
  const m = /^---\n(?:([\s\S]*?)\n)?---(\n|$)/.exec(text);
  const lines = m?.[1] ? m[1].split("\n") : [];
  const keyAt = (key: string) => lines.findIndex((l) => l.startsWith(`${key}:`));
  for (const key of Object.keys(patch) as (keyof ProjectPatch)[]) {
    const line = yamlLine(key, patch[key] ?? null);
    const at = keyAt(key);
    if (at >= 0) {
      // A value can run on below its key (a list or a folded string); it goes with the key.
      let end = at + 1;
      while (end < lines.length && /^(\s|- )/.test(lines[end])) end++;
      lines.splice(at, end - at, line);
      continue;
    }
    const anchor = AFTER[key].map(keyAt).find((i) => i >= 0);
    if (anchor === undefined) {
      lines.push(line);
      continue;
    }
    let end = anchor + 1;
    while (end < lines.length && /^(\s|- )/.test(lines[end])) end++;
    lines.splice(end, 0, line);
  }
  const block = `---\n${lines.length ? lines.join("\n") + "\n" : ""}---`;
  return m ? block + m[2] + text.slice(m[0].length) : `${block}\n${text}`;
}

/** Tick the open checkbox on `line`, if it still says `raw` (or find `raw` if the note moved). */
export function tickStep(lines: string[], line: number, raw: string, doneISO?: string): boolean {
  const at = lines[line] === raw ? line : lines.indexOf(raw);
  if (at < 0 || !/- \[ \]/.test(lines[at])) return false;
  // With a date, the tick records it as the line writes dates — `[completion:: …]` or ✅.
  lines[at] = doneISO ? writeInlineTask(lines[at], { done: true }, doneISO) : lines[at].replace(/- \[ \]/, "- [x]");
  return true;
}

/** Tag a step `#next` — the project's next action — in the line's own style. */
export function tagStep(lines: string[], line: number, raw: string): boolean {
  const at = lines[line] === raw ? line : lines.indexOf(raw);
  if (at < 0 || /#next\b/.test(lines[at])) return false;
  lines[at] = writeInlineTask(lines[at], { next: true }, "");
  return true;
}

/**
 * A next action typed rather than chosen: a new open step tagged `#next`, first under the note's
 * `## Tasks` (it reads first because it is next) — or in a Tasks section of its own, before the log.
 */
export function withNewStep(text: string, words: string): string {
  const step = `- [ ] ${words.replace(/\s+/g, " ").trim()} #next`;
  const lines = text.split("\n");
  const tasks = lines.findIndex((l) => /^##\s+Tasks\s*$/.test(l));
  if (tasks >= 0) {
    lines.splice(tasks + 1, 0, step);
    return lines.join("\n");
  }
  const log = lines.findIndex((l) => /^##\s+Log\s*$/.test(l));
  if (log >= 0) {
    lines.splice(log, 0, "## Tasks", step, "");
    return lines.join("\n");
  }
  return `${text.replace(/\s*$/, "")}\n\n## Tasks\n${step}\n`;
}

/**
 * Add an entry to the note's `## Log`, under a `### YYYY-MM-DD` heading for the day — added after
 * the last entry, so the time-tracking callout that follows the log in older notes stays last.
 * A note without a log gets one at the end.
 */
export function withLogEntry(text: string, dateISO: string, entry: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s+Log\s*$/.test(l));
  const bullet = `- ${entry}`;
  if (start < 0) return `${text.replace(/\s*$/, "")}\n\n## Log\n### ${dateISO}\n${bullet}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let lastEntry = start; // the last heading or bullet in the log
  let lastHeading = "";
  for (let i = start + 1; i < end; i++) {
    if (/^###\s/.test(lines[i])) {
      lastEntry = i;
      lastHeading = lines[i].replace(/^###\s+/, "").trim();
    } else if (/^\s*[-*]\s/.test(lines[i])) lastEntry = i;
  }
  const insert = lastHeading === dateISO ? [bullet] : [...(lastEntry > start ? [""] : []), `### ${dateISO}`, bullet];
  lines.splice(lastEntry + 1, 0, ...insert);
  return lines.join("\n");
}

/** The project as it reads once `patch` is written. */
export function applyPatch(p: ProjectInfo, patch: ProjectPatch): ProjectInfo {
  return {
    ...p,
    status: patch.status ?? p.status,
    waitingOn: patch.waiting_on !== undefined ? patch.waiting_on.trim() : p.waitingOn,
    due: patch.due !== undefined ? patch.due : p.due,
    completed: patch.completed !== undefined ? patch.completed : p.completed,
  };
}

/** What changes when a project moves to a new status. Waiting needs to say on what. */
export function statusPatch(p: ProjectInfo, status: ProjectStatus, today: string, waitingOn = ""): ProjectPatch {
  const patch: ProjectPatch = { status };
  if (status === "waiting") patch.waiting_on = waitingOn.trim();
  else if (p.waitingOn) patch.waiting_on = "";
  if (status === "done") patch.completed = today;
  else if (p.completed) patch.completed = null;
  return patch;
}
