// Other calendars — an .ics subscription (Google, Outlook, iCloud, a club's fixtures) shown beside
// the Planner's own events, read-only. This is the pure part: reading the iCalendar text (RFC 5545)
// and laying its events out between two days on the device's clock. Repeats go through rrule.ts; a
// rule it can't follow (BYSETPOS, BYHOUR…) shows its first date and says so rather than guessing.
// Time zones are converted with Intl — no zone database. No Obsidian imports.

import { parseISO, shiftISO } from "./dates";
import { occurrencesInRange, parseRRule } from "./rrule";

/** A moment as the calendar wrote it: a day, a time on it (none for all-day), and whose clock. */
export interface IcsTime {
  date: string;
  time: string | null;
  /** "UTC", an IANA zone, or null for floating — the reader's own clock. */
  zone: string | null;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  location: string;
  description: string;
  start: IcsTime;
  /** Where it ends (exclusive for an all-day event), or null — see `minutes`. */
  end: IcsTime | null;
  /** From DURATION, when there's no DTEND. */
  minutes: number | null;
  rrule: string | null;
  exdates: IcsTime[];
  /** The occurrence of its series this one replaces (RECURRENCE-ID), or null. */
  recurrenceId: IcsTime | null;
  cancelled: boolean;
}

export interface IcsOccurrence {
  uid: string;
  title: string;
  date: string;
  allDay: boolean;
  start: string | null;
  end: string | null;
  location: string;
  description: string;
  recurring: boolean;
  /** A repeat the Planner can't follow: only its first date is shown. */
  unsupported: boolean;
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** NAME;PARAM=VALUE:VALUE — a colon or semicolon inside a quoted parameter value is part of it. */
function readLine(line: string): Prop | null {
  const segs: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    if (!quoted && (c === ";" || c === ":")) {
      segs.push(cur);
      cur = "";
      if (c === ":") return makeProp(segs, line.slice(i + 1));
      continue;
    }
    cur += c;
  }
  return null;
}

function makeProp(segs: string[], value: string): Prop {
  const params: Record<string, string> = {};
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf("=");
    if (eq > 0) params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: segs[0].toUpperCase(), params, value };
}

const unescapeText = (v: string) => v.replace(/\\([\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c)).trim();

/** Outlook writes Windows zone names; the common ones, as IANA names Intl knows. */
const WINDOWS_ZONES: Record<string, string> = {
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kyiv",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "Atlantic Standard Time": "America/Halifax",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Singapore Standard Time": "Asia/Singapore",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
};

const validZones = new Map<string, boolean>();
function isZone(z: string): boolean {
  let ok = validZones.get(z);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: z });
      ok = true;
    } catch {
      ok = false;
    }
    validZones.set(z, ok);
  }
  return ok;
}

/** A TZID as a zone Intl knows, or null (floating) when it's none Intl recognises. */
export function zoneName(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const name = tzid.trim().replace(/^\/[^/]+\/[^/]+\//, ""); // "/mozilla.org/20050126_1/Europe/London"
  const z = WINDOWS_ZONES[name] ?? name;
  return isZone(z) ? z : null;
}

function readTime(p: Prop, value = p.value): IcsTime | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4] || p.params.VALUE === "DATE") return { date, time: null, zone: null };
  return { date, time: `${m[4]}:${m[5]}`, zone: m[7] ? "UTC" : zoneName(p.params.TZID) };
}

function readDuration(v: string): number | null {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 7 * 1440 + Number(m[2] ?? 0) * 1440 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

/** The calendar's own name (X-WR-CALNAME), if it gives one. */
export function icsCalendarName(text: string): string | null {
  const m = /^X-WR-CALNAME(?:;[^:]*)?:(.*)$/m.exec(text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, ""));
  return m ? unescapeText(m[1]) || null : null;
}

/** The VEVENTs in an iCalendar text. Anything inside them (a VALARM's own DESCRIPTION) stays out. */
export function parseIcs(text: string): IcsEvent[] {
  type Draft = Omit<IcsEvent, "start"> & { start: IcsTime | null };
  const out: IcsEvent[] = [];
  const stack: string[] = [];
  let ev: Draft | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n")) {
    const p = readLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const what = p.value.trim().toUpperCase();
      stack.push(what);
      if (what === "VEVENT") ev = { uid: "", summary: "", location: "", description: "", start: null, end: null, minutes: null, rrule: null, exdates: [], recurrenceId: null, cancelled: false };
      continue;
    }
    if (p.name === "END") {
      if (stack.pop() === "VEVENT" && ev) {
        if (ev.start) out.push({ ...ev, start: ev.start });
        ev = null;
      }
      continue;
    }
    if (!ev || stack[stack.length - 1] !== "VEVENT") continue;
    switch (p.name) {
      case "UID": ev.uid = p.value.trim(); break;
      case "SUMMARY": ev.summary = unescapeText(p.value); break;
      case "LOCATION": ev.location = unescapeText(p.value); break;
      case "DESCRIPTION": ev.description = unescapeText(p.value); break;
      case "DTSTART": ev.start = readTime(p); break;
      case "DTEND": ev.end = readTime(p); break;
      case "DURATION": ev.minutes = readDuration(p.value); break;
      case "RRULE": ev.rrule = p.value.trim(); break;
      case "EXDATE":
        for (const v of p.value.split(",")) {
          const t = readTime(p, v);
          if (t) ev.exdates.push(t);
        }
        break;
      case "RECURRENCE-ID": ev.recurrenceId = readTime(p); break;
      case "STATUS": ev.cancelled = p.value.trim().toUpperCase() === "CANCELLED"; break;
    }
  }
  return out;
}

// ── Clocks ───────────────────────────────────────────────────────────────────────────────────

const formats = new Map<string, Intl.DateTimeFormat>();
function wall(ms: number, zone: string): { y: number; m: number; d: number; h: number; mi: number } {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    formats.set(zone, f);
  }
  const o: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) o[part.type] = part.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A UTC instant as a day and a time on a zone's clock. */
export function clockIn(ms: number, zone: string): { date: string; time: string } {
  const w = wall(ms, zone);
  return { date: `${w.y}-${pad(w.m)}-${pad(w.d)}`, time: `${pad(w.h)}:${pad(w.mi)}` };
}

/** The UTC instant a zone's clock reads `date time` — floating times on the reader's own clock. */
export function instantOf(date: string, time: string, zone: string | null, local: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const asUTC = Date.UTC(y, m - 1, d, h, mi);
  const z = zone ?? local;
  if (z === "UTC") return asUTC;
  // The zone's offset is whatever its clock reads minus UTC; asked twice, for a day the clocks change.
  const offset = (ms: number) => {
    const w = wall(ms, z);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - Math.floor(ms / 60000) * 60000;
  };
  const first = asUTC - offset(asUTC);
  return asUTC - offset(first);
}

// ── Laying out ───────────────────────────────────────────────────────────────────────────────

const PLAIN_PARTS = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "COUNT", "UNTIL", "WKST"]);

/** Whether rrule.ts follows a rule: its parts, and a yearly rule's BYMONTH when it is the start's month. */
export function ruleSupported(rrule: string, start: IcsTime): boolean {
  if (!parseRRule(rrule)) return false;
  return rrule.split(";").every((seg) => {
    const [k, v = ""] = seg.split("=");
    const key = k.trim().toUpperCase();
    if (!key || PLAIN_PARTS.has(key)) return true;
    return key === "BYMONTH" && /FREQ=YEARLY/i.test(rrule) && Number(v) === Number(start.date.slice(5, 7));
  });
}

/** An occurrence's identity: its original start — a day for all-day, else the instant. */
function keyOf(t: IcsTime, local: string): string {
  return t.time ? `T${instantOf(t.date, t.time, t.zone, local)}` : `D${t.date}`;
}

/**
 * Every occurrence between two days (inclusive), on the `local` clock: repeats expanded, exceptions
 * and cancellations left out, moved or changed occurrences (RECURRENCE-ID) in their new place.
 */
export function expandIcs(events: IcsEvent[], fromISO: string, toISO: string, local: string): IcsOccurrence[] {
  const out: IcsOccurrence[] = [];
  const overrides = new Map<string, IcsEvent>();
  for (const e of events) if (e.recurrenceId) overrides.set(`${e.uid}|${keyOf(e.recurrenceId, local)}`, e);

  const place = (e: IcsEvent, start: IcsTime, recurring: boolean, unsupported: boolean) => {
    const base = { uid: e.uid, title: e.summary || "(untitled)", location: e.location, description: e.description, recurring, unsupported };
    if (!start.time) {
      // All-day: its own dates, through the day before DTEND (or for DURATION's days, else one).
      const days = e.end ? Math.max(1, dayCount(e.start.date, e.end.date)) : e.minutes ? Math.max(1, Math.round(e.minutes / 1440)) : 1;
      for (let i = 0; i < days; i++) {
        const day = shiftISO(start.date, i);
        if (day && day >= fromISO && day <= toISO) out.push({ ...base, date: day, allDay: true, start: null, end: null });
      }
      return;
    }
    const startMs = instantOf(start.date, start.time, start.zone, local);
    const minutes = e.end?.time ? (instantOf(e.end.date, e.end.time, e.end.zone, local) - instantOf(e.start.date, e.start.time!, e.start.zone, local)) / 60000 : e.minutes ?? 0;
    const s = clockIn(startMs, local);
    if (s.date < fromISO || s.date > toISO) return;
    const end = clockIn(startMs + Math.max(0, minutes) * 60000, local);
    // An event running past midnight is drawn to the end of its first day.
    out.push({ ...base, date: s.date, allDay: false, start: s.time, end: minutes <= 0 ? null : end.date === s.date ? end.time : "23:59" });
  };

  for (const e of events) {
    if (e.recurrenceId) continue; // placed with its series, below
    if (!e.rrule || !ruleSupported(e.rrule, e.start)) {
      if (!e.cancelled) place(e, e.start, false, !!e.rrule);
      continue;
    }
    const rule = parseRRule(e.rrule)!;
    // Dates on the series' own clock, with room either side for a zone's shift and a long event.
    const span = e.end && !e.start.time ? dayCount(e.start.date, e.end.date) : 1;
    const lo = parseISO(shiftISO(fromISO, -1 - span) ?? fromISO)!;
    const hi = parseISO(shiftISO(toISO, 1) ?? toISO)!;
    const ex = new Set(e.exdates.map((t) => keyOf(t, local)));
    const exDays = new Set(e.exdates.map((t) => t.date));
    for (const d of occurrencesInRange(rule, parseISO(e.start.date)!, lo, hi)) {
      const occ: IcsTime = { date: d.toISOString().slice(0, 10), time: e.start.time, zone: e.start.zone };
      const key = keyOf(occ, local);
      if (ex.has(key) || (!e.exdates.every((t) => t.time) && exDays.has(occ.date))) continue;
      const moved = overrides.get(`${e.uid}|${key}`);
      if (moved) {
        if (!moved.cancelled) place(moved, moved.start, true, false);
        continue;
      }
      if (!e.cancelled) place(e, occ, true, false);
    }
  }
  return out;
}

function dayCount(fromISO: string, toISO: string): number {
  const a = parseISO(fromISO);
  const b = parseISO(toISO);
  return a && b ? Math.round((b.getTime() - a.getTime()) / 86400000) : 1;
}
