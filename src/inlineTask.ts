// A checkbox line in a note — a project's step, a task in a day note — read, and written back in the
// way that line already writes its dates. Two ways live in this vault:
//   Dataview fields   `- [ ] Book train [scheduled:: 2026-11-02] [due:: 2026-11-06]`  (298 notes)
//   Tasks-plugin emoji `- [ ] Book train ⏳ 2026-11-02 📅 2026-11-06`                 (92 notes)
// A line with any emoji date keeps emoji; every other line gets Dataview fields. Everything the
// Planner doesn't change — other fields, tags, priority emoji, comments — is left exactly as it was.
// Pure, no Obsidian imports.

import { coerceISO } from "./dates";

export type InlineDateField = "scheduled" | "due" | "start" | "completed";

export interface InlineTask {
  indent: string;
  /** `-`, `*`, `+` or `1.` — written back as it was. */
  bullet: string;
  /** The box's character: " " open, "x" done; anything else ("-", "/") as written. */
  mark: string;
  done: boolean;
  /** What the step says, for showing: its date fields, `#next` and comments taken out. */
  text: string;
  scheduled: string | null;
  due: string | null;
  start: string | null;
  completed: string | null;
  next: boolean;
  style: "dataview" | "emoji";
}

/** What to change on a line. `undefined` leaves a field as it is; null takes a date off. */
export interface InlineChanges {
  text?: string;
  scheduled?: string | null;
  due?: string | null;
  start?: string | null;
  done?: boolean;
  next?: boolean;
}

const LINE = /^(\s*)([-*+]|\d+[.)])\s+\[(.)\]\s?(.*)$/;

const DATAVIEW_KEY: Record<InlineDateField, string> = { scheduled: "scheduled", due: "due", start: "start", completed: "completion" };
const EMOJI: Record<InlineDateField, string> = { scheduled: "⏳", due: "📅", start: "🛫", completed: "✅" };
const FIELDS = Object.keys(DATAVIEW_KEY) as InlineDateField[];

/** `[due:: 2026-11-06]` or `(due:: …)`, for one field. */
const dataviewField = (f: InlineDateField) => new RegExp(`\\s*[\\[(]\\s*${DATAVIEW_KEY[f]}\\s*::\\s*([^\\])]*?)\\s*[\\])]`, "gi");
/** `📅 2026-11-06`, for one field (an optional variation selector after the emoji). */
const emojiField = (f: InlineDateField) => new RegExp(`\\s*${EMOJI[f]}\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})`, "g");
const ANY_EMOJI_DATE = /(⏳|📅|🛫|✅)\uFE0F?\s*\d{4}-\d{2}-\d{2}/;
const NEXT = /(^|\s)#next\b/;

/** The checkbox line as a task, or null for a line that isn't one. */
export function parseInlineTask(line: string): InlineTask | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const [, indent, bullet, mark, body] = m;
  const read = (f: InlineDateField): string | null => {
    const dv = dataviewField(f).exec(body);
    if (dv) return coerceISO(dv[1]);
    const em = emojiField(f).exec(body);
    return em ? coerceISO(em[1]) : null;
  };
  return {
    indent,
    bullet,
    mark,
    done: mark.toLowerCase() === "x",
    text: displayText(body),
    scheduled: read("scheduled"),
    due: read("due"),
    start: read("start"),
    completed: read("completed"),
    next: NEXT.test(body),
    style: ANY_EMOJI_DATE.test(body) ? "emoji" : "dataview",
  };
}

/** The words of a step: no comments, no inline fields (any key), no emoji dates, no `#next`. */
/** A line of a note, as "Make this line a Planner task" reads it. */
export interface LineTask {
  /** Its words, as written — links and all. */
  words: string;
  scheduled: string | null;
  due: string | null;
  /** What stays in front of the link that replaces it: its indent and bullet. A box is dropped —
   *  the task note is where it is ticked from then on. */
  lead: string;
}

/** Null for a blank line, a heading, a fence or rule, a ticked box, or a line that is only a link. */
export function lineAsTask(line: string): LineTask | null {
  const onlyLink = (s: string) => /^(\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]*\))$/.test(s);
  if (/^\s*(#{1,6}\s|```|~~~|---\s*$|\|)/.test(line)) return null;
  const boxed = parseInlineTask(line);
  // A plain bullet or paragraph is read as though it had a box, so its date fields are found too.
  const m = /^(\s*)(?:([-*+]|\d+[.)])\s+)?(.*)$/.exec(line)!;
  const t = boxed ?? parseInlineTask(`${m[1]}${m[2] ?? "-"} [ ] ${m[3]}`);
  const words = t?.text.replace(/\s+/g, " ").trim();
  if (!t || t.done || !words || onlyLink(words)) return null;
  return { words, scheduled: t.scheduled, due: t.due, lead: boxed ? `${t.indent}${t.bullet} ` : m[1] + (m[2] ? `${m[2]} ` : "") };
}

export function displayText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[[(][\w -]+::[^\])]*[\])]/g, "")
    .replace(/(⏳|📅|🛫|✅|➕|❌)\uFE0F?\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(NEXT, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Take one date field out of a body, in either style. */
function withoutField(body: string, f: InlineDateField): string {
  return body.replace(dataviewField(f), "").replace(emojiField(f), "");
}

/** Add one date field to the end of a body, in the given style. */
function withField(body: string, f: InlineDateField, iso: string, style: InlineTask["style"]): string {
  const token = style === "emoji" ? `${EMOJI[f]} ${iso}` : `[${DATAVIEW_KEY[f]}:: ${iso}]`;
  return `${body.replace(/\s+$/, "")} ${token}`;
}

/**
 * The line with the changes made. Ticking adds today's completion date, unticking takes it off.
 * Returns the line unchanged when it isn't a checkbox line.
 */
export function writeInlineTask(line: string, ch: InlineChanges, todayISO: string): string {
  const t = parseInlineTask(line);
  const m = LINE.exec(line);
  if (!t || !m) return line;
  let body = m[4];

  if (ch.text !== undefined) {
    // New words, keeping every token that isn't words: fields, emoji dates, comments, #next.
    const keep = [
      ...body.matchAll(/<!--[\s\S]*?-->|[[(][\w -]+::[^\])]*[\])]|(?:⏳|📅|🛫|✅|➕|❌)\uFE0F?\s*\d{4}-\d{2}-\d{2}|#next\b/g),
    ].map((x) => x[0]);
    body = [ch.text.trim(), ...keep].filter(Boolean).join(" ");
  }

  const dates: Partial<Record<InlineDateField, string | null>> = {};
  if (ch.scheduled !== undefined) dates.scheduled = ch.scheduled;
  if (ch.due !== undefined) dates.due = ch.due;
  if (ch.start !== undefined) dates.start = ch.start;
  let mark = t.mark;
  if (ch.done === true && !t.done) {
    mark = "x";
    dates.completed = todayISO;
  } else if (ch.done === false && t.done) {
    mark = " ";
    dates.completed = null;
  }
  for (const f of FIELDS) {
    if (!(f in dates)) continue;
    body = withoutField(body, f);
    const iso = dates[f];
    if (iso) body = withField(body, f, iso, t.style);
  }

  if (ch.next === true && !t.next) body = `${body.replace(/\s+$/, "")} #next`;
  if (ch.next === false && t.next) body = body.replace(/\s*#next\b/, "");

  return `${t.indent}${t.bullet} [${mark}] ${body.replace(/\s+$/, "")}`;
}
