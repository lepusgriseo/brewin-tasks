// Attributes of the user's own on tasks — "Cost", "Client", "Where", "Energy", "Needs parts" — made
// from the task window and listed in settings. Each is one frontmatter property on the task note,
// under a key fixed when the attribute is made (renaming it later loses nothing), in one of six
// kinds. Pure, no Obsidian imports.

export type AttrKind = "text" | "number" | "date" | "choice" | "bool" | "link";

export interface TaskAttribute {
  /**
   * The frontmatter key. A new name becomes lower case with underscores (`needs_parts`); a property
   * the notes already use keeps its own spelling (`Cost`). Fixed once made.
   */
  key: string;
  label: string;
  /** An emoji or short symbol for chips and the menu. */
  icon: string;
  kind: AttrKind;
  /** Numbers only: "£" or "$" is written before the value, anything else ("km", "kg") after. */
  unit?: string;
  /** Choices only, in the order offered. */
  options?: string[];
  /** Show the value as a chip on the task's row. */
  onRow: boolean;
}

/** A value as the Planner holds it: text (choice, date as ISO, link as `[[Note]]`), number or yes/no. */
export type AttrValue = string | number | boolean;

export const ATTR_KINDS: { kind: AttrKind; label: string; icon: string; hint: string }[] = [
  { kind: "text", label: "Text", icon: "🏷", hint: "any words — a room, a reference" },
  { kind: "number", label: "Number", icon: "#️⃣", hint: "a cost, a distance — with a unit if you like" },
  { kind: "date", label: "Date", icon: "📆", hint: "a day other than scheduled and due — ordered by, delivered" },
  { kind: "choice", label: "Choice", icon: "🔘", hint: "one of a list you keep — low / medium / high" },
  { kind: "bool", label: "Yes / no", icon: "☑️", hint: "a tick — needs parts, paid" },
  { kind: "link", label: "Link to a note", icon: "🔗", hint: "a person, a place, a client" },
];

/** Keys the Planner (or Obsidian) already uses on a task note — an attribute can't take one. */
export const RESERVED_KEYS = new Set([
  "title", "status", "flag", "scheduled", "endDate", "startTime", "endTime", "due", "priority", "estimate",
  "remind", "remind_start", "contexts", "recurrence", "recurrence_anchor", "complete_instances",
  "recurrence_exdates", "recurrence_from", "times", "complete_slots", "on_completion", "created", "completed", "parent",
  "depends_on", "project", "month", "week", "time_log", "time_spent", "timer_started", "modified", "top",
  "tags", "aliases", "cssclasses", "cssclass", "up", "publish", "position",
].map((k) => k.toLowerCase()));

/** "Needs parts!" → "needs_parts". */
export function attrKeyFrom(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** A key for a new attribute: from its name, never a reserved key or one already taken. */
export function uniqueAttrKey(label: string, existing: readonly TaskAttribute[]): string {
  const base = attrKeyFrom(label) || "attribute";
  const taken = new Set([...RESERVED_KEYS, ...existing.map((a) => a.key)]);
  let key = taken.has(base) ? `${base}_2` : base;
  for (let n = 3; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

const KINDS = ATTR_KINDS.map((k) => k.kind);

/** A property name usable as it stands: not empty, and nothing YAML would read as structure. */
const PLAIN_KEY = /^[^:#\n\[\]{}"'`|>&*!%@,]+$/;

/** Saved attributes, as settings hold them — malformed entries dropped, a key kept once. */
export function sanitizeAttributes(raw: unknown): TaskAttribute[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskAttribute[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const given = String(o.key ?? "").trim();
    const key = PLAIN_KEY.test(given) ? given : attrKeyFrom(given);
    const kind = KINDS.includes(o.kind as AttrKind) ? (o.kind as AttrKind) : null;
    if (!key || !kind || RESERVED_KEYS.has(key.toLowerCase()) || out.some((a) => a.key.toLowerCase() === key.toLowerCase())) continue;
    const a: TaskAttribute = {
      key,
      label: String(o.label ?? "").trim() || key,
      icon: String(o.icon ?? "").trim() || ATTR_KINDS.find((k) => k.kind === kind)!.icon,
      kind,
      onRow: o.onRow !== false,
    };
    if (kind === "number" && typeof o.unit === "string" && o.unit.trim()) a.unit = o.unit.trim();
    if (kind === "choice") a.options = Array.isArray(o.options) ? [...new Set(o.options.map((x) => String(x).trim()).filter(Boolean))] : [];
    out.push(a);
  }
  return out;
}

/** A frontmatter value read as this attribute's kind, or null when empty or unreadable. */
export function readAttr(attr: TaskAttribute, raw: unknown): AttrValue | null {
  if (raw == null || raw === "") return null;
  if (Array.isArray(raw)) return raw.length ? readAttr(attr, raw[0]) : null;
  switch (attr.kind) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[,\s£$€¥]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "bool":
      if (typeof raw === "boolean") return raw;
      return /^(true|yes|y|1)$/i.test(String(raw).trim()) ? true : /^(false|no|n|0)$/i.test(String(raw).trim()) ? false : null;
    case "date": {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw).trim());
      return m ? m[1] : null;
    }
    case "link": {
      const t = String(raw).trim();
      return t ? (t.startsWith("[[") ? t : `[[${t}]]`) : null;
    }
    default: {
      const t = String(raw).trim();
      return t || null;
    }
  }
}

/** Every attribute's value on one note, keyed by attribute key; empty ones left out. */
export function readAttrs(attrs: readonly TaskAttribute[], fm: Record<string, unknown>): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const a of attrs) {
    const v = readAttr(a, fm[a.key]);
    if (v !== null) out[a.key] = v;
  }
  return out;
}

/** What typing in the task window means for this attribute: a value, or null to clear it. */
export function parseAttrInput(attr: TaskAttribute, input: string | boolean): AttrValue | null {
  if (typeof input === "boolean") return attr.kind === "bool" ? input : null;
  return readAttr(attr, input.trim());
}

/** A link's note name: `[[People/Mum|Mum]]` → "Mum". */
export function linkName(v: string): string {
  const inner = v.replace(/^\[\[|\]\]$/g, "");
  const [target, alias] = inner.split("|");
  return (alias ?? target.split("/").pop() ?? target).trim();
}

/** A value as shown on a chip, in the menu, or in a group heading. */
export function formatAttr(attr: TaskAttribute, v: AttrValue): string {
  switch (attr.kind) {
    case "number": {
      const n = Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
      if (!attr.unit) return n;
      return /^[£$€¥₹₩]$/.test(attr.unit) ? `${attr.unit}${n}` : `${n} ${attr.unit}`;
    }
    case "bool":
      return v ? "Yes" : "No";
    case "date": {
      const d = new Date(`${v}T12:00:00`);
      return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    }
    case "link":
      return linkName(String(v));
    default:
      return String(v);
  }
}

/** The row chip: "💷 £120", "🏷 Mum" — and a yes/no attribute only when ticked, by its name. */
export function attrChip(attr: TaskAttribute, v: AttrValue): string | null {
  if (attr.kind === "bool") return v ? `${attr.icon} ${attr.label}` : null;
  return `${attr.icon} ${formatAttr(attr, v)}`;
}

/**
 * The value a menu entry and a filter stand for: a choice, a link's note or text as itself (case
 * ignored), a yes/no as "yes", and any number or date as "any" — every value of those is different,
 * so the menu offers just "has one".
 */
export function filterValue(attr: TaskAttribute, v: AttrValue): string | null {
  if (attr.kind === "bool") return v ? "yes" : null;
  if (attr.kind === "number" || attr.kind === "date") return "any";
  if (attr.kind === "link") return linkName(String(v)).toLowerCase();
  return String(v).trim().toLowerCase();
}

/** Does a task's value for this attribute match a filter value? */
export function attrMatches(attr: TaskAttribute, values: Record<string, AttrValue> | undefined, want: string): boolean {
  const v = values?.[attr.key];
  if (v === undefined) return false;
  return filterValue(attr, v) === want.toLowerCase();
}

/**
 * The menu's entries for one attribute: each value open tasks carry, with how many, most first
 * (choices in their own order). `label` is how to show it.
 */
export function attrMenuValues(
  attr: TaskAttribute,
  tasks: readonly { status: string; attrs?: Record<string, AttrValue> }[]
): { value: string; label: string; count: number }[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const t of tasks) {
    if (t.status === "done") continue;
    const v = t.attrs?.[attr.key];
    if (v === undefined) continue;
    const key = filterValue(attr, v);
    if (key === null) continue;
    const label = key === "any" ? "Has one" : key === "yes" && attr.kind === "bool" ? "Yes" : formatAttr(attr, v);
    const e = counts.get(key) ?? { label, count: 0 };
    e.count++;
    counts.set(key, e);
  }
  const rows = [...counts].map(([value, e]) => ({ value, ...e }));
  if (attr.kind === "choice") {
    const order = (attr.options ?? []).map((o) => o.toLowerCase());
    const rank = (v: string) => (order.indexOf(v) < 0 ? 999 : order.indexOf(v));
    return rows.sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label));
  }
  return rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * All, grouped by one attribute: a group per value (choices in their order, numbers and dates
 * ascending, the rest alphabetically), and the tasks without one last. Done tasks are left out.
 */
export function groupByAttr<T extends { status: string; title: string; scheduled: string | null; attrs?: Record<string, AttrValue> }>(
  attr: TaskAttribute,
  tasks: readonly T[]
): { label: string | null; tasks: T[] }[] {
  const groups = new Map<string, { label: string; sort: string | number; tasks: T[] }>();
  const none: T[] = [];
  const order = (attr.options ?? []).map((o) => o.toLowerCase());
  for (const t of tasks) {
    if (t.status === "done") continue;
    const v = t.attrs?.[attr.key];
    if (v === undefined) {
      none.push(t);
      continue;
    }
    const id = attr.kind === "link" ? linkName(String(v)).toLowerCase() : String(v).toLowerCase();
    const sort =
      attr.kind === "number" ? Number(v) : attr.kind === "choice" ? (order.indexOf(id) < 0 ? 999 : order.indexOf(id)) : attr.kind === "bool" ? (v ? 0 : 1) : id;
    const g = groups.get(id) ?? { label: formatAttr(attr, v), sort, tasks: [] };
    g.tasks.push(t);
    groups.set(id, g);
  }
  const byDate = (a: T, b: T) => (a.scheduled ?? "9999").localeCompare(b.scheduled ?? "9999") || a.title.localeCompare(b.title);
  const out: { label: string | null; tasks: T[] }[] = [...groups.values()]
    .sort((a, b) => (typeof a.sort === "number" && typeof b.sort === "number" ? a.sort - b.sort : String(a.sort).localeCompare(String(b.sort))))
    .map((g) => ({ label: g.label, tasks: g.tasks.sort(byDate) }));
  if (none.length) out.push({ label: null, tasks: none.sort(byDate) });
  return out;
}

/** What `fm[key]` should hold for a value: dates and text as text, a link as `[[Note]]`. */
export function attrToFrontmatter(attr: TaskAttribute, v: AttrValue): AttrValue {
  if (attr.kind === "number") return Number(v);
  if (attr.kind === "bool") return !!v;
  return String(v);
}

// ── Properties the notes already have ────────────────────────────────────────
// Making an attribute first looks for a property of the same name: on task notes its values will
// show straight away, and anywhere in the vault Obsidian already holds one type for that name.

export interface PropertyUse {
  /** The name as the notes spell it — the most common spelling when they differ. */
  key: string;
  /** Task notes carrying it, and other notes in the vault. */
  taskNotes: number;
  otherNotes: number;
  /** A few values from task notes (else from other notes), to show and to guess the kind from. */
  samples: unknown[];
}

/**
 * Every property on the notes that isn't the Planner's own or already an attribute, by lower-case
 * name. `tasks` and `others` are frontmatter records.
 */
export function scanProperties(
  tasks: readonly Record<string, unknown>[],
  others: readonly Record<string, unknown>[],
  attributes: readonly TaskAttribute[]
): Map<string, PropertyUse> {
  const taken = new Set(attributes.map((a) => a.key.toLowerCase()));
  const out = new Map<string, PropertyUse & { spellings: Map<string, number>; otherSamples: unknown[] }>();
  const add = (fm: Record<string, unknown>, isTask: boolean) => {
    for (const [k, v] of Object.entries(fm)) {
      const lower = k.toLowerCase();
      if (RESERVED_KEYS.has(lower) || taken.has(lower) || !PLAIN_KEY.test(k)) continue;
      const u = out.get(lower) ?? { key: k, taskNotes: 0, otherNotes: 0, samples: [], spellings: new Map(), otherSamples: [] };
      u.spellings.set(k, (u.spellings.get(k) ?? 0) + 1);
      if (isTask) u.taskNotes++;
      else u.otherNotes++;
      const pool = isTask ? u.samples : u.otherSamples;
      if (v != null && v !== "" && pool.length < 12) pool.push(v);
      out.set(lower, u);
    }
  };
  for (const fm of tasks) add(fm, true);
  for (const fm of others) add(fm, false);
  const result = new Map<string, PropertyUse>();
  for (const [lower, u] of out) {
    const key = [...u.spellings].sort((a, b) => b[1] - a[1])[0][0];
    result.set(lower, { key, taskNotes: u.taskNotes, otherNotes: u.otherNotes, samples: u.samples.length ? u.samples : u.otherSamples });
  }
  return result;
}

/** The property a new attribute's name refers to: the same name, ignoring case, spaces and punctuation. */
export function findProperty(uses: ReadonlyMap<string, PropertyUse>, label: string): PropertyUse | null {
  const want = label.trim().toLowerCase();
  if (!want) return null;
  if (uses.has(want)) return uses.get(want)!;
  const slug = attrKeyFrom(label);
  for (const [lower, u] of uses) if (attrKeyFrom(lower) === slug) return u;
  return null;
}

/** Obsidian's own type for a property, where it has assigned one, as an attribute kind. */
const OBSIDIAN_TYPES: Record<string, AttrKind> = { checkbox: "bool", number: "number", date: "date", datetime: "date" };

/**
 * The kind a property's values look like: Obsidian's assigned type first (it holds one per name for
 * the whole vault), else the values — yes/no, numbers, dates, links, a handful of repeated words (a
 * choice, with those as its options), or text.
 */
export function inferKind(samples: readonly unknown[], obsidianType?: string | null): { kind: AttrKind; options?: string[] } {
  if (obsidianType && OBSIDIAN_TYPES[obsidianType]) return { kind: OBSIDIAN_TYPES[obsidianType] };
  const vals = samples.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v != null && v !== "");
  if (!vals.length) return { kind: "text" };
  if (vals.every((v) => typeof v === "boolean" || /^(true|false)$/i.test(String(v)))) return { kind: "bool" };
  if (vals.every((v) => typeof v === "number" || /^-?[£$€]?\d[\d,]*(\.\d+)?$/.test(String(v).trim()))) return { kind: "number" };
  if (vals.every((v) => /^\d{4}-\d{2}-\d{2}/.test(String(v)))) return { kind: "date" };
  if (vals.every((v) => /^\[\[.+\]\]$/.test(String(v).trim()))) return { kind: "link" };
  const distinct = [...new Set(vals.map((v) => String(v).trim()))];
  if (vals.length >= 3 && distinct.length <= 6 && distinct.length < vals.length && distinct.every((d) => d.length <= 24)) {
    return { kind: "choice", options: distinct };
  }
  return { kind: "text" };
}
