// Plan my day — four short steps before the day starts: answer what's left over from days gone, see
// the day's shape (events, training, free time against the work planned), choose what joins it, and
// star its top three before placing the work on the clock. Every change is written as it's made and
// offered back with Undo; the window keeps its own record of what has been answered, because the task
// list itself catches up only once Obsidian has re-read the note.

import { App, Modal, Notice, Platform } from "obsidian";
import type BrewinTasksPlugin from "./main";
import { dayPlan, DayPlan, TOP_LIMIT } from "./planDay";
import { eventsToItems } from "./calendarItem";
import { formatEstimate } from "./estimate";
import { nextWeekStart, relativeDay } from "./status";
import { shiftISO, todayISO } from "./dates";
import { restoreFocus, saveFocus } from "./a11y";
import { Task } from "./types";

const STEPS = ["Leftovers", "The day", "Choose", "Top 3"] as const;

/** "Tuesday 27 October" — UTC-parsed so it can't drift a day across a timezone boundary. */
export function longDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

export class PlanDayModal extends Modal {
  private step = 0;
  private readonly today = todayISO();
  /** Leftovers answered here, by path, with what was done with them. */
  private answered = new Map<string, string>();
  /** Tasks brought into today here. */
  private chosen = new Map<string, Task>();
  /** Estimates set here, by path. */
  private estimates = new Map<string, number>();
  /** Today's top three as starred here (paths), once anything was changed. */
  private top: Set<string> | null = null;

  constructor(app: App, private plugin: BrewinTasksPlugin) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("brewin-plan-modal");
    this.draw();
  }

  private plan(): DayPlan {
    const s = this.plugin.settings;
    const items = [
      ...eventsToItems(this.plugin.events.getEvents(), this.today, this.today),
      ...this.plugin.ics.items(this.today, this.today, { busyOnly: true }),
      ...this.plugin.trainingItems(this.today, this.today),
    ];
    return dayPlan({ tasks: this.plugin.store.getTasks(), items, day: this.today, trackedMinutes: s.trackedDayHours * 60 });
  }

  private draw(): void {
    const { contentEl } = this;
    const focus = saveFocus(contentEl);
    contentEl.empty();
    const plan = this.plan();

    const head = contentEl.createDiv({ cls: "brewin-plan-head" });
    head.createEl("h3", { text: "☀️ Plan my day" });
    head.createDiv({ cls: "brewin-capture-hint", text: longDay(this.today) });
    const dots = head.createDiv({ cls: "brewin-plan-steps", attr: { role: "list", "aria-label": "Steps" } });
    STEPS.forEach((name, i) => {
      const d = dots.createSpan({ cls: "brewin-plan-step" + (i === this.step ? " is-current" : i < this.step ? " is-done" : ""), text: `${i + 1} ${name}` });
      d.setAttr("role", "listitem");
      if (i === this.step) d.setAttr("aria-current", "step");
    });

    const body = contentEl.createDiv({ cls: "brewin-plan-body" });
    if (this.step === 0) this.leftovers(body, plan);
    else if (this.step === 1) this.shape(body, plan);
    else if (this.step === 2) this.choose(body, plan);
    else this.topThree(body, plan);

    const foot = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    if (this.step > 0) foot.createEl("button", { text: "Back", attr: { "data-focus": "back" } }).addEventListener("click", () => this.go(this.step - 1));
    if (this.step < STEPS.length - 1) {
      foot.createEl("button", { text: "Next", cls: "mod-cta", attr: { "data-focus": "next" } }).addEventListener("click", () => void this.next());
    } else {
      foot.createEl("button", { text: "Done", cls: "mod-cta", attr: { "data-focus": "done" } }).addEventListener("click", () => this.close());
    }
    restoreFocus(contentEl, focus, contentEl.querySelector<HTMLElement>("[data-focus='next'], [data-focus='done']"));
  }

  private go(step: number): void {
    this.step = step;
    this.contentEl.scrollTop = 0;
    this.draw();
  }

  /** Leaving Choose brings the picked tasks into today, as one step Undo can take back. */
  private async next(): Promise<void> {
    if (this.step === 2 && this.chosen.size) {
      const picked = [...this.chosen.values()];
      await this.plugin.act(async () => {
        for (const t of picked) await this.plugin.store.moveToDay(t, this.today);
        return `Added ${picked.length} task${picked.length === 1 ? "" : "s"} to today`;
      });
    }
    this.go(this.step + 1);
  }

  // ── 1. Leftovers ─────────────────────────────────────────────────────────────

  private leftovers(body: HTMLElement, plan: DayPlan): void {
    body.createDiv({ cls: "brewin-plan-lede", text: "Planned for a day that's gone, or past their deadline. Give each an answer." });
    if (!plan.leftovers.length) {
      body.createDiv({ cls: "brewin-empty", text: "Nothing left over — a clean start." });
      return;
    }
    const first = this.plugin.settings.firstDayOfWeek;
    for (const t of plan.leftovers) {
      const row = body.createDiv({ cls: "brewin-plan-row" });
      const main = row.createDiv({ cls: "brewin-plan-main" });
      main.createDiv({ cls: "brewin-plan-title", text: t.title });
      const why = t.due && t.due < this.today ? `due ${relativeDay(t.due, this.today)}` : t.scheduled ? `planned ${relativeDay(t.scheduled, this.today)}` : "";
      if (why) main.createDiv({ cls: "brewin-plan-meta", text: why });
      const answer = this.answered.get(t.path);
      if (answer) {
        row.addClass("is-answered");
        row.createSpan({ cls: "brewin-plan-answer", text: `✓ ${answer}` });
        continue;
      }
      const btns = row.createDiv({ cls: "brewin-plan-btns" });
      // A phone's row has room for short words; the button's name keeps the long ones.
      const short: Record<string, string> = { Tomorrow: "Tmrw", "Next week": "Next wk" };
      const act = (label: string, said: string, fn: () => Promise<unknown>) =>
        btns.createEl("button", { text: Platform.isPhone ? short[label] ?? label : label, cls: "brewin-chip-mini", attr: { "data-focus": `left:${label}:${t.path}`, "aria-label": `${label}: ${t.title}` } }).addEventListener("click", async () => {
          await this.plugin.act(async () => {
            await fn();
            return `“${t.title}” → ${said}`;
          });
          this.answered.set(t.path, said);
          this.draw();
        });
      act("Today", "today", () => this.plugin.store.moveToDay(t, this.today));
      act("Tomorrow", "tomorrow", () => this.plugin.store.setScheduled(t, shiftISO(this.today, 1)));
      act("Next week", "next week", () => this.plugin.store.setScheduled(t, nextWeekStart(this.today, first)));
      if (!t.recurrence) act("Someday", "Someday", () => this.plugin.store.setStatus(t, "someday"));
      btns.createEl("button", { text: "✓", cls: "brewin-chip-mini", attr: { "aria-label": `Done: ${t.title}`, "data-focus": `left:done:${t.path}` } }).addEventListener("click", async () => {
        let ok = false;
        await this.plugin.act(async () => {
          const res = await this.plugin.store.complete(t);
          ok = res.ok;
          return res.ok ? `✓ “${t.title}”` : `“${t.title}” can't be done yet.`;
        });
        if (ok) this.answered.set(t.path, "done");
        this.draw();
      });
    }
  }

  // ── 2. The day's shape ───────────────────────────────────────────────────────

  private shape(body: HTMLElement, plan: DayPlan): void {
    const { load } = plan;
    const planned = [...plan.planned, ...[...this.chosen.values()].filter((t) => !plan.planned.some((p) => p.path === t.path))];
    const est = (t: Task) => this.estimates.get(t.path) ?? t.estimate;
    const estimated = planned.reduce((n, t) => n + (est(t) ?? 0), 0);
    const unestimated = planned.filter((t) => !est(t)).length;
    const over = estimated - load.free;
    const sum = body.createDiv({ cls: "brewin-plan-sum" + (over > 0 ? " is-over" : "") });
    sum.createDiv({ text: `${planned.length} task${planned.length === 1 ? "" : "s"} planned · ${formatEstimate(estimated) || "0m"} of work${unestimated ? ` (+${unestimated} without an estimate)` : ""}` });
    sum.createDiv({ text: `${formatEstimate(load.free) || "0m"} free after events${over > 0 ? ` — over by ${formatEstimate(over)}` : ""}` });
    if (!plan.busy.length) body.createDiv({ cls: "brewin-plan-lede", text: "No events or training today." });
    for (const it of plan.busy) {
      const row = body.createDiv({ cls: "brewin-plan-row is-busy" });
      row.createSpan({ cls: "brewin-plan-time", text: `${it.start}${it.end ? `–${it.end}` : ""}` });
      row.createSpan({ cls: "brewin-plan-title", text: `${it.kind === "training" ? "▲ " : ""}${it.title}` });
    }
  }

  // ── 3. Choose ────────────────────────────────────────────────────────────────

  private choose(body: HTMLElement, plan: DayPlan): void {
    body.createDiv({ cls: "brewin-plan-lede", text: "Bring in what today is for, and say how long each will take." });
    const plannedPaths = new Set(plan.planned.map((t) => t.path));
    const section = (title: string, list: Task[], pickable: boolean) => {
      if (!list.length) return;
      body.createEl("h4", { cls: "brewin-plan-h", text: `${title} · ${list.length}` });
      for (const t of list) {
        const row = body.createDiv({ cls: "brewin-plan-row" });
        if (pickable) {
          const on = this.chosen.has(t.path);
          const pick = row.createEl("button", { cls: "brewin-plan-pick" + (on ? " is-on" : ""), text: on ? "✓ Today" : "＋ Today", attr: { "data-focus": `pick:${t.path}` } });
          pick.setAttr("aria-pressed", String(on));
          pick.setAttr("aria-label", `${on ? "Taking" : "Bring"} “${t.title}” ${on ? "out of" : "into"} today`);
          pick.addEventListener("click", () => {
            if (this.chosen.has(t.path)) this.chosen.delete(t.path);
            else this.chosen.set(t.path, t);
            this.draw();
          });
        }
        const main = row.createDiv({ cls: "brewin-plan-main" });
        main.createDiv({ cls: "brewin-plan-title", text: t.title });
        if (t.scheduled && t.scheduled !== this.today) main.createDiv({ cls: "brewin-plan-meta", text: relativeDay(t.scheduled, this.today) });
        this.estimateChips(row, t);
      }
    };
    section("Today already", plan.planned, false);
    section("Inbox", plan.inbox.filter((t) => !plannedPaths.has(t.path)), true);
    section("The next 7 days", plan.soon.filter((t) => !plannedPaths.has(t.path)), true);
    if (!plan.planned.length && !plan.inbox.length && !plan.soon.length) body.createDiv({ cls: "brewin-empty", text: "Nothing waiting to be planned." });
  }

  private estimateChips(row: HTMLElement, t: Task): void {
    const current = this.estimates.get(t.path) ?? t.estimate;
    const box = row.createDiv({ cls: "brewin-plan-est", attr: { role: "group", "aria-label": `How long “${t.title}” takes` } });
    for (const m of [15, 30, 60, 120]) {
      const on = current === m;
      const b = box.createEl("button", { cls: "brewin-chip-mini" + (on ? " is-on" : ""), text: formatEstimate(m), attr: { "data-focus": `est:${m}:${t.path}` } });
      b.setAttr("aria-pressed", String(on));
      b.addEventListener("click", async () => {
        await this.plugin.act(async () => {
          await this.plugin.store.updateFields(t, { estimate: on ? null : m });
          return on ? `“${t.title}”: estimate cleared` : `“${t.title}” ~${formatEstimate(m)}`;
        });
        if (on) this.estimates.delete(t.path);
        else this.estimates.set(t.path, m);
        this.draw();
      });
    }
  }

  // ── 4. Top three, then the clock ─────────────────────────────────────────────

  private topThree(body: HTMLElement, plan: DayPlan): void {
    body.createDiv({ cls: "brewin-plan-lede", text: `Star up to ${TOP_LIMIT} — the ones that would make today a good day. They head Today's list.` });
    const today = unique([...plan.top.filter((t) => t.status !== "done"), ...plan.planned, ...this.chosen.values()]);
    // The window's own record from the first change on — read at each tap, so two quick taps both count.
    this.top ??= new Set(plan.top.filter((t) => t.status !== "done").map((t) => t.path));
    const starred = this.top;
    if (!today.length) body.createDiv({ cls: "brewin-empty", text: "Nothing planned for today yet — go back a step to bring something in." });
    for (const t of today) {
      const on = starred.has(t.path);
      const row = body.createDiv({ cls: "brewin-plan-row" + (on ? " is-top" : "") });
      const star = row.createEl("button", { cls: "brewin-plan-star", text: on ? "⭐" : "☆", attr: { "data-focus": `star:${t.path}` } });
      star.setAttr("aria-pressed", String(on));
      star.setAttr("aria-label", `${on ? "Unstar" : "Star"} “${t.title}”`);
      star.addEventListener("click", async () => {
        const live = this.top!;
        const isOn = live.has(t.path);
        if (!isOn && live.size >= TOP_LIMIT) return void new Notice(`${TOP_LIMIT} are starred — unstar one first.`);
        if (isOn) live.delete(t.path);
        else live.add(t.path);
        await this.plugin.act(async () => {
          await this.plugin.store.setTop(t, isOn ? null : this.today);
          return isOn ? `“${t.title}” isn't a top task now` : `⭐ “${t.title}”`;
        });
        this.draw();
      });
      row.createDiv({ cls: "brewin-plan-title", text: t.title });
    }
    const tools = body.createDiv({ cls: "brewin-plan-tools" });
    const auto = tools.createEl("button", { text: "⚡ Auto-schedule the rest", attr: { "data-focus": "auto" } });
    auto.addEventListener("click", async () => {
      await this.plugin.act(async () => this.plugin.autoScheduleMessage(await this.plugin.autoScheduleToday()));
    });
    const cal = tools.createEl("button", { text: "📅 Place them on the calendar", attr: { "data-focus": "calendar" } });
    cal.addEventListener("click", () => {
      this.close();
      void this.plugin.openCalendarDay(this.today);
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.plugin.refreshViews();
  }
}

function unique(list: Iterable<Task>): Task[] {
  return [...new Map([...list].map((t) => [t.path, t])).values()];
}
