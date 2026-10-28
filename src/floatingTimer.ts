// The floating timer: while a focus clock runs and its window is shut, a small pill floats over the
// workspace — on any note, on desktop and phone — showing the clock and the task, with a way back to
// the focus window and a pause button. It is drawn over Obsidian's own layout, never inside a view,
// so nothing has to be open for it to show.

import type BrewinTasksPlugin from "./main";
import { FocusModal } from "./focusModal";
import { clockText, pomodoroPhase } from "./timeTrack";

export class FloatingTimer {
  private el: HTMLElement | null = null;
  private clockEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private tick: number | null = null;
  private mainEl: HTMLElement | null = null;

  constructor(private plugin: BrewinTasksPlugin) {}

  /**
   * Show, refresh or hide it to match the clock and whether its window is open. The task's title is
   * looked up here, when the clock starts, stops or the notes change — not in the once-a-second paint,
   * where finding it meant reading every task in the vault every second.
   */
  update(): void {
    const run = this.plugin.timer.running;
    const show = !!run && this.plugin.settings.timerFloating && !FocusModal.current;
    if (!show) return this.remove();
    if (!this.el) this.build();
    const title = this.plugin.store.getByPath(run.path)?.title ?? run.path.split("/").pop()!.replace(/\.md$/, "");
    if (this.titleEl && this.titleEl.textContent !== title) {
      this.titleEl.setText(title);
      this.el?.setAttr("title", title);
      this.mainEl?.setAttr("aria-label", `Back to the focus window — ${title}`);
    }
    this.paint();
  }

  private build(): void {
    const el = document.body.createDiv({ cls: "brewin-float-timer" });
    el.setAttr("role", "group");
    el.setAttr("aria-label", "Focus timer");
    const open = el.createEl("button", { cls: "brewin-float-main" });
    this.mainEl = open;
    open.setAttr("aria-label", "Back to the focus window");
    open.createSpan({ cls: "brewin-float-icon", text: "⏱" });
    this.clockEl = open.createSpan({ cls: "brewin-float-clock" });
    this.titleEl = open.createSpan({ cls: "brewin-float-title" });
    open.createSpan({ cls: "brewin-float-go", text: "↗" });
    open.addEventListener("click", () => {
      const run = this.plugin.timer.running;
      if (run) this.plugin.openFocus(run.path);
    });
    const pause = el.createEl("button", { cls: "brewin-float-pause", text: "⏸" });
    pause.setAttr("aria-label", "Pause and log the time");
    pause.addEventListener("click", () => void this.plugin.pauseTimer());
    this.el = el;
    this.tick = window.setInterval(() => this.paint(), 1000);
  }

  private paint(): void {
    const timer = this.plugin.timer;
    if (!timer.running || !this.el) return;
    // In Pomodoro rounds, what's left of this round or break; otherwise how long it has run.
    const pom = timer.pomodoro();
    const ph = pom ? pomodoroPhase(timer.elapsed(), pom) : null;
    this.clockEl?.setText(ph ? `${ph.kind === "work" ? "🍅" : "☕"} ${clockText(ph.left)}` : clockText(timer.elapsed()));
  }

  private remove(): void {
    if (this.tick !== null) window.clearInterval(this.tick);
    this.tick = null;
    this.el?.remove();
    this.el = this.clockEl = this.titleEl = this.mainEl = null;
  }

  destroy(): void {
    this.remove();
  }
}
