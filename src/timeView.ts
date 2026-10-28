import { ItemView, WorkspaceLeaf } from "obsidian";
import { restoreFocus, saveFocus } from "./a11y";
import { nowMinutes, todayISO } from "./dates";
import { categoryColor } from "./settings";
import { renderColumns, renderTimeBars, renderValueBars, renderWeekTrend } from "./timeBars";
import { completionInsight, estimateInsight, focusInsight, weekStartOf } from "./insights";
import { minutesText } from "./timeTrack";
import { formatDuration, grandTotalMinutes, periodRange, timeBudget, totalsByCategory, weeklyTotals } from "./timeTracking";
import type BrewinTasksPlugin from "./main";

export const TIME_VIEW_TYPE = "brewin-time";

type Period = "week" | "month" | "year";
/** Where the hours went (events), and three looks at the tasks: estimates, what got done, focus. */
type Tab = "time" | "estimates" | "completion" | "focus";
const TABS: [Tab, string][] = [
  ["time", "Time"],
  ["estimates", "Estimates"],
  ["completion", "Completion"],
  ["focus", "Focus"],
];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Standalone time report: where the hours went, by category, over a fixed period. */
export class TimeView extends ItemView {
  private period: Period = "week";
  private tab: Tab = "time";

  constructor(leaf: WorkspaceLeaf, private plugin: BrewinTasksPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return TIME_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Time";
  }
  getIcon(): string {
    return "clock";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const root = this.contentEl;
    // Each period button redraws the report; the keyboard stays on the one pressed.
    const focus = saveFocus(root);
    root.empty();
    root.addClass("brewin-time");

    // A *tracking* report counts time that has actually elapsed — recurring events would
    // otherwise project weeks of future occurrences into the total (a year of weekly gym
    // sessions is ~50h that hasn't happened yet). So the range stops at today.
    const today = todayISO();
    const period = periodRange(this.period, today);
    const from = period.from;
    const to = period.to > today ? today : period.to;
    const projected = period.to > today;

    const events = this.plugin.events.getEvents();
    const s = this.plugin.settings;
    // The last day of a "so far" range is only as long as it has actually been.
    const budget = timeBudget(events, from, to, s.trackedDayHours * 60, projected ? nowMinutes() : undefined);
    const totals = s.showUnallocated ? budget.totals : totalsByCategory(events, from, to);

    // ── Toolbar: period switch ──
    const bar = root.createDiv({ cls: "brewin-toolbar" });
    const seg = bar.createDiv({ cls: "brewin-cal-seg" });
    (["week", "month", "year"] as Period[]).forEach((p) => {
      const b = seg.createEl("button", {
        text: p[0].toUpperCase() + p.slice(1),
        cls: this.period === p ? "active" : "",
        attr: { "aria-pressed": String(this.period === p), "data-focus": `period:${p}` },
      });
      b.addEventListener("click", () => {
        this.period = p;
        this.render();
      });
    });
    bar.createEl("button", { text: "⟳", attr: { "aria-label": "Refresh the report", "data-focus": "refresh" } }).addEventListener("click", () => this.render());

    // ── Tabs ──
    const tabs = root.createDiv({ cls: "brewin-cal-seg brewin-time-tabs", attr: { role: "tablist" } });
    for (const [id, label] of TABS) {
      const b = tabs.createEl("button", { text: label, cls: this.tab === id ? "active" : "", attr: { role: "tab", "aria-selected": String(this.tab === id), "data-focus": `tab:${id}` } });
      b.addEventListener("click", () => {
        this.tab = id;
        this.render();
      });
    }

    root.createDiv({
      cls: "brewin-time-range",
      text: `${from} → ${to}${projected ? " (so far)" : ""}`,
    });
    if (this.tab !== "time") {
      this.renderInsight(root, from, to, today);
      restoreFocus(root, focus);
      return;
    }

    // ── Headline ──
    const total = grandTotalMinutes(totals);
    const hero = root.createDiv({ cls: "brewin-time-hero" });
    hero.createDiv({ cls: "brewin-time-hero-num", text: formatDuration(total) });
    hero.createDiv({ cls: "brewin-time-hero-cap", text: "tracked this " + this.period });

    // ── Breakdown ──
    renderTimeBars(
      root,
      totals,
      (c) => categoryColor(this.plugin.settings, c),
      s.showUnallocated ? { minutes: budget.unallocated, capacity: budget.capacity } : undefined
    );

    // ── Trend (month/year only — a single week has nothing to trend) ──
    if (this.period !== "week") {
      renderWeekTrend(root, weeklyTotals(events, from, to));
    }

    root.createDiv({
      cls: "brewin-tb-foot",
      text:
        "Counts events with a start and end time, up to today — all-day events have no duration and are excluded. " +
        "Recurring events count once per occurrence; archived events still count under their original category.",
    });
    restoreFocus(root, focus);
  }

  /** The Estimates, Completion and Focus tabs, over the same period. */
  private renderInsight(root: HTMLElement, from: string, to: string, today: string): void {
    const tasks = this.plugin.store.getTasks();
    const hero = (num: string, cap: string) => {
      const h = root.createDiv({ cls: "brewin-time-hero" });
      h.createDiv({ cls: "brewin-time-hero-num", text: num });
      h.createDiv({ cls: "brewin-time-hero-cap", text: cap });
    };
    const sub = (text: string) => root.createDiv({ cls: "brewin-tb-subhead", text });
    if (this.tab === "estimates") {
      const e = estimateInsight(tasks, from, to);
      if (!e.median) {
        root.createDiv({ cls: "brewin-tb-empty", text: "Nothing finished this " + this.period + " with both an estimate and focus time logged." });
        return;
      }
      const m = e.median;
      hero(`×${m.toFixed(2)}`, m > 1.05 ? `things took ${Math.round((m - 1) * 100)}% longer than estimated` : m < 0.95 ? `things took ${Math.round((1 - m) * 100)}% less time than estimated` : "things took about as long as estimated");
      root.createDiv({ cls: "brewin-time-range", text: `The middle of ${e.count} task${e.count === 1 ? "" : "s"} finished with an estimate and time logged.` });
      if (e.worst.length) {
        sub("Furthest over");
        renderValueBars(root, e.worst.map((w) => ({ label: w.title, value: w.ratio, text: `${minutesText(w.estimate)} → ${minutesText(w.logged)}`, aria: `${w.title}: estimated ${minutesText(w.estimate)}, took ${minutesText(w.logged)}` })));
      }
      if (e.byContext.length) {
        sub("By context");
        renderValueBars(root, e.byContext.map((c) => ({ label: `@${c.context}`, value: c.median, text: `×${c.median.toFixed(2)} · ${c.count}` })));
      }
      return;
    }
    if (this.tab === "completion") {
      const c = completionInsight(tasks, from, to);
      hero(String(c.total), `done this ${this.period}`);
      if (c.onTime + c.late) root.createDiv({ cls: "brewin-time-range", text: `With a deadline: ${c.onTime} on time, ${c.late} late` });
      if (!c.total) return;
      if (c.byWeek.length > 1) {
        sub("By week");
        renderColumns(root, c.byWeek.map((w) => ({ label: w.weekStart.slice(5), value: w.count, aria: `Week of ${w.weekStart}: ${w.count} done` })));
      }
      sub("By weekday");
      renderColumns(root, c.byWeekday.map((n, i) => ({ label: WEEKDAYS[i], value: n, aria: `${WEEKDAYS[i]}: ${n} done` })));
      sub("By context");
      renderValueBars(root, c.byContext.map((x) => ({ label: x.label, value: x.count, text: String(x.count) })));
      sub("By project");
      renderValueBars(root, c.byProject.map((x) => ({ label: x.label, value: x.count, text: String(x.count) })));
      return;
    }
    const f = focusInsight(tasks, from, to, today);
    hero(minutesText(f.total) || "0m", `of focus time this ${this.period}`);
    root.createDiv({ cls: "brewin-time-range", text: f.streak ? `🔥 ${f.streak} day${f.streak === 1 ? "" : "s"} in a row · longest this ${this.period}: ${f.longest}` : `Longest run this ${this.period}: ${f.longest} day${f.longest === 1 ? "" : "s"}` });
    if (!f.total) return;
    sub(this.period === "year" ? "By week" : "By day");
    if (this.period === "year") {
      const weeks = new Map<string, number>();
      for (const d of f.byDay) weeks.set(weekStartOf(d.date), (weeks.get(weekStartOf(d.date)) ?? 0) + d.minutes);
      renderColumns(root, [...weeks].map(([w, m]) => ({ label: w.slice(5), value: m, aria: `Week of ${w}: ${minutesText(m) || "none"}` })));
    } else {
      renderColumns(root, f.byDay.map((d) => ({ label: this.period === "week" ? WEEKDAYS[(new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7] : d.date.slice(8), value: d.minutes, aria: `${d.date}: ${minutesText(d.minutes) || "none"}` })));
    }
    sub("Most time");
    renderValueBars(root, f.top.map((t) => ({ label: t.title, value: t.minutes, text: minutesText(t.minutes) })));
  }
}
