import { ItemView, WorkspaceLeaf } from "obsidian";
import { nowMinutes, todayISO } from "./dates";
import { categoryColor } from "./settings";
import { renderTimeBars, renderWeekTrend } from "./timeBars";
import { formatDuration, grandTotalMinutes, periodRange, timeBudget, totalsByCategory, weeklyTotals } from "./timeTracking";
import type BrewinTasksPlugin from "./main";

export const TIME_VIEW_TYPE = "brewin-time";

type Period = "week" | "month" | "year";

/** Standalone time report: where the hours went, by category, over a fixed period. */
export class TimeView extends ItemView {
  private period: Period = "week";

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
      });
      b.addEventListener("click", () => {
        this.period = p;
        this.render();
      });
    });
    bar.createEl("button", { text: "⟳" }).addEventListener("click", () => this.render());

    root.createDiv({
      cls: "brewin-time-range",
      text: `${from} → ${to}${projected ? " (so far)" : ""}`,
    });

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
  }
}
