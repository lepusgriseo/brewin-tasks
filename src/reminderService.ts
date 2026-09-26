import { Notice, Platform } from "obsidian";
import { minutesOfDay, nowMinutes, todayISO } from "./dates";
import { eventsToItems } from "./calendarItem";
import { todayAgenda } from "./views";
import {
  digestSource,
  dueReminders,
  DueReminder,
  parseRemindField,
  pruneFired,
  relativeLabel,
  ReminderSource,
} from "./reminders";
import type BrewinTasksPlugin from "./main";

const TICK_MS = 30_000;
const SNOOZE_MINUTES = 10;

/**
 * Fires reminders while Obsidian is open.
 *
 * **Foreground only, by construction.** The driving timer stops when the app is closed or
 * backgrounded on Android — there's no background execution available to a plugin, so this
 * complements an external nudge rather than replacing one.
 *
 * The scheduling decisions all live in the pure `reminders.ts`; this class only deals with
 * the parts that need Obsidian or the DOM: gathering sources, showing the popup, and sound.
 */
export class ReminderService {
  /** Minutes-of-day of the previous tick — the lower bound of the fire window. */
  private lastTick: number | null = null;
  private lastDay = "";
  /** Cached sources, rebuilt on day change or vault edit rather than every tick. */
  private sources: ReminderSource[] = [];
  private stale = true;
  /** Snoozed reminders, in memory only — a snooze shouldn't outlive the session. */
  private snoozed: { at: number; due: DueReminder }[] = [];

  private audio: AudioContext | null = null;

  constructor(private plugin: BrewinTasksPlugin) {}

  start(): void {
    this.plugin.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
    // An AudioContext starts suspended until a user gesture, so the first chime of a session
    // would be silently swallowed. Unlock on the first interaction and keep it alive.
    this.plugin.registerDomEvent(document, "pointerdown", () => this.unlockAudio(), { capture: true });
    this.plugin.registerDomEvent(document, "keydown", () => this.unlockAudio(), { capture: true });
  }

  /** Called by the plugin's vault-change hook — cheaper than re-scanning every 30s. */
  markStale(): void {
    this.stale = true;
  }

  // ── the tick ───────────────────────────────────────────────────────────────

  private tick(): void {
    const s = this.plugin.settings;
    if (!s.remindersEnabled) return;

    const today = todayISO();
    const now = nowMinutes();

    if (today !== this.lastDay) {
      // New day: yesterday's fired-ids are dead weight, and the sources are all stale.
      this.lastDay = today;
      this.stale = true;
      this.snoozed = [];
      this.lastTick = null;
      void this.persistFired(pruneFired(s.remindersFired, today));
    }

    // First tick of a session has no previous bound. Look back only as far as the grace
    // window, so opening the app doesn't replay the whole morning.
    const from = this.lastTick ?? now - s.reminderGraceMinutes;
    this.lastTick = now;
    if (now < from) return; // clock went backwards (DST/manual change) — skip this tick

    if (this.stale) {
      this.sources = this.buildSources(today);
      this.stale = false;
    }

    const fired = new Set(s.remindersFired);
    const due = dueReminders(this.sources, { from, to: now }, {
      lead: s.reminderLeadMinutes,
      atStart: s.reminderAtStart,
      grace: s.reminderGraceMinutes,
      fired,
      todayISO: today,
    });

    // Snoozed reminders are re-raised by time, independent of the source list.
    const wokenUp = this.snoozed.filter((sn) => sn.at <= now);
    this.snoozed = this.snoozed.filter((sn) => sn.at > now);

    if (!due.length && !wokenUp.length) return;

    for (const d of due) this.fire(d);
    for (const sn of wokenUp) this.fire(sn.due, true);

    if (due.length) {
      void this.persistFired([...s.remindersFired, ...due.map((d) => d.id)]);
    }
  }

  private async persistFired(ids: string[]): Promise<void> {
    this.plugin.settings.remindersFired = [...new Set(ids)];
    await this.plugin.saveSettings();
  }

  // ── sources ────────────────────────────────────────────────────────────────

  /**
   * Everything today that could fire, derived from `todayAgenda` so reminders can't disagree
   * with what the Today view shows.
   */
  private buildSources(today: string): ReminderSource[] {
    const tasks = this.plugin.store.getTasks();
    const events = this.plugin.events.getEvents();
    const agenda = todayAgenda(tasks, eventsToItems(events, today, today), today);

    const byPath = new Map(tasks.map((t) => [t.path, t]));
    const eventByPath = new Map(events.map((e) => [e.path, e]));
    const out: ReminderSource[] = [];

    for (const row of agenda.timed) {
      if (row.done) continue; // already ticked — nothing to remind about
      const at = minutesOfDay(row.time);
      if (at == null) continue;

      const owner = row.kind === "event" ? eventByPath.get(row.path) : byPath.get(row.path);
      const { minutes, off } = parseRemindField(owner?.remind);

      out.push({
        key: `${row.path}|${today}|${row.slotTime ?? row.time}`,
        title: row.title,
        subtitle: [row.endTime ? `${row.time}–${row.endTime}` : row.time, row.kind === "event" ? "event" : "task"]
          .filter(Boolean)
          .join(" · "),
        path: row.path,
        atMinutes: at,
        leadOverride: minutes,
        atStartOverride: owner?.remindStart ?? null,
        suppressed: off,
      });
    }

    // Morning digest of what's waiting, as its own pseudo-source. Folds in the sibling plugins'
    // backlog too, unless that's been turned off.
    const digestAt = minutesOfDay(this.plugin.settings.reminderDigestTime);
    if (digestAt != null) {
      const dueToday = agenda.anytime.length + agenda.timed.filter((r) => r.kind !== "event" && !r.done).length;
      const cross = this.plugin.settings.digestIncludeCrossPlugin;
      const habits = cross ? this.plugin.backlog.readHabitsBacklog() : { dueUnmetCount: 0, backlogDays: 0 };
      const fitness = cross ? this.plugin.backlog.readFitnessBacklog() : { missedSessionsCount: 0 };
      const digest = digestSource(digestAt, {
        dueCount: dueToday,
        overdueCount: agenda.overdue.length,
        habitsBehindCount: habits.dueUnmetCount + habits.backlogDays,
        fitnessMissedCount: fitness.missedSessionsCount,
      });
      if (digest) out.push(digest);
    }

    return out;
  }

  // ── firing ─────────────────────────────────────────────────────────────────

  private fire(due: DueReminder, snoozed = false): void {
    const s = this.plugin.settings;
    const lead = relativeLabel(due.kind, due.source, s.reminderLeadMinutes);

    const frag = document.createDocumentFragment();
    const wrap = frag.createDiv({ cls: "brewin-reminder" });
    wrap.createDiv({
      cls: "brewin-reminder-lead",
      text: `⏰ ${snoozed ? "Snoozed · " : ""}${lead}`,
    });
    wrap.createDiv({ cls: "brewin-reminder-title", text: due.source.title });
    if (due.source.subtitle) wrap.createDiv({ cls: "brewin-reminder-sub", text: due.source.subtitle });

    // duration 0 → the notice stays until it's acted on, which is the whole point.
    const notice = new Notice(frag, 0);
    const actions = wrap.createDiv({ cls: "brewin-reminder-actions" });

    if (due.source.path) {
      actions.createEl("button", { text: "Open" }).addEventListener("click", () => {
        notice.hide();
        void this.plugin.openPath(due.source.path);
      });
    }
    actions.createEl("button", { text: `Snooze ${SNOOZE_MINUTES}m` }).addEventListener("click", () => {
      notice.hide();
      this.snoozed.push({ at: nowMinutes() + SNOOZE_MINUTES, due });
    });
    actions.createEl("button", { text: "✕" }).addEventListener("click", () => notice.hide());

    if (s.reminderSound) this.playChime();
    if (s.reminderVibrate) {
      try {
        navigator.vibrate?.([120, 80, 120]);
      } catch {
        /* unsupported — the popup and tone carry it */
      }
    }
    if (s.reminderSystemNotification && Platform.isDesktopApp) {
      // Reaches the user when Obsidian is running but not the focused window — something
      // an in-app notice structurally cannot do.
      try {
        new Notification(`${lead} — ${due.source.title}`, { body: due.source.subtitle });
      } catch {
        /* no permission or no support — the in-app popup already fired */
      }
    }
  }

  // ── sound ──────────────────────────────────────────────────────────────────

  private unlockAudio(): void {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      if (!this.audio) this.audio = new Ctor();
      if (this.audio.state === "suspended") void this.audio.resume();
    } catch {
      /* audio simply isn't available here */
    }
  }

  /** Two short notes, synthesised — no asset to bundle or path to get wrong. */
  private playChime(): void {
    this.unlockAudio();
    const ctx = this.audio;
    if (!ctx || ctx.state !== "running") return; // never throw over a sound

    try {
      const now = ctx.currentTime;
      [880, 1174.7].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const at = now + i * 0.16;
        // A short envelope rather than a raw square edge, which clicks.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 0.24);
      });
    } catch {
      /* ignore — a failed chime must never break the reminder */
    }
  }

  /** Fire a sample reminder so the user can check sound and permissions. */
  testFire(): void {
    this.fire({
      id: "test",
      kind: "lead",
      firedFor: nowMinutes(),
      source: {
        key: "test",
        title: "Test reminder",
        subtitle: "This is what a reminder looks like",
        path: "",
        atMinutes: nowMinutes(),
        leadOverride: this.plugin.settings.reminderLeadMinutes,
        atStartOverride: null,
        suppressed: false,
      },
    });
  }
}
