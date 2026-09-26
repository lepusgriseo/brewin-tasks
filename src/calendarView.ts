import { ItemView, Menu, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { addDays, addMinutesHM, dayDelta, durationMinutes, formatHM, formatISO, isoWeekOf, monthMatrix, monthOf, nowMinutes, parseISO, shiftISO, shortDate, todayISO, weekDates, weekdayHeaders } from "./dates";
import { blockRange, CalView, stepAnchor, timeBox, viewTitle, visibleRange } from "./calendar";
import { slotProgress } from "./slots";
import { attachLongPressDrag, attachLongPressTap, hapticTick } from "./dragHandle";
import { eventsToItems, groupItemsByDay, projectTasksToItems, sortItems, tasksToItems } from "./calendarItem";
import { allDaySpans, BarSegment, laneCount, packOverlaps, segmentsForWeek, taskSpans } from "./calendarLayout";
import { EventModal } from "./eventModal";
import type { DropIntent } from "./eventStore";
import { CaptureModal } from "./captureModal";
import { RecurrenceScopeModal } from "./recurrenceScopeModal";
import { ConfirmModal } from "./confirmModal";
import { ProjectTaskSource } from "./projectTasks";
import { categoryColor, HOUR_PX_BY_SLOT, PROJECTS_CATEGORY } from "./settings";
import { renderTimeBars } from "./timeBars";
import { formatDuration, grandTotalMinutes, timeBudget, totalsByCategory } from "./timeTracking";
import { expandRecurringTasks, monthPanelSections, MonthPanelSection } from "./views";
import type { NewTaskFields } from "./taskStore";
import { CalendarItem, EventItem, Task } from "./types";
import type BrewinTasksPlugin from "./main";

export const CALENDAR_VIEW_TYPE = "brewin-calendar";

const BAR_H = 20; // px per all-day bar lane

/** True for items that render as per-day chips (everything except all-day events, which are bars). */
function isChipItem(it: CalendarItem): boolean {
  return !(it.kind === "event" && it.allDay);
}

/** One section of a task side-panel: a `monthPanelSections` view-model row (or a synthetic
 *  single section for the Week panel) plus the section's add-box wiring. */
type TaskPanelSection = MonthPanelSection & {
  addPlaceholder: string;
  emptyText: string;
  onAdd: (title: string) => Promise<void>;
};

export class CalendarView extends ItemView {
  private view: CalView;
  private anchor: string = todayISO();
  private suppressClick = false;
  private snapEl: HTMLElement | null = null;
  private renderToken = 0;
  private projectSource: ProjectTaskSource;
  /** Current-time indicators rendered this pass, nudged every minute. */
  private nowLines: HTMLElement[] = [];
  /** Re-fits month cells when the pane resizes. Replaced on every render. */
  private monthResize: ResizeObserver | null = null;
  /** Per-week-section fold state for the Month panel, keyed by ISO week ("2026-W37") or month
   *  ("2026-09"). Absent = use the section's computed default. In-memory: survives `render()`
   *  and month navigation, resets when the pane is reopened (like `this.view`). */
  private sectionOpen = new Map<string, boolean>();

  constructor(leaf: WorkspaceLeaf, private plugin: BrewinTasksPlugin) {
    super(leaf);
    // Nothing persists which view was open, so every fresh pane opens on the configured default.
    this.view = this.plugin.settings.defaultCalendarView;
    this.projectSource = new ProjectTaskSource(this.app, this.plugin.settings);
    // Move the line rather than re-rendering — a full redraw every minute would fight
    // with scrolling and drag operations.
    this.registerInterval(window.setInterval(() => this.positionNowLines(), 60_000));
  }

  /** Place each now-line at the current time. */
  private positionNowLines(): void {
    const y = (nowMinutes() / 60) * this.hourPx;
    const label = formatHM(nowMinutes());
    for (const el of this.nowLines) {
      el.style.top = `${y}px`;
      el.setAttr("aria-label", `Now — ${label}`);
    }
  }

  getViewType(): string {
    return CALENDAR_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Calendar";
  }
  getIcon(): string {
    return "calendar";
  }

  /** Grid resolution in minutes (60 / 30 / 15). */
  private get slotMinutes(): number {
    return this.plugin.settings.timeSlotMinutes ?? 60;
  }
  /** Height of one hour at the current resolution — everything positional derives from this. */
  private get hourPx(): number {
    return HOUR_PX_BY_SLOT[this.slotMinutes] ?? 44;
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.monthResize?.disconnect();
    this.monthResize = null;
  }

  async render(): Promise<void> {
    const token = ++this.renderToken;
    const settings = this.plugin.settings;
    const { from, to } = visibleRange(this.view, this.anchor, settings.firstDayOfWeek);

    // Gather all data first (project tasks are read async) before touching the DOM.
    const events = this.plugin.events.getEvents();
    const catShown = (cat: string) => !settings.hiddenCategories.includes(cat);
    const items: CalendarItem[] = [];
    let taskDaySpans: ReturnType<typeof taskSpans> = [];
    if (settings.showTasksOnCalendar) {
      // Recurring tasks are EXPANDED across the visible range, same as recurring events already
      // are — otherwise there'd be nothing beyond the current occurrence to drag or edit.
      const allTasks = this.plugin.store.getTasks();
      const nonRecurring = allTasks.filter((t) => !t.recurrence);
      items.push(
        ...tasksToItems(nonRecurring, from, to, settings.slotBlockMinutes, { skipMultiDay: true }),
        ...expandRecurringTasks(allTasks.filter((t) => !!t.recurrence), from, to, settings.slotBlockMinutes)
      );
      // A multi-day task ("Run 10k" Fri→Sun) gets ONE spanning bar, same as an all-day event —
      // skipMultiDay above dropped its per-day chips so it isn't shown twice.
      taskDaySpans = taskSpans(nonRecurring, from, to);
    }
    if (settings.showEventsOnCalendar) {
      items.push(...eventsToItems(events, from, to).filter((it) => catShown(it.category)));
    }
    if (settings.showProjectTasksOnCalendar) {
      const pts = await this.projectSource.getProjectTasks(true); // active projects only
      items.push(...projectTasksToItems(pts, from, to, PROJECTS_CATEGORY));
    }
    if (token !== this.renderToken) return; // a newer render superseded this one

    const byDay = groupItemsByDay(items);
    const eventDaySpans = settings.showEventsOnCalendar
      ? allDaySpans(events, from, to).filter((sp) => catShown(sp.category))
      : [];
    const spans = [...eventDaySpans, ...taskDaySpans];

    const root = this.contentEl;
    root.empty();
    this.nowLines = []; // the previous pass's nodes are gone with root.empty()
    // The month grid's resize observer watched a node that root.empty() just detached;
    // renderMonth makes a fresh one if we're still on Month.
    this.monthResize?.disconnect();
    this.monthResize = null;
    root.addClass("brewin-calendar");
    this.toolbar(root);
    this.renderLegend(root);
    this.renderTimePanel(root, events, from, to);

    if (this.view === "month") {
      // The "this month" task panel sits beside the grid, not above it, so both need a shared row —
      // the grid keeps all its own scrolling/sizing, the panel gets a fixed-width column.
      const row = root.createDiv({ cls: "brewin-month-row" });
      this.renderMonth(row, byDay, spans);
      if (settings.showMonthTasks) this.renderMonthTasksPanel(row);
    } else if (this.view === "week") {
      const days = weekDates(parseISO(this.anchor)!, settings.firstDayOfWeek).map(formatISO);
      if (settings.showWeekTasks) {
        // Same arrangement as Month: the time grid keeps its own sizing, the "this week"
        // panel takes a fixed-width column beside it.
        const row = root.createDiv({ cls: "brewin-week-row" });
        this.renderTimeGrid(row, byDay, spans, days);
        this.renderWeekTasksPanel(row, days);
      } else {
        this.renderTimeGrid(root, byDay, spans, days);
      }
    } else {
      this.renderTimeGrid(root, byDay, spans, [this.anchor]);
    }
  }

  private toolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "brewin-toolbar brewin-cal-toolbar" });
    const nav = bar.createDiv({ cls: "brewin-cal-nav" });
    nav.createEl("button", { text: "‹" }).addEventListener("click", () => this.step(-1));
    nav.createEl("button", { text: "Today" }).addEventListener("click", () => { this.anchor = todayISO(); this.render(); });
    nav.createEl("button", { text: "›" }).addEventListener("click", () => this.step(1));
    bar.createSpan({ cls: "brewin-cal-title", text: viewTitle(this.view, this.anchor, this.plugin.settings.firstDayOfWeek) });

    const right = bar.createDiv({ cls: "brewin-cal-right" });
    const seg = right.createDiv({ cls: "brewin-cal-seg" });
    (["month", "week", "day"] as CalView[]).forEach((v) => {
      const b = seg.createEl("button", { text: v[0].toUpperCase() + v.slice(1), cls: this.view === v ? "active" : "" });
      b.addEventListener("click", () => { this.view = v; this.render(); });
    });
    // Grid resolution — only meaningful where there's an hour grid to zoom.
    if (this.view !== "month") {
      const zoom = right.createEl("select", { cls: "brewin-zoom" });
      zoom.setAttr("aria-label", "Time grid resolution");
      ([60, 30, 15] as const).forEach((m) =>
        zoom.createEl("option", { text: m === 60 ? "1 hour" : `${m} min`, value: String(m) })
      );
      zoom.value = String(this.slotMinutes);
      zoom.addEventListener("change", async () => {
        this.plugin.settings.timeSlotMinutes = Number(zoom.value) as 60 | 30 | 15;
        await this.plugin.saveSettings();
        this.render();
      });
    }

    const archiveBtn = right.createEl("button", { text: "🗄" });
    archiveBtn.setAttr("aria-label", "Archive past events");
    archiveBtn.addEventListener("click", () => this.plugin.archivePastEventsFlow());
    right.createEl("button", { text: "＋ Event", cls: "mod-cta" }).addEventListener("click", () => this.newEvent(this.anchor));
  }

  private step(dir: number): void {
    this.anchor = stepAnchor(this.view, this.anchor, dir);
    this.render();
  }

  /**
   * Time-by-category for whatever range is on screen — switch to Week and it totals that
   * week, to Month and it totals the month. Honours the category filters so what you see
   * is what's counted.
   */
  private renderTimePanel(root: HTMLElement, events: EventItem[], from: string, to: string): void {
    const s = this.plugin.settings;
    if (!s.showTimePanel) return;

    // Archived events are attributed to their real category, so filter on that.
    const visible = events.filter((e) => !s.hiddenCategories.includes(e.originalCategory));
    const budget = timeBudget(visible, from, to, s.trackedDayHours * 60);
    const totals = s.showUnallocated ? budget.totals : totalsByCategory(visible, from, to);

    const wrap = root.createDiv({ cls: "brewin-time-panel" });
    const head = wrap.createDiv({ cls: "brewin-time-panel-head" });
    head.createSpan({ cls: "brewin-expander", text: s.timePanelOpen ? "▾" : "▸" });
    head.createSpan({ text: "⏱ Time by category" });
    head.createSpan({
      cls: "brewin-count",
      text: formatDuration(grandTotalMinutes(totals)),
    });
    const openFull = head.createEl("button", { cls: "brewin-icon-btn", text: "↗" });
    openFull.setAttr("aria-label", "Open the full time report");
    openFull.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also collapse the panel
      void this.plugin.activateTime();
    });
    head.addEventListener("click", async () => {
      s.timePanelOpen = !s.timePanelOpen;
      await this.plugin.saveSettings();
      this.render();
    });

    if (!s.timePanelOpen) return;
    const body = wrap.createDiv({ cls: "brewin-time-panel-body" });
    renderTimeBars(
      body,
      totals,
      (c) => categoryColor(this.plugin.settings, c),
      s.showUnallocated ? { minutes: budget.unallocated, capacity: budget.capacity } : undefined
    );
  }

  /**
   * The Month-view task panel: one section per ISO week of the visible month ("do X the week
   * of the 14th"), plus a trailing "Anytime this month" catch-all. Drag works both ways —
   * press-and-hold a row and drop it on a day cell to schedule it, or drag a task chip off the
   * grid onto a section to file it under that week/month. Week-filed tasks also show in the
   * Week panel (both read `Task.week`).
   */
  private renderMonthTasksPanel(root: HTMLElement): void {
    const s = this.plugin.settings;
    const month = monthOf(this.anchor);
    const sections: TaskPanelSection[] = monthPanelSections(
      month,
      this.plugin.store.getTasks(),
      todayISO()
    ).map((sec) => ({
      ...sec,
      addPlaceholder: sec.kind === "week" ? `＋ Add to ${sec.label}…` : "＋ Add a task for this month…",
      emptyText: sec.kind === "week" ? "Nothing here yet." : "Nothing month-wide yet.",
      onAdd: async (title: string) => {
        await this.plugin.store.createTask({
          title,
          scheduled: null,
          due: null,
          priority: "normal",
          contexts: [],
          ...(sec.kind === "week" ? { week: sec.key } : { month: sec.key }),
        });
      },
    }));

    this.renderTasksPanel(root, {
      open: s.monthTasksOpen,
      openLabel: "🗓 This month",
      name: "this month's tasks",
      toggle: async () => {
        s.monthTasksOpen = !s.monthTasksOpen;
        await this.plugin.saveSettings();
        this.render();
      },
      fallbackBucket: { kind: "month", key: month },
      sections,
    });
  }

  /**
   * The Week-view sibling: a single loose "do this sometime this week" bucket (rendered as one
   * headerless section). Drag both ways — a row onto a day/time slot to commit it, or a task
   * chip off the grid onto the panel to drop its day/time and file it back under the week.
   */
  private renderWeekTasksPanel(root: HTMLElement, days: string[]): void {
    const s = this.plugin.settings;
    // ISO weeks are keyed by their Thursday; `days` is the seven displayed dates, so pick
    // whichever of them is a Thursday — the answer is the same however `firstDayOfWeek` is set.
    const thursday = days.find((iso) => parseISO(iso)!.getUTCDay() === 4) ?? days[0];
    const week = isoWeekOf(thursday);
    const tasks = this.plugin.store
      .tasksForWeek(week)
      .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.title.localeCompare(b.title));

    this.renderTasksPanel(root, {
      open: s.weekTasksOpen,
      openLabel: "🗓 This week",
      name: "this week's tasks",
      toggle: async () => {
        s.weekTasksOpen = !s.weekTasksOpen;
        await this.plugin.saveSettings();
        this.render();
      },
      fallbackBucket: { kind: "week", key: week },
      sections: [
        {
          key: week,
          kind: "week",
          label: "", // headerless — the panel header already says "This week"
          start: null,
          end: null,
          tasks,
          defaultOpen: true,
          isCurrent: false,
          fallbackDate: days[0],
          addPlaceholder: "＋ Add a task for this week…",
          emptyText: "Nothing for this week yet — add one, or drag a task here.",
          onAdd: async (title: string) => {
            await this.plugin.store.createTask({ title, scheduled: null, due: null, priority: "normal", contexts: [], week });
          },
        },
      ],
    });
  }

  /** The draggable `CalendarItem` for a Month/Week panel row. `fallbackDate` is only read for
   *  recurring-scope maths (a bucket task is almost never recurring), so any in-view day does. */
  private bucketDragItem(t: Task, fallbackDate: string): CalendarItem {
    return {
      kind: "task",
      path: t.path,
      title: t.title,
      date: t.scheduled ?? fallbackDate,
      allDay: true,
      start: null,
      end: null,
      done: t.status === "done",
      category: "General",
      recurring: !!t.recurrence,
    };
  }

  /**
   * Shared renderer for the Month / Week side panels: a collapsible panel header, then one or
   * more sections (each a labelled or headerless fold with its own add-box and task list).
   * Each section's wrapper is a `data-drop` target, so a grid task dropped on it files to that
   * bucket; `fallbackBucket` on the panel wrap catches drops on the chrome between sections.
   */
  private renderTasksPanel(
    root: HTMLElement,
    cfg: {
      open: boolean;
      openLabel: string;
      name: string;
      toggle: () => void;
      fallbackBucket: { kind: "week" | "month"; key: string };
      sections: TaskPanelSection[];
    }
  ): void {
    const { open } = cfg;
    const openCount = cfg.sections.reduce(
      (n, sec) => n + sec.tasks.filter((t) => t.status !== "done").length,
      0
    );
    const wrap = root.createDiv({ cls: "brewin-caltasks-panel" + (open ? "" : " is-collapsed") });
    wrap.setAttr("data-drop", cfg.fallbackBucket.kind); // "week" | "month" → handled in handleDrop
    wrap.setAttr("data-bucket", cfg.fallbackBucket.key);

    // The header doubles as the collapse toggle: the panel's fixed width squeezes the grid
    // off a phone screen, so it folds to a thin strip that still shows the open count.
    const head = wrap.createDiv({ cls: "brewin-caltasks-head" });
    head.createSpan({ cls: "brewin-expander", text: open ? "▾" : "▸" });
    head.createSpan({ cls: "brewin-caltasks-head-label", text: open ? cfg.openLabel : "🗓" });
    if (openCount) head.createSpan({ cls: "brewin-count", text: String(openCount) });
    head.setAttr("role", "button");
    head.setAttr("tabindex", "0");
    head.setAttr("aria-expanded", String(open));
    head.setAttr("aria-label", open ? `Collapse ${cfg.name}` : `Expand ${cfg.name} (${openCount} open)`);
    head.addEventListener("click", cfg.toggle);
    head.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        cfg.toggle();
      }
    });

    if (!open) return;
    for (const sec of cfg.sections) this.renderPanelSection(wrap, sec);
  }

  /** One section of a task panel: a `data-drop` fold with an optional header, an add-box and
   *  a task list (or empty text). A headerless section (Week panel) is always expanded. */
  private renderPanelSection(wrap: HTMLElement, sec: TaskPanelSection): void {
    const headed = sec.label !== "";
    const isOpen = headed ? this.sectionOpen.get(sec.key) ?? sec.defaultOpen : true;
    const openCount = sec.tasks.filter((t) => t.status !== "done").length;

    const el = wrap.createDiv({
      cls:
        "brewin-caltasks-section" +
        (isOpen ? "" : " is-collapsed") +
        (sec.isCurrent ? " is-current" : ""),
    });
    // The section is its own drop target — a grid task dropped anywhere in it files to this
    // bucket. A collapsed section keeps the attr on its header, so you can drop onto a fold.
    el.setAttr("data-drop", sec.kind);
    el.setAttr("data-bucket", sec.key);

    if (headed) {
      const h = el.createDiv({ cls: "brewin-caltasks-section-head" });
      h.createSpan({ cls: "brewin-expander", text: isOpen ? "▾" : "▸" });
      h.createSpan({ text: sec.label });
      if (sec.start && sec.end) {
        h.createSpan({
          cls: "brewin-caltasks-section-sub",
          text: `· ${shortDate(sec.start)} – ${shortDate(sec.end)}`,
        });
      }
      if (openCount) h.createSpan({ cls: "brewin-count", text: String(openCount) });
      h.setAttr("role", "button");
      h.setAttr("tabindex", "0");
      h.setAttr("aria-expanded", String(isOpen));
      h.setAttr("aria-label", `${isOpen ? "Collapse" : "Expand"} ${sec.label} (${openCount} open)`);
      const toggle = () => {
        this.sectionOpen.set(sec.key, !isOpen);
        this.render();
      };
      h.addEventListener("click", toggle);
      h.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    }

    if (!isOpen) return;

    const addInput = el
      .createDiv({ cls: "brewin-caltasks-add" })
      .createEl("input", { type: "text", placeholder: sec.addPlaceholder });
    addInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const title = addInput.value.trim();
      if (!title) return;
      addInput.value = "";
      void sec.onAdd(title).then(() => this.render());
    });

    if (!sec.tasks.length) {
      el.createDiv({ cls: "brewin-caltasks-empty", text: sec.emptyText });
      return;
    }
    const list = el.createDiv({ cls: "brewin-caltasks-list" });
    for (const t of sec.tasks) list.appendChild(this.panelTaskRow(t, this.bucketDragItem(t, sec.fallbackDate)));
  }

  private panelTaskRow(task: Task, dragItem?: CalendarItem): HTMLElement {
    const done = task.status === "done";
    const row = createDiv({ cls: "brewin-caltask-row" + (done ? " done" : "") });

    const cb = row.createEl("input", { type: "checkbox" });
    cb.checked = done;
    cb.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (task.status === "done") {
        await this.plugin.store.reopen(task);
      } else {
        const res = await this.plugin.store.complete(task);
        if (!res.ok) {
          const reasons = [
            res.open ? `${res.open} subtask${res.open === 1 ? "" : "s"} still open` : null,
            res.blocked ? `waiting on ${res.blocked} other task${res.blocked === 1 ? "" : "s"}` : null,
          ]
            .filter((r): r is string => !!r)
            .join(" and ");
          new Notice(`Can't complete "${task.title}" — ${reasons}.`);
          return;
        }
      }
      this.render();
    });

    const title = row.createDiv({ cls: "brewin-caltask-title", text: task.title });
    title.addEventListener("click", () => {
      // A draggable row's click can be the tail of a press-and-hold drop — swallow that one.
      if (dragItem && this.consumeClick()) return;
      new CaptureModal(this.app, this.plugin.store, this.plugin.settings, () => this.render(), task).open();
    });

    if (dragItem) this.makeDraggable(row, dragItem);
    return row;
  }

  /** Interactive legend: click a layer or category to show/hide it (persisted in settings). */
  private renderLegend(root: HTMLElement): void {
    const s = this.plugin.settings;
    const bar = root.createDiv({ cls: "brewin-cal-legend" });

    const toggle = async (mutate: () => void) => {
      mutate();
      await this.plugin.saveSettings();
      this.render();
    };

    // Layer toggles
    const layer = (label: string, glyph: string, on: boolean, flip: () => void) => {
      const item = bar.createDiv({ cls: "brewin-legend-toggle" + (on ? "" : " off") });
      item.createSpan({ cls: "brewin-legend-glyph", text: glyph });
      item.createSpan({ text: label });
      item.setAttr("aria-label", (on ? "Hide " : "Show ") + label);
      item.addEventListener("click", () => toggle(flip));
    };
    layer("Tasks", "●", s.showTasksOnCalendar, () => (s.showTasksOnCalendar = !s.showTasksOnCalendar));
    layer("Events", "▮", s.showEventsOnCalendar, () => (s.showEventsOnCalendar = !s.showEventsOnCalendar));
    layer("Projects", "◆", s.showProjectTasksOnCalendar, () => (s.showProjectTasksOnCalendar = !s.showProjectTasksOnCalendar));

    bar.createDiv({ cls: "brewin-legend-sep" });

    // Category toggles (affect events; dimmed when the Events layer is off)
    for (const c of s.categories) {
      const hidden = s.hiddenCategories.includes(c.name);
      const item = bar.createDiv({ cls: "brewin-legend-toggle" + (hidden || !s.showEventsOnCalendar ? " off" : "") });
      item.createSpan({ cls: "brewin-legend-swatch" }).style.background = c.color;
      item.createSpan({ text: c.name });
      item.setAttr("aria-label", (hidden ? "Show " : "Hide ") + c.name + " events");
      item.addEventListener("click", () =>
        toggle(() => {
          const set = new Set(s.hiddenCategories);
          set.has(c.name) ? set.delete(c.name) : set.add(c.name);
          s.hiddenCategories = [...set];
        })
      );
    }
  }

  // ── Month ──
  private renderMonth(root: HTMLElement, byDay: Map<string, CalendarItem[]>, spans: ReturnType<typeof allDaySpans>): void {
    const wrap = root.createDiv({ cls: "brewin-month" });
    const ws = this.plugin.settings.firstDayOfWeek;
    const dowRow = wrap.createDiv({ cls: "brewin-month-dowrow" });
    weekdayHeaders(ws).forEach((h) => dowRow.createDiv({ cls: "brewin-month-dow", text: h }));

    const anchor = parseISO(this.anchor)!;
    const curMonth = anchor.getUTCMonth();
    const today = todayISO();

    for (const week of monthMatrix(anchor.getUTCFullYear(), curMonth, ws)) {
      const weekISO = week.map(formatISO);
      const segs = segmentsForWeek(spans, weekISO);
      const lanes = laneCount(segs);

      const row = wrap.createDiv({ cls: "brewin-month-week" });
      row.style.setProperty("--bars-h", `${lanes * BAR_H}px`);

      for (const day of week) {
        const iso = formatISO(day);
        const cell = row.createDiv({ cls: "brewin-month-cell", attr: { "data-drop": "day", "data-date": iso } });
        if (day.getUTCMonth() !== curMonth) cell.addClass("othermonth");
        if (iso === today) cell.addClass("istoday");
        const head = cell.createDiv({ cls: "brewin-month-daynum", text: String(day.getUTCDate()) });
        head.addEventListener("click", () => { this.view = "day"; this.anchor = iso; this.render(); });
        // Monday cell → the ISO week number ("W37"), tucked top-left; click opens that week.
        if (day.getUTCDay() === 1) {
          const wnum = isoWeekOf(iso).slice(6); // "37" | "07"
          const wk = cell.createDiv({ cls: "brewin-month-weeknum", text: "W" + wnum });
          wk.setAttr("aria-label", `Week ${Number(wnum)} — open`);
          wk.addEventListener("click", (e) => {
            e.stopPropagation();
            this.view = "week";
            this.anchor = iso;
            this.render();
          });
        }
        cell.addEventListener("dblclick", () => this.newEvent(iso));
        this.wireCreateOnHold(cell, iso, ".brewin-chip-item, .brewin-month-daynum, .brewin-month-more, .brewin-month-weeknum");

        // Every chip is rendered; fitMonthCells() then hides whatever doesn't fit the cell
        // at its current height. Keeping them in the DOM means a window resize can reveal
        // them again without a full re-render.
        const itemsWrap = cell.createDiv({ cls: "brewin-month-items" });
        const items = (byDay.get(iso) ?? []).filter(isChipItem);
        items.forEach((it) => itemsWrap.appendChild(this.chip(it)));
        const more = itemsWrap.createDiv({ cls: "brewin-month-more brewin-hidden" });
        more.addEventListener("click", () => { this.view = "day"; this.anchor = iso; this.render(); });
      }

      if (segs.length) {
        const overlay = row.createDiv({ cls: "brewin-month-bars" });
        segs.forEach((seg) => overlay.appendChild(this.bar(seg, 7)));
      }
    }

    // Fit after layout, then again whenever the pane is resized — the whole point is that
    // the grid tracks the window rather than a fixed row height.
    window.requestAnimationFrame(() => this.fitMonthCells(wrap));
    this.monthResize = new ResizeObserver(() => this.fitMonthCells(wrap));
    this.monthResize.observe(wrap);
  }

  /**
   * Show as many chips per day cell as actually fit, and summarise the rest as "＋N more".
   *
   * Measured rather than a fixed cap: rows now stretch to fill the window, so a tall pane
   * shows eight items where a short one shows two. At least one chip always survives, so a
   * day with anything on it never looks empty.
   */
  private fitMonthCells(wrap: HTMLElement): void {
    const cells = Array.from(wrap.querySelectorAll<HTMLElement>(".brewin-month-items"));
    for (const itemsWrap of cells) {
      const chips = Array.from(itemsWrap.children).filter(
        (c): c is HTMLElement => c instanceof HTMLElement && c.hasClass("brewin-chip-item")
      );
      const more = itemsWrap.querySelector<HTMLElement>(".brewin-month-more");
      if (!chips.length) continue;

      chips.forEach((c) => c.removeClass("brewin-hidden"));
      more?.addClass("brewin-hidden");

      const avail = itemsWrap.clientHeight;
      if (avail <= 0) continue; // not laid out yet (pane hidden) — leave it alone

      let visible = chips.length;
      while (visible > 1 && itemsWrap.scrollHeight > avail) {
        chips[--visible].addClass("brewin-hidden");
      }

      let hidden = chips.length - visible;
      if (hidden > 0 && more) {
        more.removeClass("brewin-hidden");
        // The "＋N more" line occupies a row itself, so it can push things over again.
        if (itemsWrap.scrollHeight > avail && visible > 1) {
          chips[--visible].addClass("brewin-hidden");
          hidden++;
        }
        more.setText(`＋${hidden} more`);
      }
    }
  }

  /** A spanning all-day event bar. Positioned by column across `colCount` columns. */
  private bar(seg: BarSegment, colCount: number): HTMLElement {
    const s = seg.span;
    const isTask = s.kind === "task";
    const el = createDiv({
      cls: `brewin-bar${s.done ? " done" : ""}${seg.continuesLeft ? " cont-left" : ""}${seg.continuesRight ? " cont-right" : ""}`,
    });
    // A task has no category of its own — style it the same accent colour its chip already
    // uses (`.brewin-chip-item.kind-task`) rather than routing it through categoryColor.
    const color = isTask ? "var(--interactive-accent)" : categoryColor(this.plugin.settings, s.category);
    el.style.background = `color-mix(in srgb, ${color} 30%, var(--background-primary))`;
    el.style.borderLeft = `3px solid ${color}`;
    if (s.category === "Archived") el.addClass("brewin-archived");
    el.style.left = `calc(${(seg.startCol / colCount) * 100}% + 2px)`;
    el.style.width = `calc(${((seg.endCol - seg.startCol + 1) / colCount) * 100}% - 4px)`;
    el.style.top = `${seg.lane * BAR_H}px`;
    el.setText((isTask ? "● " : "") + (s.recurring ? "🔁 " : "") + (seg.continuesLeft ? "◀ " : "") + s.title);
    if (s.location) el.setAttr("title", `📍 ${s.location}`);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.consumeClick()) return;
      if (isTask) this.openEdit({ kind: "task", path: s.path, title: s.title, date: s.start, allDay: true, start: null, end: null, done: s.done, category: s.category, recurring: s.recurring });
      else this.openEventByPath(s.path, s.start);
    });
    // Matches the chip's own behaviour: only an event gets a right-click menu (edit/open/delete).
    if (!isTask) el.addEventListener("contextmenu", (e) => this.eventContextMenu(e, s.path, s.start));
    // Reuse the generic pointer-drag: a whole-span move sets the item's start to the drop day.
    this.makeDraggable(el, {
      kind: s.kind,
      path: s.path,
      title: s.title,
      date: s.start,
      allDay: true,
      start: null,
      end: null,
      done: s.done,
      category: s.category,
      recurring: s.recurring,
    });
    return el;
  }

  private chip(it: CalendarItem): HTMLElement {
    const el = createDiv({ cls: `brewin-chip-item kind-${it.kind} ${it.done ? "done" : ""}` });
    if (it.kind === "event" || it.kind === "project") {
      const color = categoryColor(this.plugin.settings, it.category);
      el.style.borderLeftColor = color;
      el.style.background = `color-mix(in srgb, ${color} 20%, var(--background-modifier-hover))`;
    }
    if (it.kind === "project") {
      el.setAttr("aria-label", it.path.split("/").pop()?.replace(/\.md$/, "") ?? "");
    }
    if (it.kind === "event" && it.location) el.setAttr("title", `📍 ${it.location}`);
    if (it.category === "Archived") el.addClass("brewin-archived");
    const glyph = it.kind === "task" ? "●" : it.kind === "event" ? "▮" : it.kind === "project" ? "◆" : "◇";
    el.createSpan({ cls: "g", text: glyph + " " });
    const label = (it.recurring ? "🔁 " : "") + (it.start ? `${it.start} ${it.title}` : it.title);
    el.createSpan({ text: label });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.consumeClick()) return;
      else if (it.kind === "project") void this.openProjectLine(it);
      else this.openEdit(it);
    });
    if (it.kind === "event") {
      el.addEventListener("contextmenu", (e) => this.eventContextMenu(e, it.path, it.date));
    }
    this.makeDraggable(el, it);
    return el;
  }

  // ── Week / Day (time grid) ──
  private renderTimeGrid(root: HTMLElement, byDay: Map<string, CalendarItem[]>, spans: ReturnType<typeof allDaySpans>, days: string[]): void {
    const wrap = root.createDiv({ cls: "brewin-timegrid" });

    // Header row (day labels)
    const header = wrap.createDiv({ cls: "brewin-tg-header" });
    header.createDiv({ cls: "brewin-tg-gutter" });
    const today = todayISO();
    for (const iso of days) {
      const d = parseISO(iso)!;
      const h = header.createDiv({ cls: "brewin-tg-daycol" + (iso === today ? " istoday" : "") });
      h.createDiv({ cls: "brewin-tg-dow", text: d.toLocaleString("default", { weekday: "short", timeZone: "UTC" }) });
      h.createDiv({ cls: "brewin-tg-date", text: String(d.getUTCDate()) });
      h.addEventListener("click", () => { this.view = "day"; this.anchor = iso; this.render(); });
    }

    // All-day band: spanning event bars overlaid on per-day task/habit chips.
    // Collapsible, because on a phone it can push the actual hour grid off screen.
    const segs = segmentsForWeek(spans, days);
    const lanes = laneCount(segs);
    const open = this.plugin.settings.allDayOpen;
    const chipsByDay = new Map(
      days.map((iso) => [iso, (byDay.get(iso) ?? []).filter((i) => i.allDay && i.kind !== "event")])
    );
    const hiddenCount =
      segs.length + [...chipsByDay.values()].reduce((sum, list) => sum + list.length, 0);

    const allday = wrap.createDiv({ cls: "brewin-tg-allday" + (open ? "" : " is-collapsed") });
    const alldayGutter = allday.createDiv({ cls: "brewin-tg-gutter brewin-tg-allday-toggle" });
    alldayGutter.createSpan({ cls: "brewin-expander", text: open ? "▾" : "▸" });
    alldayGutter.createSpan({ text: "all-day" });
    // Collapsed, the count is the only clue anything is up there — so always show it.
    if (!open && hiddenCount) alldayGutter.createSpan({ cls: "brewin-count", text: String(hiddenCount) });
    alldayGutter.setAttr("role", "button");
    alldayGutter.setAttr("tabindex", "0");
    alldayGutter.setAttr("aria-expanded", String(open));
    alldayGutter.setAttr(
      "aria-label",
      open ? "Collapse the all-day row" : `Expand the all-day row (${hiddenCount} item${hiddenCount === 1 ? "" : "s"})`
    );
    const toggle = async () => {
      this.plugin.settings.allDayOpen = !this.plugin.settings.allDayOpen;
      await this.plugin.saveSettings();
      this.render();
    };
    alldayGutter.addEventListener("click", toggle);
    alldayGutter.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void toggle();
      }
    });

    if (open) {
      const area = allday.createDiv({ cls: "brewin-tg-allday-area" });
      area.style.setProperty("--bars-h", `${lanes * BAR_H}px`);
      const cols = area.createDiv({ cls: "brewin-tg-allday-cols" });
      cols.style.gridTemplateColumns = `repeat(${days.length}, 1fr)`;
      for (const iso of days) {
        const col = cols.createDiv({ cls: "brewin-tg-allday-col", attr: { "data-drop": "allday", "data-date": iso } });
        (chipsByDay.get(iso) ?? []).forEach((it) => col.appendChild(this.chip(it)));
        col.addEventListener("dblclick", () => this.newEvent(iso));
        this.wireCreateOnHold(col, iso, ".brewin-chip-item");
      }
      if (segs.length) {
        const overlay = area.createDiv({ cls: "brewin-tg-bars" });
        segs.forEach((seg) => overlay.appendChild(this.bar(seg, days.length)));
      }
    } else {
      // A thin strip rather than nothing, so the row stays visible and tappable.
      // Deliberately NOT a drop target: collapsed, there's no column under the pointer to
      // say which day was meant, and silently dropping onto the first day would be wrong.
      allday.createDiv({ cls: "brewin-tg-allday-stub" }).addEventListener("click", toggle);
    }

    // Scrollable hour grid, drawn one row per slot at the chosen resolution.
    const hourPx = this.hourPx;
    const slot = this.slotMinutes;
    const slotPx = (hourPx * slot) / 60;
    const slotCount = (24 * 60) / slot;

    const body = wrap.createDiv({ cls: "brewin-tg-body" });
    const gutter = body.createDiv({ cls: "brewin-tg-gutter-col" });
    for (let i = 0; i < slotCount; i++) {
      const mins = i * slot;
      const onHour = mins % 60 === 0;
      const cell = gutter.createDiv({ cls: "brewin-tg-hour" + (onHour ? "" : " sub") });
      cell.style.height = `${slotPx}px`;
      // Label hours and half-hours; quarter lines stay unlabelled so 15-min zoom
      // gains precision without turning the gutter into 96 numbers.
      if (mins % 30 === 0) cell.setText(formatHM(mins));
    }

    for (const iso of days) {
      const col = body.createDiv({ cls: "brewin-tg-col", attr: { "data-drop": "time", "data-date": iso } });
      col.style.height = `${24 * hourPx}px`;
      for (let i = 0; i < slotCount; i++) {
        const mins = i * slot;
        const line = col.createDiv({ cls: "brewin-tg-line" + (mins % 60 === 0 ? "" : " sub") });
        line.style.top = `${(mins / 60) * hourPx}px`;
      }
      // Live "now" indicator, on today's column only.
      if (iso === today) {
        const nowEl = col.createDiv({ cls: "brewin-now-line" });
        nowEl.createDiv({ cls: "brewin-now-dot" });
        this.nowLines.push(nowEl);
      }
      col.addEventListener("dblclick", () => this.newEvent(iso));
      this.wireCreateOnHold(col, iso, ".brewin-tg-event", (y) => formatHM(this.timeFromY(col, y)));
      // Overlapping blocks share the column side by side instead of covering each other.
      const timed = (byDay.get(iso) ?? []).filter((i) => !i.allDay);
      const places = packOverlaps(timed.map((it) => blockRange(it.start, it.end)));
      timed.forEach((it, idx) => {
        const box = timeBox(it.start, it.end, hourPx);
        const place = places[idx];
        const ev = col.createDiv({ cls: `brewin-tg-event kind-${it.kind} ${it.done ? "done" : ""}` });
        if (it.kind === "event") {
          const color = categoryColor(this.plugin.settings, it.category);
          ev.style.borderLeftColor = color;
          ev.style.background = `color-mix(in srgb, ${color} 25%, var(--background-primary))`;
        }
        ev.style.top = `${box.topPx}px`;
        ev.style.height = `${box.heightPx}px`;
        // 2px inset each side leaves a visible gap between neighbouring blocks.
        ev.style.left = `calc(${(place.column / place.columns) * 100}% + 2px)`;
        ev.style.width = `calc(${(place.span / place.columns) * 100}% - 4px)`;
        if (place.columns > 1) ev.addClass("shared");
        ev.createDiv({ cls: "t", text: (it.recurring ? "🔁 " : "") + it.title });
        if (it.start) ev.createDiv({ cls: "time", text: it.end ? `${it.start}–${it.end}` : it.start });
        if (it.location) ev.createDiv({ cls: "loc", text: `📍 ${it.location}` });
        ev.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.consumeClick()) return;
          // One slot of a multi-slot task: ticking it is the frequent action, not editing —
          // but only for the task's actual CURRENT occurrence. A future virtual occurrence
          // (now that recurring tasks expand across the whole visible range) can't be ticked
          // before it arrives; it opens edit instead, same as a plain future chip would.
          const currentTask = it.slotTime ? this.plugin.store.getByPath(it.path) : null;
          const currentOcc = currentTask ? (currentTask.recurrenceAnchor === "due" ? currentTask.due : currentTask.scheduled) : null;
          if (it.slotTime && currentTask && it.date === currentOcc) void this.toggleSlot(it);
          else this.openEdit(it);
        });
        if (it.kind === "event") {
          ev.addEventListener("contextmenu", (e) => this.eventContextMenu(e, it.path, it.date));
        }
        this.makeDraggable(ev, it);
      });
    }
    this.positionNowLines();

    // Focus the grid on the current time when today is on screen, otherwise 07:00.
    const showsToday = days.includes(today);
    const focusMinutes = showsToday ? nowMinutes() : 7 * 60;
    window.setTimeout(() => {
      const y = (focusMinutes / 60) * hourPx;
      // Sit the moment about a third down the viewport so there's context either side.
      body.scrollTop = Math.max(0, y - body.clientHeight / 3);
    }, 0);
  }

  // ── Drag & drop (pointer-based → works on desktop and touch) ──

  /** Wire an item element for dragging. Project tasks are fixed (surfaced from a project note,
   *  not owned by this store). Recurring tasks and events both drag — the drop asks which
   *  occurrences to move, same "single/following/all" scope either kind. */
  private makeDraggable(el: HTMLElement, item: CalendarItem): void {
    if (item.kind === "project") return;
    el.addClass("brewin-draggable");

    let ghost: HTMLElement | null = null;
    const teardown = () => {
      ghost?.remove();
      ghost = null;
      el.removeClass("brewin-drag-src");
      el.removeClass("brewin-drag-ready");
      this.contentEl.removeClass("brewin-is-dragging");
      this.clearHighlight();
      this.hideSnap();
    };

    attachLongPressDrag(el, {
      holdMs: this.plugin.settings.dragHoldMs,
      onArm: () => {
        // The hold is only discoverable if arming is visible — and felt, where supported.
        el.addClass("brewin-drag-ready");
        el.addClass("brewin-drag-src");
        this.contentEl.addClass("brewin-is-dragging");
        ghost = document.body.createDiv({ cls: "brewin-drag-ghost" });
        ghost.setText(item.title);
        hapticTick();
      },
      onMove: (x, y) => {
        if (ghost) {
          ghost.style.left = x + 10 + "px";
          ghost.style.top = y + 10 + "px";
        }
        this.highlightDrop(x, y);
        this.updateSnapPreview(item, x, y);
      },
      onDrop: (x, y) => {
        teardown();
        // A drag always ends with a click event; swallow it so the note doesn't also open.
        this.suppressClick = true;
        void this.handleDrop(item, x, y);
      },
      onCancel: teardown,
    });
  }

  private dropTargetAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return el?.closest("[data-drop]") as HTMLElement | null;
  }

  private highlightDrop(x: number, y: number): void {
    this.clearHighlight();
    this.dropTargetAt(x, y)?.addClass("brewin-drop-hover");
  }

  private clearHighlight(): void {
    this.contentEl.findAll(".brewin-drop-hover").forEach((e) => e.removeClass("brewin-drop-hover"));
  }

  private async handleDrop(item: CalendarItem, x: number, y: number): Promise<void> {
    const target = this.dropTargetAt(x, y);
    if (!target) return;
    const type = target.getAttribute("data-drop");

    // The "This week" / "This month" panel: dropped here, a task loses its day/time and goes
    // back into that bucket.
    if (type === "week" || type === "month") {
      await this.dropIntoBucket(item, target, type);
      return;
    }

    const date = target.getAttribute("data-date");
    if (!date) return; // day / all-day / time targets all carry a concrete date

    if (item.kind === "task") {
      const stored = this.plugin.store.getByPath(item.path);
      if (!stored) return;
      // Dropping onto a real day or time slot commits the task to that day, so it leaves the
      // loose week/month bucket — strip both here so the same persist that sets the date also
      // clears them.
      const task = stored.week || stored.month ? { ...stored, week: null, month: null } : stored;
      if (task.recurrence) {
        // item.date is the occurrence actually dragged, which is rarely the anchor date —
        // the scope maths needs the occurrence, not task.scheduled.
        this.moveRecurringTask(task, item.date, date, type, target, y);
        return;
      }
      if (type === "time") {
        // Dropped into the hour grid → give it a time block, keeping its duration if it
        // already had one, otherwise the default length.
        const minutes = this.timeFromY(target, y);
        const start = formatHM(minutes);
        const dur = task.startTime && task.endTime ? durationMinutes(task.startTime, task.endTime) : null;
        await this.plugin.store.scheduleAt(
          task,
          date,
          start,
          dur ? addMinutesHM(start, dur) : null,
          this.plugin.settings.defaultTaskMinutes
        );
        new Notice(`${task.title} → ${date} ${start}`);
      } else if (type === "allday") {
        // The ALL DAY band explicitly means "no particular time".
        await this.plugin.store.scheduleAt(task, date, null, null);
        new Notice(`${task.title} → ${date}, all day`);
      } else {
        // A month cell just changes the day — keep any time the task already had, or
        // dragging a 09:00 task across the month would silently strip it.
        await this.plugin.store.setScheduled(task, date);
        new Notice(`Moved to ${date}`);
      }
      this.render();
      return;
    } else if (item.kind === "event") {
      const ev = this.plugin.events.getByPath(item.path);
      if (!ev) return;
      // The three targets mean three different things — conflating "allday" with "day"
      // is what let a timed event land in the ALL DAY band while staying timed.
      const intent: DropIntent =
        type === "time"
          ? { kind: "time", start: formatHM(this.timeFromY(target, y)) }
          : type === "allday"
            ? { kind: "allDay" }
            : { kind: "date" };

      if (ev.recurrence) {
        // item.date is the occurrence that was actually dragged, which is rarely the
        // series' anchor date — the scope maths needs the occurrence, not ev.date.
        this.moveRecurring(ev, item.date, date, intent);
        return;
      }

      await this.plugin.events.reschedule(ev, date, intent);
      new Notice(
        intent.kind === "time"
          ? `${ev.title} → ${date} ${intent.start}`
          : intent.kind === "allDay"
            ? `${ev.title} → ${date}, all day`
            : `Moved to ${date}`
      );
      this.render();
      return;
    }
    new Notice(`Moved to ${date}`);
    this.render();
  }

  /**
   * A calendar item dragged onto the "This week" / "This month" panel: strip its concrete day
   * and time and file the task under that bucket instead — the reverse of dragging a panel row
   * out onto the grid. Tasks only; events have no bucket, and a recurring task's dates belong
   * to its series. Filing into one bucket clears the other.
   */
  private async dropIntoBucket(item: CalendarItem, target: HTMLElement, kind: "week" | "month"): Promise<void> {
    if (item.kind !== "task") {
      new Notice(`Only tasks can be moved to the ${kind} list.`);
      return;
    }
    const task = this.plugin.store.getByPath(item.path);
    if (!task) return;
    if (task.recurrence) {
      new Notice(`"${task.title}" repeats — edit the series to change when it happens.`);
      return;
    }
    const key = target.getAttribute("data-bucket");
    if (!key) return;
    await this.plugin.store.updateFields(task, {
      scheduled: null,
      startTime: null,
      endTime: null,
      endDate: null,
      week: kind === "week" ? key : null,
      month: kind === "month" ? key : null,
    });
    new Notice(`${task.title} → this ${kind}`);
    this.render();
  }

  /**
   * Dropping one occurrence of a repeating event: ask what it should apply to, then hand
   * off to the same `applyRecurringEdit` the edit window uses, so a dragged change and a
   * typed one can't diverge.
   */
  private moveRecurring(
    ev: EventItem,
    occurrenceISO: string,
    newDate: string,
    intent: DropIntent
  ): void {
    // Preserve the event's length rather than the old clock time.
    const dur = ev.startTime && ev.endTime ? durationMinutes(ev.startTime, ev.endTime) : null;
    const toAllDay = intent.kind === "allDay" || (intent.kind === "date" && ev.allDay);
    const start = intent.kind === "time" ? intent.start : toAllDay ? null : ev.startTime;
    const end = start ? (dur ? addMinutesHM(start, dur) : ev.endTime) : null;
    // A multi-day event keeps its LENGTH, not its old end date — dropping endDate here
    // would silently flatten a three-day event into one.
    const spanDays = ev.endDate && ev.endDate > ev.date ? dayDelta(ev.date, ev.endDate) : 0;
    const endDate = spanDays > 0 ? shiftISO(newDate, spanDays) : null;

    new RecurrenceScopeModal(
      this.app,
      async (scope) => {
        if (!scope) return; // dismissed — leave the series untouched
        await this.plugin.events.applyRecurringEdit(ev, occurrenceISO, scope, {
          title: ev.title,
          date: newDate,
          endDate,
          allDay: toAllDay,
          startTime: start,
          endTime: end,
          category: ev.originalCategory,
          recurrence: ev.recurrence,
        });
        new Notice(
          scope === "single"
            ? `"${ev.title}" moved to ${newDate} — this occurrence only.`
            : scope === "following"
              ? `"${ev.title}" and later occurrences moved to ${newDate}.`
              : `Every "${ev.title}" moved.`
        );
        this.render();
      },
      {
        title: "Move recurring event",
        prompt: `"${ev.title}" repeats. Which occurrences should move to ${newDate}?`,
        labels: {
          single: `This occurrence only (${occurrenceISO})`,
          following: "This and all following occurrences",
          all: "Every occurrence — shift the whole series",
        },
      }
    ).open();
  }

  /** The task-side mirror of `moveRecurring` — same scope prompt, `applyRecurringEdit` instead
   *  of the event store's. */
  private moveRecurringTask(
    task: Task,
    occurrenceISO: string,
    newDate: string,
    type: string | null,
    target: HTMLElement,
    y: number
  ): void {
    let startTime: string | null;
    let endTime: string | null;
    if (type === "time") {
      startTime = formatHM(this.timeFromY(target, y));
      const dur = task.startTime && task.endTime
        ? durationMinutes(task.startTime, task.endTime)
        : this.plugin.settings.defaultTaskMinutes;
      endTime = addMinutesHM(startTime, dur);
    } else if (type === "allday") {
      startTime = null;
      endTime = null;
    } else {
      // Month cell: keep whatever time it already had.
      startTime = task.startTime;
      endTime = task.endTime;
    }

    const fields: NewTaskFields = {
      title: task.title,
      scheduled: newDate,
      startTime,
      endTime,
      due: task.due,
      priority: task.priority,
      contexts: task.contexts,
      parent: task.parent,
      recurrence: task.recurrence,
      recurrenceAnchor: task.recurrenceAnchor,
      endDate: task.endDate,
      estimate: task.estimate,
      remind: task.remind,
      remindStart: task.remindStart,
      times: task.times,
      dependsOn: task.dependsOn,
    };

    new RecurrenceScopeModal(
      this.app,
      async (scope) => {
        if (!scope) return; // dismissed — leave the series untouched
        await this.plugin.store.applyRecurringEdit(task, occurrenceISO, scope, fields);
        new Notice(
          scope === "single"
            ? `"${task.title}" moved to ${newDate} — this occurrence only.`
            : scope === "following"
              ? `"${task.title}" and later occurrences moved to ${newDate}.`
              : `Every "${task.title}" moved.`
        );
        this.render();
      },
      {
        title: "Move recurring task",
        prompt: `"${task.title}" repeats. Which occurrences should move to ${newDate}?`,
        labels: {
          single: `This occurrence only (${occurrenceISO})`,
          following: "This and all following occurrences",
          all: "Every occurrence — shift the whole series",
        },
      }
    ).open();
  }

  /**
   * Snap the pointer Y within a time column to a grid slot. Snapping follows the visible
   * resolution but never coarser than 15 min, so a drop always lands on a line you can see.
   */
  private timeFromY(colEl: HTMLElement, clientY: number): number {
    const rect = colEl.getBoundingClientRect();
    const mins = ((clientY - rect.top) / this.hourPx) * 60;
    const snap = Math.min(15, this.slotMinutes);
    const snapped = Math.round(mins / snap) * snap;
    return Math.max(0, Math.min(24 * 60 - snap, snapped));
  }

  /** Returns true (and resets) if the pending click should be swallowed after a drag. */
  private consumeClick(): boolean {
    if (this.suppressClick) {
      this.suppressClick = false;
      return true;
    }
    return false;
  }

  private newEvent(dateISO: string): void {
    new EventModal(this.app, this.plugin.events, this.plugin.settings, () => this.render(), dateISO).open();
  }

  /**
   * Long-press empty grid space → a small menu offering to create a task or event there.
   * `exclude` is a selector for the item elements sharing this container (chips, blocks) —
   * a press that lands on one of those is somebody else's gesture (drag, tap-to-open), not
   * a request to create something new here.
   */
  private wireCreateOnHold(
    el: HTMLElement,
    dateISO: string,
    exclude: string,
    timeAt?: (clientY: number) => string
  ): void {
    attachLongPressTap(el, {
      holdMs: this.plugin.settings.dragHoldMs,
      onLongPress: (x, y, target) => {
        if (target instanceof HTMLElement && target.closest(exclude)) return;
        hapticTick();
        this.createMenuAt(x, y, dateISO, timeAt ? timeAt(y) : null);
      },
    });
  }

  /** The menu itself — same choice either way, just prefilled with where the press landed. */
  private createMenuAt(x: number, y: number, dateISO: string, time: string | null): void {
    const menu = new Menu();
    const label = time ? `${dateISO} ${time}` : dateISO;
    menu.addItem((i) =>
      i
        .setTitle(`New task · ${label}`)
        .setIcon("check-circle")
        .onClick(() =>
          new CaptureModal(this.app, this.plugin.store, this.plugin.settings, () => this.render(), undefined, undefined, {
            scheduled: dateISO,
            startTime: time ?? undefined,
          }).open()
        )
    );
    menu.addItem((i) =>
      i
        .setTitle(`New event · ${label}`)
        .setIcon("calendar")
        .onClick(() =>
          new EventModal(this.app, this.plugin.events, this.plugin.settings, () => this.render(), dateISO, undefined, time ?? undefined).open()
        )
    );
    menu.showAtPosition({ x, y });
  }

  /** Click an event/task → open its edit modal (with an Open-note button inside). */
  private openEdit(item: CalendarItem): void {
    if (item.kind === "event") this.openEventByPath(item.path, item.date);
    else if (item.kind === "task") {
      const t = this.plugin.store.getByPath(item.path);
      if (t) new CaptureModal(this.app, this.plugin.store, this.plugin.settings, () => this.render(), t).open();
    }
  }

  private openEventByPath(path: string, occurrenceISO?: string): void {
    const ev = this.plugin.events.getByPath(path);
    if (ev) new EventModal(this.app, this.plugin.events, this.plugin.settings, () => this.render(), ev, occurrenceISO).open();
  }

  /** Right-click an event on the calendar → edit, open its note, or delete it. */
  private eventContextMenu(e: MouseEvent, path: string, occurrenceISO: string): void {
    const ev = this.plugin.events.getByPath(path);
    if (!ev) return;
    e.preventDefault();
    const menu = new Menu();

    menu.addItem((i) => i.setTitle("Edit event…").setIcon("pencil").onClick(() => this.openEventByPath(path, occurrenceISO)));
    menu.addItem((i) => i.setTitle("Open note").setIcon("file").onClick(() => this.openNote(path)));
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(ev.recurrence ? "Delete occurrences…" : "Delete event…")
        .setIcon("trash")
        .onClick(() => this.deleteEvent(ev, occurrenceISO))
    );
    menu.showAtMouseEvent(e);
  }

  /** Shared delete flow — recurring events ask which occurrences to remove. */
  private deleteEvent(ev: EventItem, occurrenceISO: string): void {
    const finish = (msg: string) => {
      new Notice(msg);
      this.render();
    };
    if (ev.recurrence) {
      new RecurrenceScopeModal(
        this.app,
        async (scope) => {
          if (!scope) return;
          await this.plugin.events.deleteOccurrence(ev, occurrenceISO, scope);
          finish(scope === "all" ? `Deleted "${ev.title}".` : `Updated "${ev.title}".`);
        },
        {
          title: "Delete recurring event",
          prompt: "Which occurrences should be deleted?",
          labels: {
            single: `This occurrence only (${occurrenceISO})`,
            following: "This and all following occurrences",
            all: "Every occurrence — delete the event",
          },
          danger: true,
        }
      ).open();
      return;
    }
    new ConfirmModal(this.app, {
      title: "Delete event",
      body: `"${ev.title}" will be moved to your vault's trash — recoverable via Obsidian's "Deleted files" setting.`,
      cta: "Delete",
      onConfirm: async () => {
        await this.plugin.events.deleteEvent(ev);
        finish(`Deleted "${ev.title}".`);
      },
    }).open();
  }

  /** Open a project note at the exact line of the surfaced task. */
  private async openProjectLine(item: CalendarItem): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(item.path);
    if (!(f instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(f, item.line != null ? { eState: { line: item.line } } : undefined);
  }

  /** Show a preview box at the snapped time while dragging a timed event over a day column. */
  private updateSnapPreview(item: CalendarItem, x: number, y: number): void {
    const target = this.dropTargetAt(x, y);
    const timeable = item.kind === "event" || item.kind === "task";
    if (timeable && target?.getAttribute("data-drop") === "time") {
      const mins = this.timeFromY(target, y);
      // An all-day item being given a time has no duration yet — preview the default block.
      const dur = item.allDay
        ? this.plugin.settings.defaultTaskMinutes
        : durationMinutes(item.start, item.end);
      if (!this.snapEl || this.snapEl.parentElement !== target) {
        this.hideSnap();
        this.snapEl = target.createDiv({ cls: "brewin-snap-preview" });
      }
      this.snapEl.style.top = `${(mins / 60) * this.hourPx}px`;
      this.snapEl.style.height = `${(dur / 60) * this.hourPx}px`;
      this.snapEl.setText(formatHM(mins));
    } else {
      this.hideSnap();
    }
  }

  private hideSnap(): void {
    this.snapEl?.remove();
    this.snapEl = null;
  }

  /**
   * Tick or untick one time-slot of a multi-slot task straight from the calendar.
   * When this closes the day the store rolls the task to its next occurrence, so it
   * vanishes from today and returns tomorrow with a clean sheet.
   */
  private async toggleSlot(item: CalendarItem): Promise<void> {
    const task = this.plugin.store.getByPath(item.path);
    if (!task || !item.slotTime) return;
    const res = await this.plugin.store.toggleSlot(task, item.slotTime, item.date);
    if (!res.ok) {
      new Notice(`Can't complete — ${res.open} subtask${res.open === 1 ? "" : "s"} still open.`);
      return;
    }
    const after = this.plugin.store.getByPath(item.path);
    if (after) {
      const p = slotProgress(after.times ?? [], after.completeSlots ?? {}, item.date);
      if (p.dayComplete) new Notice(`"${after.title}" done for the day.`);
    }
    this.render();
  }

  private openNote(path: string): void {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) this.app.workspace.getLeaf(false).openFile(f);
  }
}
