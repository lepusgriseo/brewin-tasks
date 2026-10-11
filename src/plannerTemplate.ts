// A library of named presets for new tasks and events — "Meeting", "Job", "Deep work" — kept as
// notes in a folder rather than as settings, so a template is editable in Obsidian (including on a
// phone), versioned in git, and readable with the plugin switched off.
//
// Pure: no Obsidian imports. The store hands over a note's frontmatter and body and this decides
// what it means, which is why every awkward spelling below can be tested without a vault.
//
// Why not reuse `_Template/Calendar/`? Those 43 notes were built for QuickAdd, which had no way to
// ask for a date — so each activity needed one copy per weekday carrying
// `{{VDATE:Monday, YYYY-MM-DD}}`. A template that is given its date at creation time needs one copy
// per activity, which is why this format has no weekday in it at all.

import { addMinutesHM } from "./dates";
import { parseNaturalDate } from "./dateParser";
import { Priority, TaskSlot } from "./types";

export type TemplateKind = "event" | "task";

/** Field defaults for a new event. Mirrors `NewEventFields`, every key optional. */
export interface EventDefaults {
  title?: string;
  category?: string;
  allDay?: boolean;
  /** A relative phrase as written (`tomorrow`, `next monday`) — resolved at creation. */
  date?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  /** Minutes. Used to derive `endTime` from `startTime` when no explicit end is given. */
  duration?: number;
  recurrence?: string;
  remind?: string;
  remindStart?: boolean;
  location?: string;
  trip?: string;
}

/** Field defaults for a new task. Mirrors `NewTaskFields`, every key optional. */
export interface TaskDefaults {
  title?: string;
  scheduled?: string;
  due?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  duration?: number;
  priority?: Priority;
  contexts?: string[];
  estimate?: number;
  recurrence?: string;
  recurrenceAnchor?: "scheduled" | "due";
  remind?: string;
  remindStart?: boolean;
  times?: TaskSlot[];
  month?: string;
  week?: string;
  parent?: string;
  dependsOn?: string[];
}

export interface PlannerTemplate {
  path: string;
  /** What the pickers show. `name:` if given, else the basename minus a trailing "Template". */
  name: string;
  kind: TemplateKind;
  /** Lucide icon for the day-cell menu; null falls back to the kind's default. */
  icon: string | null;
  /** Lower sorts first; ties break alphabetically. */
  order: number;
  event: EventDefaults;
  task: TaskDefaults;
  /** Body copied into the new note — an agenda, a checklist, whatever the template carries. */
  body: string;
  /**
   * Reserved. A template may one day name others to create alongside it ("Work day" → the shift,
   * both commutes and the prep task). Parsed and carried now so adding that later changes no
   * note's format, but nothing reads it yet.
   */
  bundle: string[];
}

type Fm = Record<string, unknown>;

/** Frontmatter keys are matched case- and separator-insensitively: `start_time`, `Start Time`. */
function fold(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

function pick(fm: Fm, ...keys: string[]): unknown {
  const wanted = keys.map(fold);
  for (const [k, v] of Object.entries(fm)) {
    if (wanted.includes(fold(k)) && v !== null && v !== undefined && v !== "") return v;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function asNumber(v: unknown): number | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  const n = Number(/-?\d+(\.\d+)?/.exec(s)?.[0] ?? NaN);
  return Number.isFinite(n) ? n : undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  const s = asString(v)?.toLowerCase();
  if (s === undefined) return undefined;
  if (/^(true|yes|y|on|1)$/.test(s)) return true;
  if (/^(false|no|n|off|0)$/.test(s)) return false;
  return undefined;
}

function asList(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const items = Array.isArray(v) ? v : String(v).split(/[,;]/);
  const out = items.map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/** `"HH:MM"`, tolerating `9:00`, `0900` and `9am`. Anything else is dropped rather than guessed. */
export function normaliseTime(v: unknown): string | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(s);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3].toLowerCase() === "pm") h += 12;
    return `${String(h).padStart(2, "0")}:${ampm[2] ?? "00"}`;
  }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm && Number(hm[1]) < 24 && Number(hm[2]) < 60) return `${hm[1].padStart(2, "0")}:${hm[2]}`;
  const bare = /^(\d{2})(\d{2})$/.exec(s);
  if (bare && Number(bare[1]) < 24 && Number(bare[2]) < 60) return `${bare[1]}:${bare[2]}`;
  return undefined;
}

const PRIORITIES: Priority[] = ["low", "normal", "high"];

function asPriority(v: unknown): Priority | undefined {
  const s = asString(v)?.toLowerCase();
  return s && (PRIORITIES as string[]).includes(s) ? (s as Priority) : undefined;
}

/** `times: ["08:00 Morning", "20:00 Evening"]` → slots. */
function asSlots(v: unknown): TaskSlot[] | undefined {
  const list = asList(v);
  if (!list) return undefined;
  const slots: TaskSlot[] = [];
  for (const entry of list) {
    const m = /^(\S+)\s*(.*)$/.exec(entry);
    const time = normaliseTime(m?.[1]);
    if (!time) continue;
    slots.push({ time, label: (m?.[2] ?? "").trim() });
  }
  return slots.length ? slots : undefined;
}

export interface TemplateNote {
  path: string;
  basename: string;
  frontmatter: Fm;
  body: string;
}

/**
 * A template note → a template, or null if the note is not one.
 *
 * A note qualifies by carrying `planner_template:` (or `kind:`) set to `event` or `task`. The
 * folder alone is not enough: a folder note or a README living alongside the library must not
 * become a template that appears in every picker.
 */
export function parsePlannerTemplate(note: TemplateNote): PlannerTemplate | null {
  const fm = note.frontmatter ?? {};
  const declared = asString(pick(fm, "planner_template", "plannertemplate", "kind", "type"))?.toLowerCase();
  const kind: TemplateKind | null = declared === "event" ? "event" : declared === "task" ? "task" : null;
  if (!kind) return null;

  const name = asString(pick(fm, "name", "label")) ?? (note.basename.replace(/\s*template$/i, "").trim() || note.basename);
  const startTime = normaliseTime(pick(fm, "start_time", "starttime", "start", "time"));
  const endTime = normaliseTime(pick(fm, "end_time", "endtime", "end"));
  const duration = asNumber(pick(fm, "duration", "minutes", "length"));
  const remind = asString(pick(fm, "remind", "reminder"));
  const remindStart = asBool(pick(fm, "remind_start", "remindstart", "remind at start"));
  const recurrence = asString(pick(fm, "repeat", "recurrence", "rrule"));

  const shared = { startTime, endTime, duration, remind, remindStart, recurrence };

  return {
    path: note.path,
    name,
    kind,
    icon: asString(pick(fm, "icon")) ?? null,
    order: asNumber(pick(fm, "order", "sort")) ?? 100,
    event:
      kind === "event"
        ? strip({
            ...shared,
            title: asString(pick(fm, "title")),
            category: asString(pick(fm, "category")),
            allDay: asBool(pick(fm, "all_day", "allday")),
            date: asString(pick(fm, "date", "on", "when")),
            endDate: asString(pick(fm, "end_date", "enddate", "until")),
            location: asString(pick(fm, "location", "where")),
            trip: asString(pick(fm, "trip")),
          })
        : {},
    task:
      kind === "task"
        ? strip({
            ...shared,
            title: asString(pick(fm, "title")),
            scheduled: asString(pick(fm, "scheduled", "do", "date", "when")),
            due: asString(pick(fm, "due", "deadline")),
            endDate: asString(pick(fm, "end_date", "enddate")),
            priority: asPriority(pick(fm, "priority")),
            contexts: asList(pick(fm, "contexts", "context")),
            estimate: asNumber(pick(fm, "estimate", "effort")),
            recurrenceAnchor: asString(pick(fm, "recurrence_anchor", "anchor"))?.toLowerCase() === "due" ? "due" : undefined,
            times: asSlots(pick(fm, "times", "times_of_day")),
            month: asString(pick(fm, "month")),
            week: asString(pick(fm, "week")),
            parent: asString(pick(fm, "parent")),
            dependsOn: asList(pick(fm, "depends_on", "dependson", "blocked_by")),
          })
        : {},
    body: note.body.trim(),
    bundle: asList(pick(fm, "bundle", "also", "with_items")) ?? [],
  };
}

/** Drops undefined keys so a spread of defaults never overwrites a real value with nothing. */
function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export interface ResolveContext {
  /** The day the item is being created for — a clicked calendar cell, or today. */
  date: string;
  /** Minutes to use when a template gives a start time but no end and no duration. */
  defaultMinutes: number;
  /**
   * A start time the user has already chosen — by long-pressing a 14:00 slot, say. It beats the
   * template's own time, because pressing a specific hour is the more deliberate act of the two.
   */
  startTime?: string;
  now?: Date;
}

/**
 * Turns a template's written defaults into concrete values for one creation.
 *
 * Dates are the point of this function: a template says `tomorrow` or `next monday`, never a real
 * date, because the same template has to work in March and in October. A phrase that cannot be
 * parsed is dropped rather than guessed at — the modal's own default then applies, which is always
 * a sane date.
 */
export function resolveEvent(t: PlannerTemplate, ctx: ResolveContext): EventDefaults & { date: string } {
  const now = ctx.now ?? new Date();
  const d = t.event;
  const date = (d.date && parseNaturalDate(d.date, now)) || ctx.date;
  const startTime = ctx.startTime ?? d.startTime;
  // An end time written in the template only applies to the time it was written for; once the
  // user has picked their own start, the template's duration is what carries over.
  const endTime = ctx.startTime
    ? addMinutesHM(ctx.startTime, d.duration ?? ctx.defaultMinutes)
    : d.endTime ?? (startTime ? addMinutesHM(startTime, d.duration ?? ctx.defaultMinutes) : undefined);
  return strip({
    ...d,
    date,
    endDate: d.endDate ? parseNaturalDate(d.endDate, now) ?? undefined : undefined,
    startTime,
    endTime: d.allDay === true ? undefined : endTime,
  }) as EventDefaults & { date: string };
}

export function resolveTask(t: PlannerTemplate, ctx: ResolveContext): TaskDefaults {
  const now = ctx.now ?? new Date();
  const d = t.task;
  const startTime = ctx.startTime ?? d.startTime;
  const endTime = ctx.startTime
    ? addMinutesHM(ctx.startTime, d.duration ?? ctx.defaultMinutes)
    : d.endTime ?? (startTime ? addMinutesHM(startTime, d.duration ?? ctx.defaultMinutes) : undefined);
  return strip({
    ...d,
    // Unlike an event, a task need not have a date at all — so an unparseable or absent phrase
    // leaves it unscheduled rather than defaulting to the context day.
    scheduled: d.scheduled ? parseNaturalDate(d.scheduled, now) ?? undefined : undefined,
    due: d.due ? parseNaturalDate(d.due, now) ?? undefined : undefined,
    endDate: d.endDate ? parseNaturalDate(d.endDate, now) ?? undefined : undefined,
    startTime,
    endTime,
  });
}

/** Pickers and menus all show the library in one order: `order:`, then by name. */
export function sortTemplates(list: PlannerTemplate[]): PlannerTemplate[] {
  return [...list].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** A stable command id per template, so hotkeys survive a rename of the note's heading. */
export function templateCommandId(t: PlannerTemplate): string {
  const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "template";
  return `brewin-new-${t.kind}-${slug}`;
}

export const DEFAULT_TEMPLATE_ICON: Record<TemplateKind, string> = { event: "calendar-plus", task: "check-circle" };

/** A one-line summary of what the template sets — the useful half of a picker row. */
export function describeTemplate(t: PlannerTemplate): string {
  const bits: string[] = [t.kind];
  if (t.kind === "event") {
    const e = t.event;
    if (e.category) bits.push(e.category);
    if (e.allDay) bits.push("all day");
    else if (e.startTime) bits.push(e.duration ? `${e.startTime} · ${e.duration}m` : e.startTime);
    if (e.location) bits.push(e.location);
  } else {
    const k = t.task;
    if (k.priority && k.priority !== "normal") bits.push(`${k.priority} priority`);
    if (k.startTime) bits.push(k.startTime);
    if (k.estimate != null) bits.push(`${k.estimate}m`);
    if (k.contexts?.length) bits.push(k.contexts.join(", "));
  }
  if (t.event.recurrence || t.task.recurrence) bits.push("repeats");
  if (t.event.date || t.task.scheduled) bits.push(`→ ${t.event.date ?? t.task.scheduled}`);
  return bits.join(" · ");
}

// ── Saving a template back out ────────────────────────────────────────────────
//
// The counterpart to parsing: take what someone has just set up in the New event / New task modal
// and write it out as a template note. This is how a template gets made in practice — you pick the
// time with the native time picker you already have in front of you, then name it — rather than by
// hand-writing YAML on a phone.

export interface EventSnapshot {
  title: string;
  category: string;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
  recurrence: string | null;
  remind: string | null;
  remindStart: boolean | null;
  location: string | null;
}

export interface TaskSnapshot {
  title: string;
  priority: Priority;
  contexts: string[];
  estimate: number | null;
  startTime: string | null;
  endTime: string | null;
  recurrence: string | null;
  remind: string | null;
  remindStart: boolean | null;
  times: TaskSlot[];
  body: string;
}

/** Whole minutes between two "HH:MM" values, or null if either is missing or it would be ≤ 0. */
export function durationBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return null;
  const mins = eh * 60 + em - (sh * 60 + sm);
  return mins > 0 ? mins : null;
}

function yaml(lines: [string, string | number | boolean | null | undefined][]): string {
  return lines.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}: ${v}`).join("\n");
}

/** A quoted scalar, for anything that might contain a colon or start with a digit. */
function q(v: string): string {
  return `"${v.replace(/"/g, '\\"')}"`;
}

/**
 * The note text for a template built from an event.
 *
 * Two deliberate omissions. **No date** — a template that hardcoded the day it was made from would
 * be wrong tomorrow; leaving it out means the item lands on whatever day you create it. And
 * **duration rather than end time**, so the template survives being dropped on a different hour.
 */
export function templateNoteFromEvent(name: string, s: EventSnapshot, icon?: string): string {
  const duration = s.allDay ? null : durationBetween(s.startTime, s.endTime);
  const front = yaml([
    ["planner_template", "event"],
    ["name", q(name)],
    ["icon", icon ? q(icon) : null],
    // A template's title is its name: predictable, and still editable on the way in.
    ["title", q(name)],
    ["category", s.category ? q(s.category) : null],
    ["all_day", s.allDay],
    ["start_time", s.allDay || !s.startTime ? null : q(s.startTime)],
    ["duration", duration],
    ["repeat", s.recurrence ? q(s.recurrence) : null],
    ["remind", s.remind ? q(s.remind) : null],
    ["remind_start", s.remindStart === null ? null : s.remindStart],
    ["location", s.location ? q(s.location) : null],
  ]);
  return `---\n${front}\n---\n`;
}

/** The same for a task. Its notes become the template's body, so a checklist carries over. */
export function templateNoteFromTask(name: string, s: TaskSnapshot, icon?: string): string {
  const duration = durationBetween(s.startTime, s.endTime);
  const front = yaml([
    ["planner_template", "task"],
    ["name", q(name)],
    ["icon", icon ? q(icon) : null],
    ["title", q(name)],
    ["priority", s.priority],
    ["contexts", s.contexts.length ? s.contexts.join(", ") : null],
    ["estimate", s.estimate],
    ["start_time", s.startTime ? q(s.startTime) : null],
    ["duration", duration],
    ["times", s.times.length ? `[${s.times.map((x) => q(`${x.time} ${x.label}`.trim())).join(", ")}]` : null],
    ["repeat", s.recurrence ? q(s.recurrence) : null],
    ["remind", s.remind ? q(s.remind) : null],
    ["remind_start", s.remindStart === null ? null : s.remindStart],
  ]);
  const body = s.body.trim();
  return `---\n${front}\n---\n${body ? `\n${body}\n` : ""}`;
}

/** A filename for a template, safe in a vault path. */
export function templateFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Template";
}
