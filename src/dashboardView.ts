import { App, ItemView, Menu, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { classify, groupByContext, groupByDate } from "./buckets";
import { todayISO } from "./dates";
import { pickDate } from "./datePicker";
import { ProjectTask, ProjectTaskSource } from "./projectTasks";
import { CaptureModal } from "./captureModal";
import { buildIndex, canComplete, childrenOf, progressOf, TaskIndex, validParentCandidates } from "./hierarchy";
import { openDependencies } from "./dependencies";
import { isSlotDone, slotProgress, slotTitle } from "./slots";
import { TaskSuggestModal } from "./taskSuggestModal";
import { DeleteTaskModal } from "./deleteTaskModal";
import type BrewinTasksPlugin from "./main";
import { eventsToItems, projectTasksToItems, tasksToItems } from "./calendarItem";
import { attachLongPressDrag, hapticTick } from "./dragHandle";
import { buildContextIndex, canonicaliseContext, ContextIndex, filterableContexts, hasContext } from "./contexts";
import { ConfirmModal } from "./confirmModal";
import { search } from "./search";
import { stepAnchor, visibleRange } from "./calendar";
import { EventModal } from "./eventModal";
import { PROJECTS_CATEGORY } from "./settings";
import { formatEstimate, parseEstimate, workload } from "./estimate";
import {
  attentionTasks,
  DASH_VIEWS,
  DashView,
  groupByProject,
  inboxTasks,
  eventMinutesOn,
  expandRecurringTasks,
  reviewAnchor,
  reviewRowCount,
  ReviewRow,
  reviewWeek,
  spanLabel,
  tasksByPriority,
  todayAgenda,
  unscheduledTasks,
  weekAgenda,
} from "./views";
import { CalendarItem, Task } from "./types";

export const BREWIN_VIEW_TYPE = "brewin-tasks-dashboard";

const PRIORITY_ICON: Record<string, string> = { high: "🔴", normal: "", low: "🔽" };

/** "Fri 31 Jul" — compact enough for a board column header. */
function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** "Monday 27 July" — UTC-parsed so it can't drift a day across a timezone boundary. */
function prettyDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

export class DashboardView extends ItemView {
  private contextFilter: string | null = null;
  private groupBy: "date" | "context" = "date";
  /** Which dashboard view is showing. */
  private view: DashView = "today";
  /** Hierarchy index for the current render pass. */
  private index: TaskIndex = buildIndex([]);
  /** Every task (unfiltered), for the current render pass — lets a row check its own
   *  dependencies without a redundant full re-fetch. */
  private allTasks: Task[] = [];
  /** Paths of parents whose subtasks are expanded (survives re-render). */
  private expanded = new Set<string>();
  /** Set after a drag so the click that follows doesn't also open the task. */
  private suppressClick = false;
  /** Free-text filter applied to the current view. */
  private query = "";
  /** Selection mode: rows gain a tick box and the bulk bar appears. */
  private selecting = false;
  /** Paths of selected tasks (survives re-render). */
  private selected = new Set<string>();
  /** Which day/week the Review page is showing (any date inside it, for week mode). */
  private reviewAnchorISO: string | null = null;
  /** Review page: a full week to transcribe, or a single day to triage and staff. */
  private reviewView: "week" | "day" = "week";
  /** Whether the Day view's Unscheduled section is expanded. Session state, not persisted —
   *  once triaged, it's off your mind rather than something you'd configure permanently. */
  private reviewUnschOpen = true;
  /** Rows already copied into the paper journal. Session state — never written to a note. */
  private transferred = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private plugin: BrewinTasksPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return BREWIN_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Brewin Planner";
  }
  getIcon(): string {
    return "checkmark";
  }

  async onOpen(): Promise<void> {
    // Checked ONCE per fresh leaf open, not on every render — otherwise clearing your own
    // backlog mid-session would yank you back to Today while you're still looking at Attention.
    if (this.plugin.settings.dashboardDefaultToAttentionWhenBehind) {
      const today = todayISO();
      const att = attentionTasks(this.plugin.store.getTasks(), today);
      if (att.overdue.length + att.slipped.length > 0) this.view = "attention";
    }
    await this.render();
  }

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("brewin-dashboard");

    const today = todayISO();
    const allTasks = this.plugin.store.getTasks();
    this.allTasks = allTasks;
    // Index over ALL tasks so parent/child relations survive context filtering.
    this.index = buildIndex(allTasks);
    let tasks = allTasks;
    // Case-insensitive, so filtering `obsidian` also catches a note tagged `Obsidian`.
    if (this.contextFilter) tasks = tasks.filter((t) => hasContext(t.contexts, this.contextFilter!));
    // Search narrows whatever view is showing rather than replacing it, so you can search
    // within Inbox, within Today, and so on.
    if (this.query.trim()) tasks = search(tasks, this.query);

    const buckets = classify(tasks, today);

    // ── Toolbar ──
    const toolbar = root.createDiv({ cls: "brewin-toolbar" });
    toolbar.createEl("button", { text: "＋ New task", cls: "mod-cta" }).addEventListener("click", () => {
      new CaptureModal(this.app, this.plugin.store, this.plugin.settings, () => this.render()).open();
    });
    toolbar.createEl("button", { text: "⟳" }).addEventListener("click", () => this.render());

    const searchEl = toolbar.createEl("input", { cls: "brewin-search", type: "search" });
    searchEl.placeholder = "Search tasks…";
    searchEl.value = this.query;
    searchEl.addEventListener("input", () => {
      this.query = searchEl.value;
      this.render();
      // Re-rendering replaces the input, so put the caret back where it was.
      const again = this.contentEl.querySelector<HTMLInputElement>(".brewin-search");
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    });

    const selBtn = toolbar.createEl("button", {
      text: this.selecting ? "Done" : "☑ Select",
      cls: this.selecting ? "mod-cta" : "",
    });
    selBtn.addEventListener("click", () => {
      this.selecting = !this.selecting;
      if (!this.selecting) this.selected.clear();
      this.render();
    });

    // ── View switcher ──
    const att = attentionTasks(allTasks, today);
    const attentionCount = att.overdue.length + att.slipped.length;
    const seg = root.createDiv({ cls: "brewin-view-seg" });
    for (const v of DASH_VIEWS) {
      const label = v.id === "attention" && attentionCount ? `${v.icon} ${v.label} (${attentionCount})` : `${v.icon} ${v.label}`;
      const b = seg.createEl("button", {
        text: label,
        cls: this.view === v.id ? "active" : "",
      });
      b.setAttr("aria-current", String(this.view === v.id));
      b.addEventListener("click", () => {
        this.view = v.id;
        this.render();
      });
    }

    // Layout toggle — only Week and Projects have headings to turn into columns.
    if (this.view === "week" || this.view === "projects") {
      const key = this.view === "week" ? "weekLayout" : "projectsLayout";
      const current = this.plugin.settings[key];
      const lay = seg.createDiv({ cls: "brewin-layout-seg" });
      ([
        ["list", "≡ List"],
        ["board", "▦ Board"],
      ] as const).forEach(([value, label]) => {
        const b = lay.createEl("button", { text: label, cls: current === value ? "active" : "" });
        b.addEventListener("click", async () => {
          this.plugin.settings[key] = value;
          await this.plugin.saveSettings();
          this.render();
        });
      });
    }

    // A fixed host so ticking a box redraws only the bar — a full re-render would drop
    // scroll position and search focus on every tick.
    root.createDiv({ cls: "brewin-bulk-host" });

    // Context filter — only contexts with OPEN tasks, case-merged, with their counts, so
    // every option in the list can actually show something.
    const contexts = filterableContexts(allTasks);
    if (contexts.length) {
      const sel = toolbar.createEl("select", { cls: "brewin-context-filter" });
      sel.createEl("option", { text: "All contexts", value: "" });
      contexts.forEach((c) => sel.createEl("option", { text: `${c.value} (${c.count})`, value: c.value }));
      // A previously-selected context can disappear once its last task is done; fall back
      // to "All" rather than leaving the filter stuck on an option that no longer exists.
      if (this.contextFilter && !contexts.some((c) => c.value === this.contextFilter)) {
        this.contextFilter = null;
        tasks = allTasks;
      }
      sel.value = this.contextFilter ?? "";
      sel.addEventListener("change", () => {
        this.contextFilter = sel.value || null;
        this.render();
      });

      // Group-by toggle — grouping by context is most useful once a context is selected,
      // because it then splits the list by the OTHER contexts on those tasks.
      const grp = toolbar.createEl("select", { cls: "brewin-groupby" });
      grp.createEl("option", { text: "Group: date", value: "date" });
      grp.createEl("option", { text: "Group: context", value: "context" });
      grp.value = this.groupBy;
      grp.addEventListener("change", () => {
        this.groupBy = grp.value === "context" ? "context" : "date";
        this.render();
      });
    }

    // Group-by-context is an "All" refinement; the focused views have their own shape.
    if (this.view === "all" && this.groupBy === "context") {
      this.renderByContext(root, tasks);
      return;
    }

    if (this.view === "today") { this.renderToday(root, tasks, today); return this.renderBulkBar(); }
    if (this.view === "week") { this.renderWeek(root, tasks, today); return this.renderBulkBar(); }
    if (this.view === "inbox") { this.renderInbox(root, tasks); return this.renderBulkBar(); }
    if (this.view === "attention") { this.renderAttention(root, tasks, today); return this.renderBulkBar(); }
    if (this.view === "projects") { await this.renderProjects(root, today); return this.renderBulkBar(); }
    if (this.view === "review") { await this.renderReview(root, today); return this.renderBulkBar(); }

    // ── Buckets (All) ──
    this.section(root, "🔴 Overdue", buckets.overdue, "brewin-overdue");
    this.section(root, "📌 Today", buckets.today, "brewin-today");

    if (buckets.upcoming.length) {
      const head = this.sectionHeader(root, "🗓 Upcoming", buckets.upcoming.length);
      const body = root.createDiv();
      head.addEventListener("click", () => body.toggleClass("brewin-collapsed", !body.hasClass("brewin-collapsed")));
      for (const group of groupByDate(buckets.upcoming)) {
        body.createEl("div", { cls: "brewin-date-label", text: group.date });
        group.tasks.forEach((t) => this.taskRow(body, t));
      }
    }

    this.section(root, "📥 Unplanned", buckets.unplanned, "brewin-unplanned");
    this.section(root, "⏸ On hold", buckets.onhold, "brewin-onhold");

    // ── Project tasks ──
    if (this.plugin.settings.showProjectTasks) {
      const src = new ProjectTaskSource(this.app, this.plugin.settings);
      const projTasks = await src.getProjectTasks();
      const filtered = projTasks.filter((p) => (this.contextFilter ? false : true));
      if (filtered.length) {
        this.sectionHeader(root, "⚡ Project tasks", filtered.length);
        const byProject = new Map<string, ProjectTask[]>();
        filtered.forEach((p) => {
          if (!byProject.has(p.projectName)) byProject.set(p.projectName, []);
          byProject.get(p.projectName)!.push(p);
        });
        for (const [name, items] of byProject) {
          root.createEl("div", { cls: "brewin-date-label", text: name });
          items.forEach((p) => this.projectRow(root, src, p, today));
        }
      }
    }

    // ── Done today (optional) ──
    if (this.plugin.settings.showCompleted) {
      const done = tasks.filter((t) => t.status === "done" && t.completed === today);
      if (done.length) {
        this.sectionHeader(root, "✅ Done today", done.length);
        done.forEach((t) => this.taskRow(root, t, true));
      }
    }

    if (
      !buckets.overdue.length &&
      !buckets.today.length &&
      !buckets.upcoming.length &&
      !buckets.unplanned.length &&
      !buckets.onhold.length
    ) {
      root.createDiv({ cls: "brewin-empty", text: "No tasks. Press ＋ New task to capture one." });
    }
    this.renderBulkBar();
  }

  // ── Board cards ────────────────────────────────────────────────────────────

  /** A draggable task card. Dropping it on another day column reschedules it. */
  private card(parent: HTMLElement, task: Task, dayISO: string): void {
    const el = parent.createDiv({ cls: "brewin-card" + (task.status === "hold" ? " is-hold" : "") });

    const top = el.createDiv({ cls: "brewin-card-top" });
    const cb = top.createEl("input", { type: "checkbox" });
    cb.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const res = await this.plugin.store.complete(task);
      if (!res.ok) {
        new Notice(`Can't complete "${task.title}" — ${res.open} subtask${res.open === 1 ? "" : "s"} still open.`);
        return;
      }
      this.render();
    });
    const pri = PRIORITY_ICON[task.priority];
    top.createSpan({ cls: "brewin-card-title", text: `${pri ? pri + " " : ""}${task.recurrence ? "🔁 " : ""}${task.title}` });

    const meta = el.createDiv({ cls: "brewin-card-meta" });
    const span = spanLabel(task, dayISO);
    if (span) meta.createSpan({ cls: "brewin-card-span", text: span });
    if (task.times?.length) {
      const p = slotProgress(task.times, task.completeSlots ?? {}, dayISO);
      meta.createSpan({ cls: "brewin-slot-chip", text: `${p.done}/${p.total}` });
    }
    if (task.startTime) meta.createSpan({ text: task.startTime });
    if (task.due) meta.createSpan({ cls: "brewin-meta-due", text: `🚩 ${task.due}` });
    if (task.estimate) meta.createSpan({ cls: "brewin-meta-est", text: `⏱ ${formatEstimate(task.estimate)}` });
    task.contexts.forEach((c) => meta.createSpan({ cls: "brewin-meta-ctx", text: `@${c}` }));

    el.addEventListener("click", () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.editTask(task);
    });
    // A recurring task's date is owned by its rule; dragging it would fight the recurrence.
    if (!task.recurrence) this.makeCardDraggable(el, task.title, (iso) => this.plugin.store.setScheduled(task, iso));
  }

  /** A project checkbox as a card. Read-only position — the column IS its project note. */
  private projectCard(parent: HTMLElement, src: ProjectTaskSource, pt: ProjectTask, today: string): void {
    void today;
    const el = parent.createDiv({ cls: "brewin-card" });
    const top = el.createDiv({ cls: "brewin-card-top" });
    const cb = top.createEl("input", { type: "checkbox" });
    cb.addEventListener("click", async (e) => {
      e.preventDefault();
      await src.complete(pt);
      this.render();
    });
    top.createSpan({ cls: "brewin-card-title", text: pt.text || "(untitled task)" });

    const meta = el.createDiv({ cls: "brewin-card-meta" });
    if (pt.scheduled) meta.createSpan({ text: `📅 ${pt.scheduled}` });
    if (pt.due) meta.createSpan({ cls: "brewin-meta-due", text: `🚩 ${pt.due}` });
    el.addEventListener("click", () => this.openProjectLine(pt));
  }

  /**
   * Pointer-based drag so it works with touch as well as a mouse (matching the calendar).
   * Movement under 6px is treated as a click, so tapping a card still opens it.
   */
  private makeCardDraggable(el: HTMLElement, title: string, apply: (iso: string) => Promise<void>): void {
    el.addClass("brewin-draggable");

    let ghost: HTMLElement | null = null;
    const teardown = () => {
      ghost?.remove();
      ghost = null;
      el.removeClass("brewin-drag-src");
      el.removeClass("brewin-drag-ready");
      this.contentEl.removeClass("brewin-is-dragging");
      this.clearColumnHighlight();
    };

    attachLongPressDrag(el, {
      holdMs: this.plugin.settings.dragHoldMs,
      onArm: () => {
        el.addClass("brewin-drag-ready");
        el.addClass("brewin-drag-src");
        this.contentEl.addClass("brewin-is-dragging");
        ghost = document.body.createDiv({ cls: "brewin-drag-ghost" });
        ghost.setText(title);
        hapticTick();
      },
      onMove: (x, y) => {
        if (ghost) {
          ghost.style.left = x + 10 + "px";
          ghost.style.top = y + 10 + "px";
        }
        this.highlightColumn(x, y);
      },
      onDrop: async (x, y) => {
        const target = this.columnAt(x, y);
        const iso = target?.getAttribute("data-drop-date");
        teardown();
        this.suppressClick = true; // the trailing click must not also open the task
        if (iso) {
          await apply(iso);
          new Notice(`"${title}" moved to ${shortDate(iso)}.`);
          this.render();
        }
      },
      onCancel: teardown,
    });
  }

  private columnAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return (el?.closest("[data-drop-date]") as HTMLElement | null) ?? null;
  }

  private highlightColumn(x: number, y: number): void {
    this.clearColumnHighlight();
    this.columnAt(x, y)?.addClass("brewin-drop-active");
  }

  private clearColumnHighlight(): void {
    this.contentEl.findAll(".brewin-drop-active").forEach((e) => e.removeClass("brewin-drop-active"));
  }

  // ── Weekly review ──────────────────────────────────────────────────────────

  /**
   * One page for transcribing a week — or a single day — into the paper journal: everything
   * that happens, in the order you'd write it down.
   *
   * Unlike Week (tasks only, rolling 7 days) this is Mon–Sun aligned in week mode, includes
   * events and project tasks, and can move between weeks or days. Day mode additionally
   * surfaces a priority breakdown and a way to slot unscheduled tasks straight into that day —
   * neither makes sense across a whole week, where "the day" is ambiguous.
   */
  private async renderReview(root: HTMLElement, today: string): Promise<void> {
    const s = this.plugin.settings;
    if (this.reviewAnchorISO === null) this.reviewAnchorISO = reviewAnchor(today, s.firstDayOfWeek);
    const { from, to } = visibleRange(this.reviewView, this.reviewAnchorISO, s.firstDayOfWeek);

    // Recurring tasks are EXPANDED across the range rather than shown on their single current
    // date — otherwise a daily routine like the litter tray is absent from any day/week you
    // haven't lived yet, which is exactly what's being transcribed or triaged.
    // The two sets are disjoint, so nothing appears twice.
    // Held tasks are excluded alongside done ones: parked work isn't something you'd write
    // into the journal as an action, and `expandRecurringTasks` already skips them, so this
    // keeps the recurring and non-recurring paths consistent.
    const allTasks = this.plugin.store.getTasks().filter((t) => t.status !== "done" && t.status !== "hold");
    const items: CalendarItem[] = [
      ...eventsToItems(this.plugin.events.getEvents(), from, to),
      ...tasksToItems(allTasks.filter((t) => !t.recurrence), from, to, s.slotBlockMinutes),
      ...expandRecurringTasks(allTasks.filter((t) => !!t.recurrence), from, to, s.slotBlockMinutes),
    ];
    if (s.showProjectTasks) {
      const src = new ProjectTaskSource(this.app, this.plugin.settings);
      items.push(...projectTasksToItems(await src.getProjectTasks(true), from, to, PROJECTS_CATEGORY));
    }

    const days = reviewWeek(items, from, to);
    const total = reviewRowCount(days);

    // ── Navigation ──
    const nav = root.createDiv({ cls: "brewin-review-nav" });
    const seg = nav.createDiv({ cls: "brewin-view-seg" });
    (["week", "day"] as const).forEach((v) => {
      const b = seg.createEl("button", { text: v === "week" ? "Week" : "Day", cls: this.reviewView === v ? "active" : "" });
      b.addEventListener("click", () => this.setReviewView(v));
    });
    nav.createEl("button", { text: "‹" }).addEventListener("click", () =>
      this.setReviewAnchor(stepAnchor(this.reviewView, this.reviewAnchorISO!, -1))
    );
    nav.createSpan({
      cls: "brewin-review-range",
      text: this.reviewView === "day" ? prettyDate(from) : `${prettyDate(from)} – ${prettyDate(to)}`,
    });
    nav.createEl("button", { text: "›" }).addEventListener("click", () =>
      this.setReviewAnchor(stepAnchor(this.reviewView, this.reviewAnchorISO!, 1))
    );
    if (this.reviewView === "week") {
      nav.createEl("button", { text: "This week" }).addEventListener("click", () => this.setReviewAnchor(today));
      nav.createEl("button", { text: "Next week" }).addEventListener("click", () =>
        this.setReviewAnchor(stepAnchor("week", today, 1))
      );
    } else {
      nav.createEl("button", { text: "Today" }).addEventListener("click", () => this.setReviewAnchor(today));
      nav.createEl("button", { text: "Tomorrow" }).addEventListener("click", () =>
        this.setReviewAnchor(stepAnchor("day", today, 1))
      );
    }

    // ── Day-only planning aids: today's shape before transcribing it ──
    if (this.reviewView === "day") {
      this.renderReviewPriority(root, items, this.reviewAnchorISO);
      this.renderReviewUnscheduled(root, this.reviewAnchorISO);
    }

    const count = root.createDiv({ cls: "brewin-review-count" });
    const renderCount = () => {
      const n = days
        .flatMap((d) => [...d.allDay, ...d.timed, ...d.untimed])
        .filter((r) => this.transferred.has(r.key)).length;
      const noun = this.reviewView === "day" ? "today" : "this week";
      count.setText(total ? `${n} of ${total} transferred` : `Nothing scheduled ${noun}.`);
      count.toggleClass("is-done", total > 0 && n === total);
    };

    if (!total) {
      renderCount();
      return;
    }

    for (const day of days) {
      const rows = [...day.allDay, ...day.timed, ...day.untimed];
      const head = root.createDiv({ cls: "brewin-review-day" + (day.date === today ? " is-today" : "") });
      head.createSpan({ text: prettyDate(day.date) });
      if (rows.length) head.createSpan({ cls: "brewin-count", text: String(rows.length) });

      if (!rows.length) {
        root.createDiv({ cls: "brewin-day-clear", text: "clear" });
        continue;
      }
      for (const row of rows) this.reviewRow(root, row, renderCount);
    }

    renderCount();
  }

  /** Change day/week and clear the ticks — they belong to the range you were copying out. */
  private setReviewAnchor(anchorISO: string): void {
    this.reviewAnchorISO = anchorISO;
    this.transferred.clear();
    this.render();
  }

  /**
   * Switch between the week transcription and the single-day planning view. The ticks stay —
   * you haven't moved to a different day/week, just changed how much of it is shown.
   * Switching TO Day picks today if it falls inside the week you were looking at, else that
   * week's first day, so you don't land somewhere unrelated to what was on screen.
   */
  private setReviewView(view: "week" | "day"): void {
    if (view === this.reviewView) return;
    if (view === "day") {
      const s = this.plugin.settings;
      const { from, to } = visibleRange("week", this.reviewAnchorISO ?? todayISO(), s.firstDayOfWeek);
      const today = todayISO();
      this.reviewAnchorISO = today >= from && today <= to ? today : from;
    }
    this.reviewView = view;
    this.render();
  }

  /** "What are my three things today" — a day's open tasks grouped by priority, separate from
   *  the chronological transcription list below. */
  private renderReviewPriority(root: HTMLElement, items: CalendarItem[], dayISO: string): void {
    const grouped = tasksByPriority(items, dayISO);
    if (!grouped.high.length && !grouped.normal.length && !grouped.low.length) return;

    const box = root.createDiv({ cls: "brewin-review-priority" });
    box.createEl("h4", { text: "Today's tasks, by priority" });
    const group = (label: string, cls: string, list: CalendarItem[]) => {
      if (!list.length) return;
      const g = box.createDiv({ cls: `brewin-review-pri-group ${cls}` });
      g.createSpan({ cls: "brewin-review-pri-label", text: label });
      const rows = g.createDiv({ cls: "brewin-review-pri-rows" });
      for (const it of list) {
        const row = rows.createDiv({ cls: "brewin-review-pri-row" });
        if (it.start) row.createSpan({ cls: "brewin-review-pri-time", text: it.start });
        row.createSpan({ cls: "brewin-task-link", text: it.title }).addEventListener("click", () => {
          const task = this.plugin.store.getByPath(it.path);
          if (task) new CaptureModal(this.app, this.plugin.store, this.plugin.settings, () => this.render(), task).open();
        });
      }
    };
    group("High", "high", grouped.high);
    group("Normal", "normal", grouped.normal);
    group("Low", "low", grouped.low);
  }

  /** Open tasks with no do-date yet, each one click away from landing on the day you're
   *  reviewing — the whole point of looking a day ahead is filling it in. */
  private renderReviewUnscheduled(root: HTMLElement, dayISO: string): void {
    const list = unscheduledTasks(this.plugin.store.getTasks());
    if (!list.length) return;

    const open = this.reviewUnschOpen;
    const box = root.createDiv({ cls: "brewin-review-unscheduled" + (open ? "" : " is-collapsed") });
    const head = box.createDiv({ cls: "brewin-review-unsch-head" });
    head.createSpan({ cls: "brewin-expander", text: open ? "▾" : "▸" });
    head.createEl("h4", { text: `Unscheduled — slot into ${prettyDate(dayISO)}` });
    head.createSpan({ cls: "brewin-count", text: String(list.length) });
    head.setAttr("role", "button");
    head.setAttr("tabindex", "0");
    head.setAttr("aria-expanded", String(open));
    head.setAttr("aria-label", open ? "Collapse unscheduled tasks" : `Expand unscheduled tasks (${list.length})`);
    const toggle = () => {
      this.reviewUnschOpen = !this.reviewUnschOpen;
      this.render();
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    if (!open) return;

    for (const task of list) {
      const row = box.createDiv({ cls: "brewin-review-unsch-row" });
      const pri = PRIORITY_ICON[task.priority];
      row.createSpan({ cls: "brewin-task-link", text: `${pri ? pri + " " : ""}${task.title}` }).addEventListener("click", () => {
        new CaptureModal(this.app, this.plugin.store, this.plugin.settings, () => this.render(), task).open();
      });
      const btn = row.createEl("button", { text: "📅 Schedule", cls: "brewin-chip brewin-chip-mini" });
      btn.addEventListener("click", async () => {
        await this.plugin.store.setScheduled(task, dayISO);
        new Notice(`"${task.title}" → ${dayISO}`);
        this.render();
      });
    }
  }

  private reviewRow(parent: HTMLElement, row: ReviewRow, onTick: () => void): void {
    const el = parent.createDiv({
      cls: "brewin-review-row" + (this.transferred.has(row.key) ? " is-transferred" : "") + (row.done ? " is-done" : ""),
    });

    // This tick means "written into the journal" — NOT done. It never touches a note.
    const tick = el.createEl("input", { type: "checkbox", cls: "brewin-transfer-box" });
    tick.checked = this.transferred.has(row.key);
    tick.setAttr("aria-label", `Mark ${row.title} as transferred`);
    tick.addEventListener("click", (e) => {
      e.stopPropagation();
      if (tick.checked) this.transferred.add(row.key);
      else this.transferred.delete(row.key);
      // Only the row and the counter change — a full re-render would lose your scroll
      // position halfway down a 34-row week, which is exactly when it matters.
      el.toggleClass("is-transferred", tick.checked);
      onTick();
    });

    el.createSpan({
      cls: "brewin-review-time",
      text: row.time ? (row.endTime && row.endTime !== row.time ? `${row.time}–${row.endTime}` : row.time) : "—",
    });

    const title = el.createSpan({ cls: "brewin-review-title brewin-task-link", text: row.title });
    title.addEventListener("click", () => this.openReviewItem(row));

    const meta = el.createDiv({ cls: "brewin-review-meta" });
    meta.createSpan({ cls: `brewin-review-kind kind-${row.kind}`, text: row.kind });

    // Tasks keep the dashboard's inline affordances; events and project rows don't have them.
    if (row.kind === "task") {
      const task = this.plugin.store.getByPath(row.path);
      if (task) {
        const actions = el.createDiv({ cls: "brewin-task-actions" });
        this.iconBtn(actions, "📅", "Reschedule", async () => {
          const r = await pickDate(this.app, task.scheduled, this.plugin.settings.firstDayOfWeek, {
            selectedLabel: "Scheduled",
            relatedISO: task.due,
            relatedLabel: "Due",
          });
          if (r !== undefined) {
            await this.plugin.store.setScheduled(task, r);
            this.render();
          }
        });
        this.iconBtn(actions, "⋯", "More", (ev) => this.rowMenu(ev, task));
      }
    }
  }

  private openReviewItem(row: ReviewRow): void {
    if (row.kind === "project") {
      void this.openProjectLine({ projectPath: row.path, line: row.line ?? 0 } as ProjectTask);
      return;
    }
    if (row.kind === "event") {
      const ev = this.plugin.events.getByPath(row.path);
      if (ev) new EventModal(this.app, this.plugin.events, this.plugin.settings, () => this.render(), ev).open();
      return;
    }
    const task = this.plugin.store.getByPath(row.path);
    if (task) new CaptureModal(this.app, this.plugin.store, this.plugin.settings, () => this.render(), task).open();
  }

  // ── Bulk triage ────────────────────────────────────────────────────────────

  /** The tasks currently ticked, resolved fresh so they reflect the latest file state. */
  private selectedTasks(): Task[] {
    const byPath = new Map(this.plugin.store.getTasks().map((t) => [t.path, t]));
    return [...this.selected].map((p) => byPath.get(p)).filter((t): t is Task => !!t);
  }

  /**
   * Redraw just the bulk bar. Ticking a box must not re-render the whole list — that would
   * lose scroll position and search focus on every single tick.
   */
  private renderBulkBar(): void {
    const host = this.contentEl.querySelector<HTMLElement>(".brewin-bulk-host");
    if (!host) return;
    host.empty();
    const n = this.selected.size;
    if (!n) return;

    const bar = host.createDiv({ cls: "brewin-bulk-bar" });
    bar.createSpan({ cls: "brewin-bulk-count", text: `${n} selected` });

    const act = (label: string, fn: () => Promise<void> | void, cls = "") =>
      bar.createEl("button", { text: label, cls }).addEventListener("click", async () => {
        await fn();
      });

    const after = (msg: string) => {
      new Notice(msg);
      this.selected.clear();
      this.render();
    };

    act("📅 Schedule…", async () => {
      const picked = await pickDate(this.app, todayISO(), this.plugin.settings.firstDayOfWeek, {
        selectedLabel: "Scheduled",
      });
      if (picked === undefined) return; // dismissed
      const tasks = this.selectedTasks();
      const changed = await this.plugin.store.bulkSchedule(tasks, picked);
      after(picked ? `Scheduled ${changed} task${changed === 1 ? "" : "s"} for ${picked}.` : `Cleared the date on ${changed}.`);
    });

    act("＠ Context…", () => {
      const idx = buildContextIndex(
        this.plugin.store.getTasks().flatMap((t) => t.contexts),
        this.plugin.settings.contexts
      );
      new ContextPromptModal(this.app, idx, async (value) => {
        if (!value) return;
        const changed = await this.plugin.store.bulkAddContext(this.selectedTasks(), value);
        after(`Added @${value} to ${changed} task${changed === 1 ? "" : "s"}.`);
      }).open();
    });

    act("⏱ Estimate…", () => {
      new EstimatePromptModal(this.app, async (minutes) => {
        const changed = await this.plugin.store.bulkSetEstimate(this.selectedTasks(), minutes);
        after(minutes ? `Set ${formatEstimate(minutes)} on ${changed}.` : `Cleared the estimate on ${changed}.`);
      }).open();
    });

    act("🔴 Priority", async () => {
      const changed = await this.plugin.store.bulkSetPriority(this.selectedTasks(), "high");
      after(`${changed} task${changed === 1 ? "" : "s"} set to high.`);
    });

    act("⏸ Hold", async () => {
      const changed = await this.plugin.store.bulkSetStatus(this.selectedTasks(), "hold");
      after(`${changed} task${changed === 1 ? "" : "s"} put on hold.`);
    });

    act("✓ Complete", async () => {
      const { done, blocked } = await this.plugin.store.bulkComplete(this.selectedTasks());
      after(
        blocked.length
          ? `Completed ${done}. ${blocked.length} blocked (open subtasks or unfinished dependencies): ${blocked.map((b) => b.title).join(", ")}`
          : `Completed ${done} task${done === 1 ? "" : "s"}.`
      );
    });

    act(
      "🗑 Delete",
      () => {
        const tasks = this.selectedTasks();
        new ConfirmModal(this.app, {
          title: `Delete ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
          body:
            `They'll go to your vault's trash (recoverable via Obsidian's "Deleted files" setting). ` +
            `Any subtasks are kept and un-parented rather than deleted with them.`,
          cta: "Delete",
          onConfirm: async () => {
            const removed = await this.plugin.store.bulkDelete(tasks);
            after(`Deleted ${removed} note${removed === 1 ? "" : "s"}.`);
          },
        }).open();
      },
      "mod-warning"
    );

    bar.createEl("button", { text: "Clear" }).addEventListener("click", () => {
      this.selected.clear();
      this.render();
    });
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  /** Today: overdue pinned on top, then the day in clock order, then anything undated. */
  private renderToday(root: HTMLElement, tasks: Task[], today: string): void {
    const events = this.plugin.settings.showEventsOnCalendar
      ? eventsToItems(this.plugin.events.getEvents(), today, today)
      : [];
    const a = todayAgenda(tasks, events, today);

    const head = root.createDiv({ cls: "brewin-today-head" });
    head.createSpan({ cls: "brewin-today-date", text: prettyDate(today) });
    head.createSpan({
      cls: "brewin-count",
      text: a.openCount === 0 ? `all clear · ${a.doneCount} done` : `${a.openCount} left · ${a.doneCount} done`,
    });
    const autoBtn = head.createEl("button", { text: "⚡ Auto-schedule today", cls: "brewin-chip-mini" });
    autoBtn.addEventListener("click", async () => {
      const res = await this.plugin.autoScheduleToday();
      this.plugin.reportAutoSchedule(res);
      this.render();
    });

    // ── Does today's intended work fit the time left in it? ──
    // Free time = the trackable day minus what events already occupy. Compared against the
    // estimates on today's open tasks; unestimated ones are reported separately so the
    // figure is never a total that quietly treats unmeasured work as free.
    const s = this.plugin.settings;
    const eventMins = eventMinutesOn(events, today);
    const openToday = [...a.overdue, ...a.anytime, ...a.timed.filter((r) => r.task && !r.done).map((r) => r.task!)];
    const uniqueOpen = [...new Map(openToday.map((x) => [x.path, x])).values()];
    const w = workload(uniqueOpen.map((x) => x.estimate), s.trackedDayHours * 60 - eventMins);

    if (w.withEstimate || w.withoutEstimate) {
      const line = root.createDiv({ cls: "brewin-workload" + (w.over > 0 ? " is-over" : "") });
      line.createSpan({
        text:
          `${formatEstimate(w.estimated) || "0m"} of work` +
          (w.withoutEstimate ? ` (+${w.withoutEstimate} unestimated)` : "") +
          ` · ${formatEstimate(w.free) || "0m"} free`,
      });
      if (w.over > 0 && w.withEstimate) {
        line.createSpan({ cls: "brewin-workload-over", text: `over by ${formatEstimate(w.over)}` });
      }
      line.setAttr(
        "aria-label",
        `${w.withEstimate} estimated task(s) totalling ${formatEstimate(w.estimated)}, against ${formatEstimate(w.free)} not already taken by events`
      );
    }

    if (a.allDayEvents.length) {
      const strip = root.createDiv({ cls: "brewin-allday-strip" });
      a.allDayEvents.forEach((e) => {
        const chip = strip.createSpan({ cls: "brewin-allday-chip", text: e.title });
        if (e.location) chip.setAttr("title", `📍 ${e.location}`);
        chip.addEventListener("click", () => this.openNote(e.path));
      });
    }

    if (a.overdue.length) {
      this.sectionHeader(root, "🔴 Overdue", a.overdue.length);
      const band = root.createDiv({ cls: "brewin-overdue" });
      a.overdue.forEach((t) => this.taskRow(band, t));
    }

    if (a.timed.length) {
      this.sectionHeader(root, "⏰ Timed", a.timed.filter((r) => r.kind !== "event").length);
      const body = root.createDiv();
      for (const row of a.timed) {
        if (row.kind === "event") {
          // Context only — an event isn't yours to tick from the task dashboard.
          const line = body.createDiv({ cls: "brewin-agenda-row is-event" });
          line.createSpan({ cls: "brewin-agenda-time", text: row.time });
          line.createSpan({ cls: "brewin-agenda-title", text: row.title });
          if (row.location) line.createSpan({ cls: "brewin-agenda-location", text: `📍 ${row.location}` });
          line.setAttr("aria-label", "Calendar event — open note");
          line.addEventListener("click", () => this.openNote(row.path));
          continue;
        }
        if (row.kind === "slot" && row.task) {
          const line = body.createDiv({ cls: "brewin-agenda-row" + (row.done ? " done" : "") });
          line.createSpan({ cls: "brewin-agenda-time", text: row.time });
          const box = line.createEl("input", { type: "checkbox" });
          box.checked = row.done;
          box.addEventListener("click", async (e) => {
            e.preventDefault();
            const res = await this.plugin.store.toggleSlot(row.task!, row.slotTime!, today);
            if (!res.ok) {
              new Notice(`Can't complete — ${res.open} subtask${res.open === 1 ? "" : "s"} still open.`);
              return;
            }
            this.render();
          });
          line.createSpan({ cls: "brewin-agenda-title", text: row.title });
          continue;
        }
        if (row.task) this.taskRow(body, row.task);
      }
    }

    if (a.anytime.length) {
      this.sectionHeader(root, "📋 Anytime", a.anytime.length);
      const body = root.createDiv();
      a.anytime.forEach((t) => this.taskRow(body, t));
    }

    if (!a.overdue.length && !a.timed.length && !a.anytime.length) {
      root.createDiv({
        cls: "brewin-empty",
        text: a.doneCount ? "Everything for today is done." : "Nothing scheduled for today.",
      });
    }
  }

  /** Week: the next 7 days, one group per day, empty days kept as visible breathing room. */
  private renderWeek(root: HTMLElement, tasks: Task[], today: string): void {
    const days = weekAgenda(tasks, today, 7);
    const total = days.reduce((n, d) => n + d.tasks.length, 0);

    if (this.plugin.settings.weekLayout === "board") {
      // The board stays up even when empty — its columns ARE the information.
      const board = root.createDiv({ cls: "brewin-board" });
      for (const day of days) {
        const col = board.createDiv({
          cls: "brewin-board-col" + (day.date === today ? " is-today" : ""),
          attr: { "data-drop-date": day.date },
        });
        const head = col.createDiv({ cls: "brewin-board-head" });
        head.createSpan({ text: shortDate(day.date) });
        if (day.tasks.length) head.createSpan({ cls: "brewin-count", text: String(day.tasks.length) });
        const body = col.createDiv({ cls: "brewin-board-body" });
        if (!day.tasks.length) body.createDiv({ cls: "brewin-board-empty", text: "—" });
        day.tasks.forEach((t) => this.card(body, t, day.date));
      }
      return;
    }

    if (!total) {
      root.createDiv({ cls: "brewin-empty", text: "Nothing scheduled in the next 7 days." });
      return;
    }
    for (const day of days) {
      const label = root.createDiv({ cls: "brewin-date-label" + (day.date === today ? " is-today" : "") });
      label.createSpan({ text: prettyDate(day.date) });
      if (day.tasks.length) label.createSpan({ cls: "brewin-count", text: String(day.tasks.length) });
      if (!day.tasks.length) {
        root.createDiv({ cls: "brewin-day-clear", text: "clear" });
        continue;
      }
      day.tasks.forEach((t) => this.taskRow(root, t));
    }
  }

  /** Inbox: undated captures, to be triaged until empty. */
  private renderInbox(root: HTMLElement, tasks: Task[]): void {
    const list = inboxTasks(tasks);
    if (!list.length) {
      root.createDiv({ cls: "brewin-empty", text: "Inbox zero — everything has a date." });
      return;
    }
    this.sectionHeader(root, "📥 Needs scheduling", list.length);
    list.forEach((t) => this.taskRow(root, t));
  }

  /** Attention: a broken promise and a slipped plan are different problems. */
  private renderAttention(root: HTMLElement, tasks: Task[], today: string): void {
    const g = attentionTasks(tasks, today);
    if (!g.overdue.length && !g.slipped.length && !g.onhold.length) {
      root.createDiv({ cls: "brewin-empty", text: "Nothing overdue, slipped or parked." });
      return;
    }
    if (g.overdue.length) {
      const head = this.sectionHeader(root, "🔴 Overdue — past its due date", g.overdue.length);
      const pushBtn = head.createEl("button", { text: "Push all to today", cls: "brewin-chip-mini" });
      pushBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const n = await this.plugin.store.bulkReschedule(g.overdue, today);
        new Notice(`Rescheduled ${n} task${n === 1 ? "" : "s"} to today.`);
        this.render();
      });
      const band = root.createDiv({ cls: "brewin-overdue" });
      g.overdue.forEach((t) => this.taskRow(band, t));
    }
    if (g.slipped.length) {
      this.sectionHeader(root, "⏳ Slipped — planned for a day that's gone", g.slipped.length);
      g.slipped.forEach((t) => this.taskRow(root, t));
    }
    if (g.onhold.length) {
      this.sectionHeader(root, "⏸ On hold", g.onhold.length);
      g.onhold.forEach((t) => this.taskRow(root, t));
    }
  }

  /** Projects: checkbox tasks grouped under their project note. */
  private async renderProjects(root: HTMLElement, today: string): Promise<void> {
    const src = new ProjectTaskSource(this.app, this.plugin.settings);
    const groups = groupByProject(await src.getProjectTasks(true)); // active projects only
    if (!groups.length) {
      root.createDiv({ cls: "brewin-empty", text: "No open tasks in your active projects." });
      return;
    }
    if (this.plugin.settings.projectsLayout === "board") {
      const board = root.createDiv({ cls: "brewin-board" });
      for (const g of groups) {
        const col = board.createDiv({ cls: "brewin-board-col" });
        const head = col.createDiv({ cls: "brewin-board-head" });
        const link = head.createSpan({ cls: "brewin-task-link", text: g.project });
        link.addEventListener("click", () => this.openNote(g.path));
        head.createSpan({ cls: "brewin-count", text: String(g.tasks.length) });
        const body = col.createDiv({ cls: "brewin-board-body" });
        for (const item of g.tasks) this.projectCard(body, src, item, today);
      }
      return;
    }

    for (const g of groups) {
      const label = root.createDiv({ cls: "brewin-date-label brewin-project-label" });
      const link = label.createSpan({ cls: "brewin-task-link", text: g.project });
      link.addEventListener("click", () => this.openNote(g.path));
      label.createSpan({ cls: "brewin-count", text: String(g.tasks.length) });
      for (const item of g.tasks) this.projectRow(root, src, item, today);
    }
  }

  /**
   * Group the (already context-filtered) tasks by their OTHER contexts — the one you
   * filtered by is excluded, since every task here shares it. A task carrying several
   * other contexts appears under each of them.
   */
  private renderByContext(root: HTMLElement, tasks: Task[]): void {
    const active = this.contextFilter;
    const groups = groupByContext(tasks, active);

    if (!groups.length) {
      root.createDiv({ cls: "brewin-empty", text: "Nothing to group." });
      return;
    }
    if (active) {
      root.createDiv({
        cls: "brewin-groupby-note",
        text: `@${active} tasks — those with additional contexts are grouped below.`,
      });
    }
    for (const g of groups) {
      const label = g.context
        ? `@${g.context}`
        : active
          ? `@${active} only` // the "pure" set — no additional contexts
          : "No context";
      this.section(root, label, g.tasks);
    }
  }

  private sectionHeader(root: HTMLElement, title: string, count: number): HTMLElement {
    const h = root.createDiv({ cls: "brewin-section-header" });
    h.createSpan({ text: title });
    h.createSpan({ cls: "brewin-count", text: String(count) });
    return h;
  }

  private section(root: HTMLElement, title: string, items: Task[], cls = ""): void {
    if (!items.length) return;
    const head = this.sectionHeader(root, title, items.length);
    if (cls) head.addClass(cls); // classList.add("") throws — never pass an empty class
    const body = root.createDiv();
    head.addEventListener("click", () => body.toggleClass("brewin-collapsed", !body.hasClass("brewin-collapsed")));
    items.forEach((t) => this.taskRow(body, t));
  }

  private taskRow(parent: HTMLElement, task: Task, isDone = false, isSubtask = false): void {
    const row = parent.createDiv({ cls: "brewin-task-row" + (isSubtask ? " brewin-subtask-row" : "") });

    const kids = childrenOf(this.index, task);
    const prog = progressOf(this.index, task);
    const blocked = kids.length > 0 && !canComplete(this.index, task);
    const openDeps = openDependencies(this.allTasks, task);

    // Multi-slot task: several fixed times in the day, ticked one at a time.
    const slots = task.times ?? [];
    const today = todayISO();
    const slotDay = task.scheduled && task.scheduled <= today ? task.scheduled : today;
    const sp = slots.length ? slotProgress(slots, task.completeSlots ?? {}, slotDay) : null;

    if (this.selecting) {
      const pick = row.createEl("input", { type: "checkbox", cls: "brewin-select-box" });
      pick.checked = this.selected.has(task.path);
      pick.setAttr("aria-label", `Select ${task.title}`);
      pick.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pick.checked) this.selected.add(task.path);
        else this.selected.delete(task.path);
        this.renderBulkBar();
      });
    }

    const cb = row.createEl("input", { type: "checkbox" });
    cb.checked = isDone || task.status === "done";
    if (blocked || openDeps.length) cb.addClass("brewin-locked");
    cb.addEventListener("click", async (e) => {
      e.preventDefault();
      if (task.status === "done") {
        await this.plugin.store.reopen(task);
      } else {
        // For a slot task the checkbox ticks the NEXT open slot rather than the whole task.
        const res = await this.plugin.store.complete(task);
        if (!res.ok) {
          // Hard block: open subtasks and/or unfinished dependencies both refuse completion.
          const reasons = [
            res.open ? `${res.open} subtask${res.open === 1 ? "" : "s"} still open` : null,
            res.blocked ? `waiting on ${res.blocked} other task${res.blocked === 1 ? "" : "s"}` : null,
          ]
            .filter((r): r is string => !!r)
            .join(" and ");
          new Notice(`Can't complete "${task.title}" — ${reasons}.`);
          return; // nothing was written; leave the checkbox unticked
        }
        if (sp?.next) {
          const after = this.plugin.store.getByPath(task.path);
          const done = after ? slotProgress(after.times ?? [], after.completeSlots ?? {}, slotDay) : null;
          new Notice(
            done?.dayComplete
              ? `"${task.title}" done for the day.`
              : `${slotTitle(sp.next)} ticked — ${done?.done ?? 0}/${sp.total} today.`
          );
        }
      }
      this.render();
    });

    const main = row.createDiv({ cls: "brewin-task-main" });
    const titleLine = main.createDiv({ cls: "brewin-task-title" });

    // Expander for parents
    if (kids.length) {
      const open = this.expanded.has(task.path);
      const exp = titleLine.createSpan({ cls: "brewin-expander", text: open ? "▾" : "▸" });
      exp.setAttr("aria-label", open ? "Hide subtasks" : "Show subtasks");
      exp.addEventListener("click", (e) => {
        e.stopPropagation();
        open ? this.expanded.delete(task.path) : this.expanded.add(task.path);
        this.render();
      });
    }

    const pri = PRIORITY_ICON[task.priority];
    if (pri) titleLine.createSpan({ text: pri + " " });
    if (task.recurrence) titleLine.createSpan({ cls: "brewin-recur", text: "🔁 " });
    const link = titleLine.createSpan({ cls: "brewin-task-link", text: task.title });
    link.setAttr("aria-label", "Edit task");
    link.addEventListener("click", () => this.editTask(task));

    if (kids.length) {
      const chip = titleLine.createSpan({
        cls: "brewin-progress-chip" + (blocked ? " blocked" : " ready"),
        text: `${blocked ? "🔒 " : ""}${prog.done}/${prog.total}`,
      });
      chip.setAttr("aria-label", blocked ? `${prog.total - prog.done} subtasks still open` : "All subtasks done");
    }

    if (openDeps.length) {
      const chip = titleLine.createSpan({ cls: "brewin-progress-chip blocked", text: `⛓ ${openDeps.length}` });
      chip.setAttr("aria-label", `Waiting on: ${openDeps.map((d) => d.title).join(", ")}`);
    }

    // Slot progress: how much of today's rhythm is done, and what's next.
    if (sp) {
      const open = this.expanded.has(task.path);
      const chip = titleLine.createSpan({
        cls: "brewin-slot-chip" + (sp.dayComplete ? " ready" : ""),
        text: `${sp.done}/${sp.total}${sp.next && !sp.dayComplete ? ` · next ${slotTitle(sp.next)}` : ""}`,
      });
      chip.setAttr(
        "aria-label",
        sp.dayComplete ? "Done for today" : `${sp.total - sp.done} of ${sp.total} times still to do today`
      );
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        open ? this.expanded.delete(task.path) : this.expanded.add(task.path);
        this.render();
      });
    }

    const meta = main.createDiv({ cls: "brewin-task-meta" });
    if (task.scheduled) {
      const time = task.startTime ? ` ${task.startTime}${task.endTime ? `–${task.endTime}` : ""}` : "";
      meta.createSpan({ cls: "brewin-meta-sched", text: `📅 ${task.scheduled}${time}` });
    }
    if (task.due) meta.createSpan({ cls: "brewin-meta-due", text: `🚩 ${task.due}` });
    task.contexts.forEach((c) => meta.createSpan({ cls: "brewin-meta-ctx", text: `@${c}` }));
    // Parent breadcrumb (skip when already shown nested under that parent)
    if (task.parentPath && !isSubtask) {
      const p = this.index.byPath.get(task.parentPath);
      if (p) {
        const crumb = meta.createSpan({ cls: "brewin-parent-crumb", text: `↳ ${p.title}` });
        crumb.addEventListener("click", () => this.openNote(p.path));
      }
    }

    if (!isDone) {
      const actions = row.createDiv({ cls: "brewin-task-actions" });
      this.iconBtn(actions, "✏️", "Edit task", () => this.editTask(task));
      this.iconBtn(actions, "📅", "Reschedule", async () => {
        const r = await pickDate(this.app, task.scheduled, this.plugin.settings.firstDayOfWeek, {
          selectedLabel: "Scheduled",
          relatedISO: task.due,
          relatedLabel: "Due",
        });
        if (r !== undefined) {
          await this.plugin.store.setScheduled(task, r);
          this.render();
        }
      });
      this.iconBtn(actions, "⋯", "More", (ev) => this.rowMenu(ev, task));
    }

    // Expanded slot list — tick any specific time, not just the next one.
    if (sp && this.expanded.has(task.path)) {
      const group = parent.createDiv({ cls: "brewin-slot-group" });
      for (const slot of slots) {
        const done = isSlotDone(task.completeSlots ?? {}, slotDay, slot.time);
        const line = group.createDiv({ cls: "brewin-slot-row" + (done ? " done" : "") });
        const box = line.createEl("input", { type: "checkbox" });
        box.checked = done;
        box.addEventListener("click", async (e) => {
          e.preventDefault();
          const res = await this.plugin.store.toggleSlot(task, slot.time, slotDay);
          if (!res.ok) {
            new Notice(`Can't complete "${task.title}" — ${res.open} subtask${res.open === 1 ? "" : "s"} still open.`);
            return;
          }
          this.render();
        });
        line.createSpan({ cls: "brewin-slot-label", text: slotTitle(slot) });
      }
    }

    // Nested subtasks
    if (kids.length && this.expanded.has(task.path)) {
      const sub = parent.createDiv({ cls: "brewin-subtask-group" });
      kids.forEach((k) => this.taskRow(sub, k, k.status === "done", true));
    }
  }

  /** Open the same window used to create a task, pre-filled for editing. */
  private editTask(task: Task): void {
    // Re-read so the modal always opens on current data, not a stale render snapshot.
    const fresh = this.plugin.store.getByPath(task.path) ?? task;
    new CaptureModal(this.app, this.plugin.store, this.plugin.settings, () => this.render(), fresh).open();
  }

  private rowMenu(ev: MouseEvent, task: Task): void {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Edit task…").setIcon("pencil").onClick(() => this.editTask(task)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Set due date").setIcon("flag").onClick(async () => {
      const r = await pickDate(this.app, task.due, this.plugin.settings.firstDayOfWeek, {
        selectedLabel: "Due",
        relatedISO: task.scheduled,
        relatedLabel: "Scheduled",
      });
      if (r !== undefined) { await this.plugin.store.setDue(task, r); this.render(); }
    }));
    if (task.status === "hold") {
      menu.addItem((i) => i.setTitle("Un-hold").setIcon("play").onClick(async () => { await this.plugin.store.setStatus(task, "todo"); this.render(); }));
    } else {
      menu.addItem((i) => i.setTitle("Put on hold").setIcon("pause").onClick(async () => { await this.plugin.store.setStatus(task, "hold"); this.render(); }));
    }
    menu.addSeparator();

    // ── Hierarchy ──
    menu.addItem((i) =>
      i.setTitle("Add subtask…").setIcon("plus").onClick(() => this.promptSubtask(task))
    );
    menu.addItem((i) =>
      i.setTitle("Set parent…").setIcon("link").onClick(() => {
        const candidates = validParentCandidates(
          this.index,
          task,
          this.plugin.store.getTasks().filter((t) => t.status !== "done")
        );
        new TaskSuggestModal(this.app, candidates, async (picked) => {
          const ok = await this.plugin.store.setParent(task, picked);
          if (!ok) new Notice("That would create a loop — pick a different parent.");
          this.render();
        }).open();
      })
    );
    if (task.parentPath) {
      menu.addItem((i) =>
        i.setTitle("Clear parent").setIcon("unlink").onClick(async () => {
          await this.plugin.store.setParent(task, null);
          this.render();
        })
      );
    }

    menu.addSeparator();
    (["high", "normal", "low"] as const).forEach((p) =>
      menu.addItem((i) => i.setTitle(`Priority: ${p}`).onClick(async () => { await this.plugin.store.setPriority(task, p); this.render(); }))
    );
    menu.addItem((i) => i.setTitle("Open note").setIcon("file").onClick(() => this.openNote(task.path)));
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Delete task…").setIcon("trash").onClick(() => this.deleteTask(task))
    );
    menu.showAtMouseEvent(ev);
  }

  /** Confirm and delete, making the fate of any subtasks explicit. */
  private deleteTask(task: Task): void {
    const kids = childrenOf(this.index, task);
    new DeleteTaskModal(this.app, task.title, kids.length, async (choice) => {
      if (!choice) return;
      const n = await this.plugin.store.deleteTask(task, choice === "with-subtasks");
      new Notice(`Deleted ${n} task${n === 1 ? "" : "s"}.`);
      this.expanded.delete(task.path);
      this.render();
    }).open();
  }

  /** Quick inline prompt for adding one subtask to an existing task. */
  private promptSubtask(task: Task): void {
    new SubtaskPrompt(this.app, task.title, async (title) => {
      await this.plugin.store.addSubtask(task, title);
      this.expanded.add(task.path); // reveal what was just added
      this.render();
    }).open();
  }

  private projectRow(parent: HTMLElement, src: ProjectTaskSource, pt: ProjectTask, today: string): void {
    const row = parent.createDiv({ cls: "brewin-task-row brewin-project-row" });
    const cb = row.createEl("input", { type: "checkbox" });
    cb.addEventListener("click", async (e) => {
      e.preventDefault();
      await src.complete(pt);
      this.render();
    });
    const main = row.createDiv({ cls: "brewin-task-main" });
    const titleLine = main.createDiv({ cls: "brewin-task-title" });
    if (pt.isNext) titleLine.createSpan({ cls: "brewin-next", text: "⚡ " });
    titleLine.createSpan({ text: pt.text });
    const meta = main.createDiv({ cls: "brewin-task-meta" });
    if (pt.scheduled) meta.createSpan({ cls: "brewin-meta-sched", text: `📅 ${pt.scheduled}` });
    if (pt.due) {
      const overdue = pt.due < today;
      meta.createSpan({ cls: overdue ? "brewin-meta-overdue" : "brewin-meta-due", text: `🚩 ${pt.due}` });
    }
    const actions = row.createDiv({ cls: "brewin-task-actions" });
    this.iconBtn(actions, "📅", "Schedule", async () => {
      const r = await pickDate(this.app, pt.scheduled, this.plugin.settings.firstDayOfWeek, {
        selectedLabel: "Scheduled",
        relatedISO: pt.due,
        relatedLabel: "Due",
      });
      if (r !== undefined) { await src.setDate(pt, "scheduled", r); this.render(); }
    });
  }

  private iconBtn(parent: HTMLElement, icon: string, tip: string, onClick: (ev: MouseEvent) => void): void {
    const b = parent.createEl("button", { cls: "brewin-icon-btn", text: icon });
    b.setAttr("aria-label", tip);
    b.addEventListener("click", (ev) => onClick(ev));
  }

  /** Open a project note at the exact checkbox line the card came from. */
  private async openProjectLine(pt: ProjectTask): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(pt.projectPath);
    if (!(file instanceof TFile)) {
      new Notice("Note not found: " + pt.projectPath);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file, { eState: { line: pt.line } });
  }

  private openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) this.app.workspace.getLeaf(false).openFile(file);
    else new Notice("Note not found: " + path);
  }
}

/** One-field prompt for adding a subtask under an existing task. */
class SubtaskPrompt extends Modal {
  constructor(app: App, private parentTitle: string, private onSubmit: (title: string) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Add subtask" });
    contentEl.createDiv({ cls: "brewin-capture-hint", text: `Under: ${this.parentTitle}` });
    const input = contentEl.createEl("input", { type: "text", cls: "brewin-capture-title", placeholder: "What needs doing?" });
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      this.onSubmit(v);
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    window.setTimeout(() => input.focus(), 0);
    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Add", cls: "mod-cta" }).addEventListener("click", submit);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** One-field prompt for a context, with the vault's existing values offered. */
class ContextPromptModal extends Modal {
  private value = "";
  constructor(app: App, private index: ContextIndex, private onSubmit: (v: string) => void) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Add a context" });
    const input = contentEl.createEl("input", { type: "text" });
    input.placeholder = this.index.suggestions.slice(0, 3).join(", ") || "home";
    input.style.width = "100%";
    input.addEventListener("input", () => (this.value = input.value));
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
    });
    window.setTimeout(() => input.focus(), 0);

    const chips = contentEl.createDiv({ cls: "brewin-ctx-chips" });
    for (const c of this.index.suggestions.slice(0, 12)) {
      chips.createEl("button", { cls: "brewin-chip-mini", text: c }).addEventListener("click", () => {
        this.value = c;
        this.submit();
      });
    }
    const btns = contentEl.createDiv({ cls: "brewin-modal-btns" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Add", cls: "mod-cta" }).addEventListener("click", () => this.submit());
  }
  private submit(): void {
    // Snap to the vault's preferred spelling, exactly as the task window does.
    const v = canonicaliseContext(this.value, this.index);
    this.close();
    if (v) this.onSubmit(v);
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

/** One-field prompt for an effort estimate. */
class EstimatePromptModal extends Modal {
  private raw = "";
  constructor(app: App, private onSubmit: (minutes: number | null) => void) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Set an estimate" });
    contentEl.createEl("p", {
      cls: "brewin-modal-sub",
      text: "45 · 45m · 1h · 1h30 · 1.5h — leave blank to clear.",
    });
    const input = contentEl.createEl("input", { type: "text" });
    input.placeholder = "30m";
    input.style.width = "100%";
    input.addEventListener("input", () => (this.raw = input.value));
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
    });
    window.setTimeout(() => input.focus(), 0);

    const quick = contentEl.createDiv({ cls: "brewin-ctx-chips" });
    for (const preset of ["15m", "30m", "45m", "1h", "2h"]) {
      quick.createEl("button", { cls: "brewin-chip-mini", text: preset }).addEventListener("click", () => {
        this.raw = preset;
        this.submit();
      });
    }
    const btns = contentEl.createDiv({ cls: "brewin-modal-btns" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Set", cls: "mod-cta" }).addEventListener("click", () => this.submit());
  }
  private submit(): void {
    const raw = this.raw.trim();
    const minutes = raw ? parseEstimate(raw) : null;
    if (raw && minutes == null) {
      new Notice("Couldn't read that — try 45m, 1h or 1h30.");
      return;
    }
    this.close();
    this.onSubmit(minutes);
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
