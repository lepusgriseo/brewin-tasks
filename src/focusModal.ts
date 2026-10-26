// A task's focus window: its clock, start / pause / done, the time logged against the estimate, and
// every session (editable, and time can be added by hand). Closing it while its clock runs asks
// first — the point is to stay on the task — but leaving never stops the clock: the floating timer
// (floatingTimer.ts) takes over and brings this window back.

import { App, EventRef, Modal, Notice, TFile } from "obsidian";
import type BrewinTasksPlugin from "./main";
import { ConfirmModal } from "./confirmModal";
import { PromptModal } from "./promptModal";
import { formatEstimate } from "./estimate";
import { todayISO } from "./dates";
import { clockText, minutesInRange, minutesText, parseManualSession, TimeSession, totalMinutes } from "./timeTrack";
import { relativeDay } from "./status";

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayLabel = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};

export class FocusModal extends Modal {
  /** The focus window showing now, if any — the floating timer hides while it is. */
  static current: FocusModal | null = null;

  private leaving = false;
  private tick: number | null = null;
  private clockEl: HTMLElement | null = null;
  private stateEl: HTMLElement | null = null;
  private offTimer: (() => void) | null = null;
  private cacheRef: EventRef | null = null;
  private showAll = false;

  constructor(app: App, private plugin: BrewinTasksPlugin, readonly path: string) {
    super(app);
  }

  onOpen(): void {
    FocusModal.current = this;
    this.modalEl.addClass("brewin-focus-modal");
    this.plugin.floating.update();
    this.offTimer = this.plugin.timer.onChange(() => this.render());
    // Sessions are read from the note, so redraw once a write of ours has reached the cache.
    this.cacheRef = this.app.metadataCache.on("changed", (file: TFile) => {
      if (file.path === this.path) this.render();
    });
    // The clock every second; the figures under it (which count the running session) every minute.
    let ticks = 0;
    this.tick = window.setInterval(() => {
      if (++ticks % 60 === 0 && this.plugin.timer.isRunning(this.path)) this.render();
      else this.paintClock();
    }, 1000);
    this.render();
  }

  /** Every way out — ✕, Escape, a tap outside, the phone's back gesture — comes through here. */
  close(): void {
    this.closeThen();
  }

  /** Close, asking first while this task's clock runs; `after` happens only if the window does close. */
  private closeThen(after?: () => void): void {
    if (!this.leaving && this.plugin.settings.timerConfirmLeave && this.plugin.timer.isRunning(this.path)) {
      new LeaveModal(this.app, this.title(), () => {
        this.leaving = true;
        super.close();
        after?.();
      }).open();
      return;
    }
    super.close();
    after?.();
  }

  onClose(): void {
    if (this.tick !== null) window.clearInterval(this.tick);
    this.offTimer?.();
    if (this.cacheRef) this.app.metadataCache.offref(this.cacheRef);
    if (FocusModal.current === this) FocusModal.current = null;
    this.contentEl.empty();
    this.plugin.floating.update();
  }

  private title(): string {
    return this.plugin.store.getByPath(this.path)?.title ?? this.path.split("/").pop()!.replace(/\.md$/, "");
  }

  private paintClock(): void {
    const timer = this.plugin.timer;
    const mine = timer.isRunning(this.path);
    this.clockEl?.setText(clockText(mine ? timer.elapsed() : 0));
    this.clockEl?.toggleClass("is-running", mine);
  }

  private render(): void {
    const task = this.plugin.store.getByPath(this.path);
    const { contentEl } = this;
    contentEl.empty();
    if (!task) {
      contentEl.createEl("p", { text: "This task's note has gone — it was deleted or renamed." });
      return;
    }
    const timer = this.plugin.timer;
    const mine = timer.isRunning(this.path);
    const today = todayISO();
    const log: TimeSession[] = task.timeLog ?? [];

    const root = contentEl.createDiv({ cls: "brewin-focus" });
    root.createDiv({ cls: "brewin-focus-kicker", text: mine ? "⏱ Focus · timing" : "⏱ Focus" });
    const title = root.createEl("h2", { cls: "brewin-focus-title", text: task.title });
    title.setAttr("aria-label", "Open the task's note");
    title.addEventListener("click", () => this.openNote());

    const meta = [
      task.scheduled ? `📅 ${relativeDay(task.scheduled, today)}` : "",
      task.due ? `🚩 due ${relativeDay(task.due, today)}` : "",
      task.flag ? `${task.flag.icon} ${task.flag.label}` : "",
      task.status === "done" ? "✓ done" : "",
    ].filter(Boolean);
    if (meta.length) root.createDiv({ cls: "brewin-focus-meta", text: meta.join(" · ") });

    this.clockEl = root.createDiv({ cls: "brewin-focus-clock" });
    this.paintClock();
    this.stateEl = root.createDiv({ cls: "brewin-focus-state" });
    const run = timer.running;
    if (mine && run) this.stateEl.setText(`Started ${hm(run.start)} — leave whenever; the clock keeps going.`);
    else if (log.length) this.stateEl.setText(`Paused · last session ${minutesText(log[log.length - 1].minutes)}`);
    else this.stateEl.setText("Not started yet.");

    const actions = root.createDiv({ cls: "brewin-focus-actions" });
    if (mine) {
      this.button(actions, "⏸ Pause", "mod-cta", async () => {
        const min = await timer.pause();
        new Notice(min ? `${minutesText(min)} logged on “${task.title}”.` : "Under half a minute — not logged.");
      });
    } else {
      this.button(actions, log.length ? "▶ Resume" : "▶ Start", "mod-cta", () => timer.start(task));
    }
    if (task.status !== "done") {
      this.button(actions, "✓ Done", "", async () => {
        const refused = await timer.finish(task);
        if (refused) {
          new Notice(`“${task.title}” can't be done yet — ${refused}. The time is logged.`);
          return;
        }
        new Notice(`“${task.title}” done.`);
        this.leaving = true;
        this.close();
      });
    }
    if (run && !mine) {
      const other = this.plugin.store.getByPath(run.path)?.title ?? "another task";
      root.createDiv({ cls: "brewin-focus-note", text: `“${other}” is being timed. Starting here pauses it and logs its time.` });
    }

    // How much, against the estimate — the running session counted in, as it will be once logged.
    const running = mine ? Math.floor(timer.elapsed() / 60_000) : 0;
    const total = totalMinutes(log) + running;
    const weekStart = (() => {
      const d = new Date(`${today}T12:00:00`);
      const back = (d.getDay() - this.plugin.settings.firstDayOfWeek + 7) % 7;
      d.setDate(d.getDate() - back);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();
    const stats = root.createDiv({ cls: "brewin-focus-stats" });
    const stat = (label: string, min: number) => {
      const s = stats.createDiv({ cls: "brewin-focus-stat" });
      s.createDiv({ cls: "brewin-focus-stat-value", text: minutesText(min) });
      s.createDiv({ cls: "brewin-focus-stat-label", text: label });
    };
    stat("today", minutesInRange(log, today, today) + running);
    stat("this week", minutesInRange(log, weekStart, today) + running);
    stat("total", total);
    if (task.estimate) {
      const share = total / task.estimate;
      const est = root.createDiv({ cls: "brewin-focus-estimate" + (share > 1 ? " is-over" : "") });
      const bar = est.createDiv({ cls: "brewin-focus-bar" });
      bar.createDiv({ cls: "brewin-focus-bar-fill" }).style.width = `${Math.min(100, Math.round(share * 100))}%`;
      est.createDiv({
        cls: "brewin-focus-estimate-text",
        text:
          share > 1
            ? `${minutesText(total)} of an estimated ${formatEstimate(task.estimate)} — ${minutesText(total - task.estimate)} over`
            : `${minutesText(total)} of an estimated ${formatEstimate(task.estimate)} (${Math.round(share * 100)}%)`,
      });
    }

    // The sessions, newest first.
    const sessions = root.createDiv({ cls: "brewin-focus-sessions" });
    const head = sessions.createDiv({ cls: "brewin-focus-sessions-head" });
    head.createSpan({ text: log.length ? `Sessions · ${log.length}` : "Sessions" });
    this.button(head, "＋ Add time", "brewin-focus-add", () => this.addTime());
    const shown = [...log].reverse();
    const limit = this.showAll ? shown.length : 6;
    if (!shown.length) sessions.createDiv({ cls: "brewin-focus-empty", text: "None yet. Start the clock, or add time you've already put in." });
    for (const s of shown.slice(0, limit)) {
      const row = sessions.createDiv({ cls: "brewin-focus-session" });
      row.createSpan({ cls: "brewin-focus-session-day", text: s.day === today ? "Today" : dayLabel(s.day) });
      row.createSpan({ cls: "brewin-focus-session-times", text: `${hm(s.start)}–${hm(s.end)}` });
      row.createSpan({ cls: "brewin-focus-session-len", text: minutesText(s.minutes) });
      const edit = row.createEl("button", { cls: "clickable-icon brewin-focus-icon", text: "✎" });
      edit.setAttr("aria-label", "Change this session");
      edit.addEventListener("click", () => this.editSession(s));
      const del = row.createEl("button", { cls: "clickable-icon brewin-focus-icon", text: "🗑" });
      del.setAttr("aria-label", "Delete this session");
      del.addEventListener("click", () => this.deleteSession(s));
    }
    if (shown.length > limit) {
      const more = sessions.createEl("button", { cls: "brewin-focus-more", text: `Show all ${shown.length}` });
      more.addEventListener("click", () => {
        this.showAll = true;
        this.render();
      });
    }

    const foot = root.createDiv({ cls: "brewin-focus-foot" });
    this.button(foot, "Open note", "", () => this.openNote());
  }

  private button(parent: HTMLElement, text: string, cls: string, run: () => unknown): HTMLButtonElement {
    const b = parent.createEl("button", { text, cls: `brewin-focus-btn ${cls}`.trim() });
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await run();
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  /** The note behind the task; the clock carries on, and the floating timer shows it. */
  private openNote(): void {
    const file = this.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile)) return;
    this.closeThen(() => void this.app.workspace.getLeaf(false).openFile(file));
  }

  private addTime(): void {
    new PromptModal(this.app, {
      title: "Add time",
      body: "A time today, like 14:05–14:47 — or how long, like 45m or 1h 30m, ending now.",
      placeholder: "45m",
      cta: "Add",
      onSubmit: async (text) => {
        const span = parseManualSession(text, todayISO(), Date.now());
        if (!span) return void new Notice("Couldn't read that — try 14:05–14:47, or 45m.");
        await this.plugin.timer.addSession(this.path, span[0], span[1]);
      },
    }).open();
  }

  private editSession(s: TimeSession): void {
    new PromptModal(this.app, {
      title: `Change ${s.day === todayISO() ? "today's" : dayLabel(s.day)} session`,
      body: "Its start and end, like 14:05–14:47 — or how long it was, like 45m, ending when it did.",
      initial: `${hm(s.start)}–${hm(s.end)}`,
      cta: "Save",
      onSubmit: async (text) => {
        const span = parseManualSession(text, s.day, s.end);
        if (!span) return void new Notice("Couldn't read that — try 14:05–14:47, or 45m.");
        await this.plugin.timer.editSession(this.path, s.raw, span[0], span[1]);
      },
    }).open();
  }

  private deleteSession(s: TimeSession): void {
    new ConfirmModal(this.app, {
      title: "Delete this session?",
      body: `${s.day === todayISO() ? "Today" : dayLabel(s.day)}, ${hm(s.start)}–${hm(s.end)} (${minutesText(s.minutes)})${this.plugin.settings.timerToCalendar ? ", and its calendar event" : ""}.`,
      cta: "Delete",
      onConfirm: () => void this.plugin.timer.deleteSession(this.path, s.raw),
    }).open();
  }
}

/** "The timer is still running" — stay is the default; leaving keeps the clock going. */
class LeaveModal extends Modal {
  constructor(app: App, private taskTitle: string, private onLeave: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("brewin-focus-leave");
    contentEl.createEl("h3", { text: "The timer is still running" });
    contentEl.createEl("p", { text: `Stay focused on “${this.taskTitle}”? If you leave, the clock keeps going and a small timer stays on screen to bring you back.` });
    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    const leave = btns.createEl("button", { text: "Leave — keep timing" });
    const stay = btns.createEl("button", { text: "Stay", cls: "mod-cta" });
    stay.addEventListener("click", () => this.close());
    leave.addEventListener("click", () => {
      this.close();
      this.onLeave();
    });
    window.setTimeout(() => stay.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
