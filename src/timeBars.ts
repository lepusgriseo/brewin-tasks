// Shared renderer for the time-by-category breakdown, used by both the calendar panel
// and the Time view so they stay identical.
//
// Every bar is directly labelled with its category name and duration, so identity never
// depends on colour alone — which matters because category colours are user-chosen and
// can legitimately clash (two categories may even share a hue).

import { CategoryTotal, formatDuration, grandTotalMinutes, WeekTotal } from "./timeTracking";

export interface UnallocatedInfo {
  minutes: number;
  /** Trackable minutes in the period — the denominator the shares are measured against. */
  capacity: number;
}

/** Horizontal bars, largest first, each labelled with name · duration · share. */
export function renderTimeBars(
  parent: HTMLElement,
  totals: CategoryTotal[],
  colorOf: (category: string) => string,
  unallocated?: UnallocatedInfo
): void {
  if (!totals.length && !unallocated) {
    parent.createDiv({ cls: "brewin-tb-empty", text: "No timed events in this period." });
    return;
  }
  // Scale against the biggest slice, counting unallocated so the bars stay comparable.
  const max = Math.max(...totals.map((t) => t.minutes), unallocated?.minutes ?? 0, 1);

  for (const t of totals) {
    const color = colorOf(t.category);
    const pct = Math.round(t.share * 100);
    const row = parent.createDiv({ cls: "brewin-tb-row" });
    row.setAttr(
      "aria-label",
      `${t.category}: ${formatDuration(t.minutes)}, ${pct}% of tracked time, ${t.count} event${t.count === 1 ? "" : "s"}`
    );

    const head = row.createDiv({ cls: "brewin-tb-head" });
    head.createSpan({ cls: "brewin-tb-swatch" }).style.background = color;
    head.createSpan({ cls: "brewin-tb-cat", text: t.category });
    head.createSpan({ cls: "brewin-tb-val", text: formatDuration(t.minutes) });
    head.createSpan({ cls: "brewin-tb-pct", text: `${pct}%` });

    // Bars are scaled to the largest category so small ones stay visible.
    const track = row.createDiv({ cls: "brewin-tb-track" });
    const fill = track.createDiv({ cls: "brewin-tb-fill" });
    fill.style.width = `${Math.max(2, (t.minutes / max) * 100)}%`;
    fill.style.background = color;
  }

  // The leftover reads as absence, so it's deliberately recessive — a hatched grey bar
  // rather than another categorical hue competing with the real categories.
  if (unallocated) {
    const pct = unallocated.capacity > 0 ? Math.round((unallocated.minutes / unallocated.capacity) * 100) : 0;
    const row = parent.createDiv({ cls: "brewin-tb-row brewin-tb-unalloc" });
    row.setAttr("aria-label", `Unallocated: ${formatDuration(unallocated.minutes)}, ${pct}% of trackable time`);
    const head = row.createDiv({ cls: "brewin-tb-head" });
    head.createSpan({ cls: "brewin-tb-swatch is-unalloc" });
    head.createSpan({ cls: "brewin-tb-cat", text: "Unallocated" });
    head.createSpan({ cls: "brewin-tb-val", text: formatDuration(unallocated.minutes) });
    head.createSpan({ cls: "brewin-tb-pct", text: `${pct}%` });
    const track = row.createDiv({ cls: "brewin-tb-track" });
    const fill = track.createDiv({ cls: "brewin-tb-fill is-unalloc" });
    fill.style.width = `${Math.max(2, (unallocated.minutes / max) * 100)}%`;
  }

  const total = grandTotalMinutes(totals);
  const foot = parent.createDiv({ cls: "brewin-tb-total" });
  foot.setText(
    unallocated
      ? `${formatDuration(total)} tracked of ${formatDuration(unallocated.capacity)} trackable`
      : `Total tracked: ${formatDuration(total)}`
  );
}

/** A compact per-week strip for the Time view — magnitude over time, labelled on hover. */
export function renderWeekTrend(parent: HTMLElement, weeks: WeekTotal[]): void {
  if (weeks.length < 2) return;
  const max = Math.max(...weeks.map((w) => w.minutes), 1);
  parent.createDiv({ cls: "brewin-tb-subhead", text: "By week" });
  const strip = parent.createDiv({ cls: "brewin-trend" });
  for (const w of weeks) {
    const col = strip.createDiv({ cls: "brewin-trend-col" });
    col.setAttr("aria-label", `Week of ${w.weekStart}: ${formatDuration(w.minutes)}`);
    const bar = col.createDiv({ cls: "brewin-trend-bar" });
    bar.style.height = `${w.minutes === 0 ? 2 : Math.max(4, (w.minutes / max) * 100)}%`;
    if (w.minutes === 0) bar.addClass("empty");
    col.createDiv({ cls: "brewin-trend-label", text: w.weekStart.slice(5) }); // MM-DD
  }
}
