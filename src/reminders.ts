// Reminder scheduling. No Obsidian imports → unit-testable.
//
// This is foreground-only by nature: the timer that drives it runs while Obsidian is open.
// When the app is closed — or backgrounded on Android — nothing ticks and nothing fires. That
// limit is real and stated in the docs; the logic here just has to behave sanely around it.
//
// Three rules do most of the work:
//
//  1. **Match a WINDOW, not an instant.** The tick is nominally every 30s but browsers throttle
//     timers freely, so `fireAt === now` would silently drop reminders. Anything whose fire time
//     falls in `(lastTick, now]` fires.
//  2. **Drop what's gone stale.** Opening Obsidian at 18:00 must not replay every reminder since
//     breakfast. Past the grace window a reminder is discarded, not fired late.
//  3. **Never fire the same thing twice**, including across a restart — hence ids that embed the
//     date, persisted, and pruned daily so the list can't grow forever.

export type ReminderKind = "lead" | "start" | "digest";

/** One thing capable of firing. `key` is identity; timing lives in `atMinutes`. */
export interface ReminderSource {
  key: string;
  title: string;
  /** e.g. "20:00–21:00 · Projects" */
  subtitle: string;
  path: string;
  /** Minutes-of-day the thing itself happens. */
  atMinutes: number;
  /** Per-item lead from `remind:`; null means use the global setting. */
  leadOverride: number | null;
  /** Per-item at-start override from `remind_start:`; null means use the global setting. */
  atStartOverride: boolean | null;
  /** `remind: none` — never remind about this, not even in the digest. */
  suppressed: boolean;
}

export interface DueReminder {
  id: string;
  kind: ReminderKind;
  source: ReminderSource;
  /** Minutes-of-day this reminder was scheduled for (not when it was noticed). */
  firedFor: number;
}

export interface ReminderOptions {
  /** Global lead time in minutes. */
  lead: number;
  /** Also fire as the thing starts. */
  atStart: boolean;
  /** How late a reminder may be and still fire. Beyond this it's dropped. */
  grace: number;
  /** Ids already fired — survives restarts. */
  fired: ReadonlySet<string>;
  /** Today, for id scoping. */
  todayISO: string;
}

/** Stable id: same reminder, same day → same id, so a restart can't re-fire it. */
export function reminderId(key: string, kind: ReminderKind, dateISO: string): string {
  return `${dateISO}|${kind}|${key}`;
}

/**
 * Read a `remind:` frontmatter value.
 * `none`/`off`/`false` → off · `30m`/`30`/`1h` → a custom lead · anything else → no opinion.
 */
export function parseRemindField(raw: unknown): { minutes: number | null; off: boolean } {
  if (raw == null || raw === "") return { minutes: null, off: false };
  const s = String(raw).trim().toLowerCase();
  if (s === "none" || s === "off" || s === "false" || s === "no") return { minutes: null, off: true };

  const m = /^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?$/.exec(s);
  if (!m) return { minutes: null, off: false };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return { minutes: null, off: false };
  const unit = m[2] ?? "m";
  const minutes = Math.round(unit.startsWith("h") ? n * 60 : n);
  return { minutes, off: false };
}

/**
 * Which reminders should fire for this tick.
 *
 * `window.from` is the previous tick and is EXCLUSIVE; `window.to` is now and is inclusive —
 * so a reminder is never fired twice by two adjacent ticks, and never skipped between them.
 */
export function dueReminders(
  sources: ReminderSource[],
  window: { from: number; to: number },
  opts: ReminderOptions
): DueReminder[] {
  const out: DueReminder[] = [];

  const consider = (source: ReminderSource, kind: ReminderKind, at: number) => {
    if (at > window.to) return; // still in the future
    // Below `from` it either already fired on an earlier tick, or predates this session —
    // either way only fire it if it's recent enough to still be worth saying.
    if (at <= window.from && window.to - at > opts.grace) return;
    if (window.to - at > opts.grace) return;
    const id = reminderId(source.key, kind, opts.todayISO);
    if (opts.fired.has(id)) return;
    out.push({ id, kind, source, firedFor: at });
  };

  for (const source of sources) {
    if (source.suppressed) continue;
    const lead = source.leadOverride ?? opts.lead;
    const atStart = source.atStartOverride ?? opts.atStart;
    if (lead > 0) consider(source, "lead", source.atMinutes - lead);
    if (atStart) consider(source, "start", source.atMinutes);
  }

  // Earliest first, so a burst arrives in the order the day runs.
  return out.sort((a, b) => a.firedFor - b.firedFor || a.source.title.localeCompare(b.source.title));
}

export interface DigestCounts {
  dueCount: number;
  overdueCount: number;
  /** From Brewin Habits' shared backlog note — unmet/missed habits. 0 if that plugin isn't
   *  installed, hasn't written yet, or cross-plugin reporting is turned off. */
  habitsBehindCount: number;
  /** From Brewin Fitness's shared backlog note — missed sessions in its trailing window. */
  fitnessMissedCount: number;
}

/**
 * The morning digest, as its own source. Kept separate from `dueReminders` because it isn't
 * tied to any one item — it's a summary that fires once at a fixed time. Fires on ANY nonzero
 * count, not just tasks — a clean task list with three habits behind still deserves a nudge.
 */
export function digestSource(atMinutes: number, counts: DigestCounts): ReminderSource | null {
  const { dueCount, overdueCount, habitsBehindCount, fitnessMissedCount } = counts;
  if (!dueCount && !overdueCount && !habitsBehindCount && !fitnessMissedCount) return null;
  const bits: string[] = [];
  if (overdueCount) bits.push(`${overdueCount} overdue`);
  if (dueCount) bits.push(`${dueCount} due today`);
  if (habitsBehindCount) bits.push(`${habitsBehindCount} habit${habitsBehindCount === 1 ? "" : "s"} behind`);
  if (fitnessMissedCount) bits.push(`${fitnessMissedCount} fitness session${fitnessMissedCount === 1 ? "" : "s"} missed`);
  return {
    key: "digest",
    title: "Today",
    subtitle: bits.join(" · "),
    path: "",
    atMinutes,
    leadOverride: 0, // the digest has no lead — it fires at its time
    atStartOverride: true,
    suppressed: false,
  };
}

/**
 * Read a `remind_start:` frontmatter value — the per-item override for the at-the-time
 * reminder. Absent means "no opinion", which defers to the global setting.
 */
export function parseRemindStart(raw: unknown): boolean | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "no" || s === "off") return false;
  return null;
}

/**
 * The exact times an item will fire, for showing in the edit window. Empty when it's
 * silenced. Minutes-of-day, earliest first.
 */
export function previewTimes(
  atMinutes: number,
  leadOverride: number | null,
  atStartOverride: boolean | null,
  suppressed: boolean,
  globalLead: number,
  globalAtStart: boolean
): { minutes: number; kind: ReminderKind }[] {
  if (suppressed) return [];
  const out: { minutes: number; kind: ReminderKind }[] = [];
  const lead = leadOverride ?? globalLead;
  if (lead > 0 && atMinutes - lead >= 0) out.push({ minutes: atMinutes - lead, kind: "lead" });
  if (atStartOverride ?? globalAtStart) out.push({ minutes: atMinutes, kind: "start" });
  return out;
}

/** Drop fired-ids that aren't from today, so the persisted list stays small. */
export function pruneFired(fired: string[], todayISO: string): string[] {
  return fired.filter((id) => id.startsWith(todayISO + "|"));
}

/** "in 10 minutes" · "now" · "10 minutes ago" — the popup's lead line. */
export function relativeLabel(kind: ReminderKind, source: ReminderSource, lead: number): string {
  if (kind === "digest") return "Today";
  if (kind === "start") return "Starting now";
  const mins = source.leadOverride ?? lead;
  if (mins <= 0) return "Starting now";
  if (mins === 60) return "In 1 hour";
  if (mins % 60 === 0) return `In ${mins / 60} hours`;
  return `In ${mins} minutes`;
}
