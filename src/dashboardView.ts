import { App, ItemView, Menu, Modal, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { groupSomeday, nextWeekStart, relativeDay } from "./status";
import { classify, groupByContext, groupByDate } from "./buckets";
import { shiftISO, todayISO } from "./dates";
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
import { PromptModal } from "./promptModal";
import { ProjectSuggestModal } from "./projectSuggestModal";
import { isOpen } from "./status";
import { toWikilink } from "./task";
import { birthdayPage, birthdaysBetween, formatBirthDate, parseBirthDate, Person } from "./birthdays";
import { deadline, deadlineLabel, isStalled, plainText, PROJECT_STATUSES, ProjectStatus, STATUS_GLYPH, STATUS_LABEL } from "./projects";
import type { ProjectInfo } from "./projects";
import { NextActionModal } from "./nextActionModal";
import {
  canHideView,
  contextKey,
  DashState,
  flagKey,
  attrValueKey,
  GroupBy,
  DROP_ONLY,
  linkedTaskCounts,
  matchesFilter,
  MenuSection,
  moveView,
  newFilterId,
  orderedViews,
  projectKey,
  resolveDrop,
  SavedFilter,
  sectionKey,
  suggestFilterName,
  todayProgress,
  toggleHidden,
  viewCounts,
  viewKey,
} from "./dashMenu";
import { formatEstimate, parseEstimate, workload } from "./estimate";
import { flagCounts, flagRefusal, flagText, StatusFlag } from "./statusFlags";
import { minutesText, totalMinutes } from "./timeTrack";
import { attrChip, attrMatches, attrMenuValues, groupByAttr, parseAttrInput, TaskAttribute } from "./attributes";
import { boardColumns, boardDrop, BoardField, boardFields } from "./board";
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
  weekTaskReview,
} from "./views";
import { CalendarItem, Task } from "./types";

export const BREWIN_VIEW_TYPE = "brewin-tasks-dashboard";

/** The views that can be a board, and what their columns are until the user picks. */
const BOARD_DEFAULT: Partial<Record<DashView, BoardField>> = {
  today: "status",
  week: "day",
  inbox: "context",
  attention: "status",
  all: "status",
  projects: "project",
};

/** Below this width the menu stops being a column and becomes a drawer behind ☰. */
const MENU_DRAWER_BELOW = 620;

/** A project as the dashboard shows it: the note's own fields, and its open checkbox lines. */
interface MenuProject {
  path: string;
  name: string;
  info: ProjectInfo;
  inline: ProjectTask[];
}

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
  /** A status flag's id: the list narrowed to tasks carrying it. */
  private flagFilter: string | null = null;
  private groupBy: GroupBy = "date";
  /** One of the user's attributes and a value: the list narrowed to tasks with it. */
  private attrFilter: { key: string; value: string } | null = null;
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
  /** Whether the Review's projects step is open. Session state, like the Unscheduled fold. */
  private reviewProjOpen = true;

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
    this.registerDomEvent(this.contentEl, "keydown", (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !this.drawer || !this.menuOpen) return;
      e.preventDefault();
      this.setMenuOpen(false);
    });
    // Checked ONCE per fresh leaf open, not on every render — otherwise clearing your own
    // backlog mid-session would yank you back to Today while you're still looking at Attention.
    if (this.plugin.settings.dashboardDefaultToAttentionWhenBehind) {
      const today = todayISO();
      const att = attentionTasks(this.plugin.store.getTasks(), today);
      if (att.overdue.length + att.slipped.length > 0) this.view = "attention";
    }
    await this.render();
  }

  /** The list area under the controls. Search and filters redraw only this. */
  private bodyEl: HTMLElement | null = null;
  /** The task column — the one that scrolls — and the menu pane beside it (or, when narrow, over it). */
  private mainEl: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  /** Narrow — a phone, or a pane under `MENU_DRAWER_BELOW` wide: the menu is a drawer behind ☰. */
  private drawer = false;
  /** The drawer is showing. Kept across redraws, so ticking a box doesn't slam it shut. */
  private menuOpen = false;
  /** The menu is in reorder-and-hide mode. */
  private menuEditing = false;
  /** One project shown on its own (its note's path) in place of a view. */
  private project: string | null = null;
  /** Every project not yet done, with its open checkbox lines, read once per full render. */
  private projects: MenuProject[] = [];
  /** What each view has left to do, for the menu and the ☰ dot. */
  private counts: Record<DashView, number | null> = viewCounts([], todayISO());
  /** Bumped by every render, so an earlier one that finishes late can't draw over a newer one. */
  private renderSeq = 0;

  async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const projects = await this.loadProjects();
    if (seq !== this.renderSeq) return;
    this.projects = projects;
    // The project shown on its own was finished, archived or renamed: fall back to the view under it.
    if (this.project && !projects.some((p) => p.path === this.project)) this.project = null;

    const root = this.contentEl;
    // Keep your place in both columns: this redraws after every tick and every relevant vault change.
    const mainScroll = this.mainEl?.scrollTop ?? 0;
    const menuScroll = this.menuEl?.querySelector(".brewin-menu-scroll")?.scrollTop ?? 0;
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement && active.classList.contains("brewin-search") && root.contains(active) ? active.selectionStart : null;

    const today = todayISO();
    const tasks = this.plugin.store.getTasks();
    this.counts = viewCounts(tasks, today);
    // A context filter whose last open task has gone would leave an empty list with no menu entry to undo it.
    if (this.contextFilter && !filterableContexts(tasks).some((c) => c.value.toLowerCase() === this.contextFilter!.toLowerCase())) {
      this.contextFilter = null;
    }
    // Likewise a flag or an attribute taken out of settings.
    if (this.flagFilter && !this.flag(this.flagFilter)) this.flagFilter = null;
    if (this.attrFilter && !this.attr(this.attrFilter.key)) this.attrFilter = null;
    if (this.groupBy.startsWith("attr:") && !this.attr(this.groupBy.slice(5))) this.groupBy = "date";

    root.empty();
    this.drawer = this.isDrawerMode();
    root.addClass("brewin-dashboard", "has-menu");
    root.toggleClass("is-drawer", this.drawer);
    root.toggleClass("is-menu-open", this.drawer && this.menuOpen);
    root.toggleClass("is-menu-collapsed", !this.drawer && this.plugin.settings.menuCollapsed);

    this.menuEl = root.createDiv({ cls: "brewin-menu" });
    this.renderMenu(this.menuEl);
    if (this.drawer) root.createDiv({ cls: "brewin-menu-scrim" }).addEventListener("click", () => this.setMenuOpen(false));

    const main = root.createDiv({ cls: "brewin-dash-main" });
    this.mainEl = main;
    this.renderChrome(main);
    this.bodyEl = main.createDiv({ cls: "brewin-dash-body" });
    await this.renderBody();
    // On a phone, a new task is one thumb-reach away wherever you have scrolled to.
    if (Platform.isPhone) {
      const fab = root.createEl("button", { cls: "brewin-fab mod-cta" });
      setIcon(fab, "plus");
      fab.setAttr("aria-label", "New task");
      fab.addEventListener("click", () => this.newTask());
    }
    main.scrollTop = mainScroll;
    const menuScroller = this.menuEl.querySelector(".brewin-menu-scroll");
    if (menuScroller) menuScroller.scrollTop = menuScroll;
    // A redraw mid-search (a sync landed, a reminder fired) must not take the keyboard away.
    if (typing !== null) {
      const input = root.querySelector<HTMLInputElement>("input.brewin-search");
      input?.focus();
      input?.setSelectionRange(typing, typing);
    }
  }

  /** Narrow enough that a menu column would squeeze the list: a phone, or a narrow pane. */
  private isDrawerMode(): boolean {
    if (Platform.isPhone) return true;
    const w = this.contentEl.clientWidth;
    return w > 0 && w < MENU_DRAWER_BELOW; // 0 = a background tab not laid out yet: assume there's room
  }

  /** Dragging the pane narrower (or wider) than the threshold swaps column and drawer. */
  onResize(): void {
    if (this.isDrawerMode() !== this.drawer) void this.render();
  }

  private setMenuOpen(open: boolean): void {
    this.menuOpen = open;
    this.contentEl.toggleClass("is-menu-open", open && this.drawer);
  }

  /** ☰ on a phone; fold to icons and back on a wide screen. Also the "Toggle menu" command. */
  async toggleMenu(): Promise<void> {
    if (this.drawer) {
      this.setMenuOpen(!this.menuOpen);
      return;
    }
    this.plugin.settings.menuCollapsed = !this.plugin.settings.menuCollapsed;
    await this.plugin.saveSettings();
    await this.render();
  }

  /** The search box lives in the menu only when the menu is a full-width column. */
  private searchInMenu(): boolean {
    return !this.drawer && !this.plugin.settings.menuCollapsed;
  }

  private state(): DashState {
    return { view: this.view, project: this.project, context: this.contextFilter, flag: this.flagFilter, attr: this.attrFilter, query: this.query, groupBy: this.groupBy };
  }

  /** This view as a list or a board. */
  private layout(): "list" | "board" {
    return BOARD_DEFAULT[this.view] ? this.plugin.settings.layouts[this.view] ?? "list" : "list";
  }

  private isBoard(): boolean {
    return !this.project && this.layout() === "board";
  }

  /** What this view's board columns are: the user's pick while it is still offered, else the view's own. */
  private boardField(): BoardField {
    const picked = this.plugin.settings.boardBy[this.view];
    const offered = boardFields(this.plugin.settings.attributes, this.view === "week").map((f) => f.field as string);
    return (picked && offered.includes(picked) ? picked : BOARD_DEFAULT[this.view] ?? "status") as BoardField;
  }

  /** The tasks a view shows, for its board — the same ones its list does. */
  private boardTasks(tasks: Task[], today: string): Task[] {
    const unique = (list: Task[]) => [...new Map(list.map((t) => [t.path, t])).values()];
    switch (this.view) {
      case "today": {
        const a = todayAgenda(tasks, [], today);
        const open = [...a.overdue, ...a.carried, ...a.timed.flatMap((r) => (r.task && !r.done ? [r.task] : [])), ...a.anytime];
        // On a status board, what was finished today fills Done.
        const done = this.boardField() === "status" ? weekTaskReview(tasks, today, today, today).doneOneOff : [];
        return unique([...open, ...done]);
      }
      case "week":
        return unique(weekAgenda(tasks, today, 7).flatMap((d) => d.tasks));
      case "inbox":
        return unique([...inboxTasks(tasks), ...tasks.filter((t) => t.status === "someday")]);
      case "attention": {
        const g = attentionTasks(tasks, today);
        return unique([...g.overdue, ...g.slipped, ...g.onhold]);
      }
      default:
        return tasks.filter((t) => t.status !== "done");
    }
  }

  /** A view as a board: a column per value of the chosen field; drag a card across to change it. */
  private renderBoard(root: HTMLElement, field: BoardField, tasks: Task[], today: string): void {
    const ctx = {
      flags: this.plugin.settings.statusFlags,
      attributes: this.plugin.settings.attributes,
      projects: this.activeProjects().map((p) => ({ path: p.path, name: p.name })),
    };
    const cols = boardColumns(field, tasks, ctx);
    const board = root.createDiv({ cls: "brewin-board brewin-kanban" });
    for (const c of cols) {
      const col = board.createDiv({ cls: "brewin-board-col", attr: { "data-drop-col": `${field}|${c.key}` } });
      const head = col.createDiv({ cls: "brewin-board-head" });
      head.createSpan({ text: `${c.icon} ${c.label}` });
      if (c.tasks.length) head.createSpan({ cls: "brewin-count", text: String(c.tasks.length) });
      const body = col.createDiv({ cls: "brewin-board-body" });
      if (!c.tasks.length) body.createDiv({ cls: "brewin-board-empty", text: "—" });
      for (const t of c.tasks) this.card(body, t, t.scheduled && t.scheduled > today ? t.scheduled : today);
    }
    if (!tasks.length) root.createDiv({ cls: "brewin-board-note", text: "Nothing here yet — drop a card on a column to change it." });
  }

  /** A card dropped on a board column: change the field the columns are, or say why not. */
  private async applyBoardDrop(target: string, from: string | null, task: Task): Promise<void> {
    const [field, toKey] = target.split("|") as [BoardField, string];
    const fromKey = from?.split("|")[1] ?? null;
    const fresh = this.plugin.store.getByPath(task.path) ?? task;
    const ctx = {
      flags: this.plugin.settings.statusFlags,
      attributes: this.plugin.settings.attributes,
      projects: this.activeProjects().map((p) => ({ path: p.path, name: p.name })),
    };
    const action = boardDrop(field, fresh, fromKey, toKey, ctx);
    const store = this.plugin.store;
    const t = `“${fresh.title}”`;
    switch (action.kind) {
      case "none":
        return;
      case "refuse":
        new Notice(`${t} ${action.reason}.`);
        return;
      case "status":
        if (action.status === "done") {
          const res = await store.complete(fresh);
          if (!res.ok) return void new Notice(`${t} can't be done yet — ${[res.open ? `${res.open} subtask(s) open` : "", res.blocked ? `waiting on ${res.blocked} task(s)` : ""].filter(Boolean).join(" and ")}.`);
        } else if (fresh.status === "done") {
          await store.reopen(fresh);
          if (action.status !== "todo") await store.setStatus(store.getByPath(fresh.path) ?? fresh, action.status);
        } else await store.setStatus(fresh, action.status);
        break;
      case "flag": {
        const refused = await store.setFlag(fresh, action.flag);
        if (refused) return void new Notice(`${t} ${refused}.`);
        break;
      }
      case "priority":
        await store.setPriority(fresh, action.priority);
        break;
      case "contexts":
        await store.updateFields(fresh, { contexts: action.contexts });
        break;
      case "project":
        await store.setProject(fresh, action.path);
        break;
      case "attr": {
        const a = action.attr;
        const value = action.value === null ? null : a.kind === "bool" ? true : parseAttrInput(a, this.attrValueAsWritten(a, action.value));
        await store.setAttrs(fresh.path, { [a.key]: value });
        break;
      }
    }
    this.render();
  }

  /** One of the user's attributes, by key. */
  private attr(key: string | null | undefined): TaskAttribute | null {
    return (key && this.plugin.settings.attributes.find((a) => a.key === key)) || null;
  }

  /** "Client: Mum" — the attribute filter as words. */
  private attrFilterLabel(f: { key: string; value: string } | null | undefined): string | null {
    const a = this.attr(f?.key);
    if (!a || !f) return null;
    const entry = attrMenuValues(a, this.plugin.store.getTasks()).find((e) => e.value === f.value);
    return `${a.label}: ${entry?.label ?? (f.value === "yes" ? "Yes" : f.value === "any" ? "has one" : f.value)}`;
  }

  /** One of the user's status flags, by id. */
  private flag(id: string | null | undefined): StatusFlag | null {
    return (id && this.plugin.settings.statusFlags.find((f) => f.id === id)) || null;
  }

  /** Change what the list shows, close the drawer, and start the new list from the top. */
  private go(next: Partial<DashState>): void {
    if (next.view !== undefined) this.view = next.view;
    if (next.project !== undefined) this.project = next.project;
    if (next.context !== undefined) this.contextFilter = next.context;
    if (next.flag !== undefined) this.flagFilter = next.flag;
    if (next.attr !== undefined) this.attrFilter = next.attr;
    if (next.query !== undefined) this.query = next.query;
    if (next.groupBy !== undefined) this.groupBy = next.groupBy;
    this.menuOpen = false;
    if (this.mainEl) this.mainEl.scrollTop = 0;
    void this.render();
  }

  /**
   * Projects not yet done. Waiting and Someday ones are loaded too: the menu lists what the waiting
   * ones wait on, and any of them can be opened on its own page.
   */
  private async loadProjects(): Promise<MenuProject[]> {
    const src = new ProjectTaskSource(this.app, this.plugin.settings);
    const lines = new Map(groupByProject(await src.getProjectTasks()).map((g) => [g.path, g.tasks]));
    return this.plugin.projects
      .list()
      .filter((info) => info.status !== "done")
      .map((info) => ({ path: info.path, name: info.name, info, inline: lines.get(info.path) ?? [] }));
  }

  /** The projects being worked on now — the ones whose steps count, and that the calendar shows. */
  private activeProjects(): MenuProject[] {
    return this.projects.filter((p) => p.info.status === "active");
  }

  /** A new task starts inside the project, and with the context, that the list is showing. */
  private newTask(): void {
    this.setMenuOpen(false);
    const proj = this.project ? this.projects.find((p) => p.path === this.project) : undefined;
    new CaptureModal(this.app, this.plugin.store, this.plugin.settings, () => this.render())
      .withPreset({
        project: proj ? { link: toWikilink(proj.name), name: proj.name } : null,
        contexts: this.contextFilter ? [this.contextFilter] : [],
      })
      .open();
  }

  private matchedFilter(): SavedFilter | null {
    const state = this.state();
    return this.plugin.settings.savedFilters.find((f) => matchesFilter(f, state)) ?? null;
  }

  private currentTitle(): string {
    const saved = this.matchedFilter();
    if (saved) return `🔖 ${saved.name}`;
    if (this.project) return `⚡ ${this.projects.find((p) => p.path === this.project)?.name ?? "Project"}`;
    const v = DASH_VIEWS.find((x) => x.id === this.view);
    return v ? `${v.icon} ${v.label}` : "";
  }

  /**
   * Above the list: where you are, and the controls that belong to this list. Built once per full
   * render — typing in search must never rebuild the input itself: on iOS that breaks autocorrect
   * and makes the keyboard flicker.
   */
  private renderChrome(root: HTMLElement): void {
    const header = root.createDiv({ cls: "brewin-dash-header" });
    const bar = header.createDiv({ cls: "brewin-dash-titlebar" });
    if (this.drawer) {
      const burger = bar.createEl("button", { cls: "clickable-icon brewin-menu-btn" });
      setIcon(burger, "menu");
      burger.setAttr("aria-label", "Menu");
      // Something is overdue: say so on the button, since the menu with its red count is shut.
      if (this.counts.attention) burger.createSpan({ cls: "brewin-menu-btn-dot" });
      burger.addEventListener("click", () => this.setMenuOpen(!this.menuOpen));
    }
    bar.createDiv({ cls: "brewin-dash-title", text: this.currentTitle() });
    if (this.project) {
      const open = bar.createEl("button", { cls: "clickable-icon" });
      setIcon(open, "file-text");
      open.setAttr("aria-label", "Open the project note");
      const path = this.project;
      open.addEventListener("click", () => this.openNote(path));
    }

    const actions = bar.createDiv({ cls: "brewin-dash-actions" });
    // Grouping only exists in All, and only as a list — a board has its columns instead.
    if (this.view === "all" && !this.project && !this.isBoard()) {
      const grp = actions.createEl("select", { cls: "brewin-groupby dropdown" });
      grp.createEl("option", { text: "Group: date", value: "date" });
      grp.createEl("option", { text: "Group: context", value: "context" });
      for (const a of this.plugin.settings.attributes) grp.createEl("option", { text: `Group: ${a.label}`, value: `attr:${a.key}` });
      grp.value = this.groupBy;
      grp.addEventListener("change", () => {
        const v = grp.value;
        this.groupBy = v === "context" ? "context" : v.startsWith("attr:") && this.attr(v.slice(5)) ? (v as GroupBy) : "date";
        void this.renderBody();
      });
    }
    // List or board, for every view that can be one; a board's columns by the field picked beside it.
    let boardPicker: ((parent: HTMLElement) => void) | null = null;
    if (!this.project && BOARD_DEFAULT[this.view]) {
      const current = this.layout();
      const lay = actions.createDiv({ cls: "brewin-layout-seg" });
      // A phone's title bar has room for the symbols only; the names are their labels.
      ([
        ["list", "≡", "List"],
        ["board", "▦", "Board"],
      ] as const).forEach(([value, icon, name]) => {
        const b = lay.createEl("button", { text: Platform.isPhone ? icon : `${icon} ${name}`, cls: current === value ? "active" : "" });
        b.setAttr("aria-label", name);
        b.addEventListener("click", async () => {
          this.plugin.settings.layouts[this.view] = value;
          await this.plugin.saveSettings();
          this.render();
        });
      });
      // The columns picker: in the title bar, or on a phone in the row under it, where there's room.
      if (current === "board" && this.view !== "projects") boardPicker = (parent: HTMLElement) => {
        const pick = parent.createEl("select", { cls: "brewin-groupby dropdown brewin-board-pick" });
        pick.setAttr("aria-label", "Board columns");
        for (const f of boardFields(this.plugin.settings.attributes, this.view === "week")) pick.createEl("option", { text: `Columns: ${f.label}`, value: f.field });
        pick.value = this.boardField();
        pick.addEventListener("change", async () => {
          this.plugin.settings.boardBy[this.view] = pick.value;
          await this.plugin.saveSettings();
          void this.renderBody();
        });
      };
      if (boardPicker && !Platform.isPhone) boardPicker(actions);
    }
    const selBtn = actions.createEl("button", { cls: "brewin-select-toggle" + (this.selecting ? " mod-cta" : "") });
    if (this.view === "birthdays" && !this.project) selBtn.addClass("brewin-hidden"); // there are no tasks to select
    selBtn.setText(this.selecting ? "Done" : "☑");
    selBtn.setAttr("aria-label", this.selecting ? "Finish selecting" : "Select tasks");
    selBtn.addEventListener("click", () => {
      this.selecting = !this.selecting;
      if (!this.selecting) this.selected.clear();
      this.render();
    });
    // A narrow desktop pane has neither the menu's ＋ in view nor the phone's floating one.
    if (this.drawer && !Platform.isPhone) {
      const add = actions.createEl("button", { cls: "mod-cta", text: "＋" });
      add.setAttr("aria-label", "New task");
      add.addEventListener("click", () => this.newTask());
    }

    // Search (when the menu isn't showing it) and the context the list is narrowed to.
    const tools = header.createDiv({ cls: "brewin-toolbar" });
    if (!this.searchInMenu()) this.renderSearch(tools);
    if (boardPicker && Platform.isPhone) boardPicker(tools);
    if (this.contextFilter) {
      const chip = tools.createEl("button", { cls: "brewin-filter-chip", text: `@${this.contextFilter} ✕` });
      chip.setAttr("aria-label", `Stop filtering by @${this.contextFilter}`);
      chip.addEventListener("click", () => this.go({ context: null }));
    }
    const shownFlag = this.flag(this.flagFilter);
    if (shownFlag) {
      const chip = tools.createEl("button", { cls: "brewin-filter-chip", text: `${flagText(shownFlag)} ✕` });
      chip.setAttr("aria-label", `Stop showing only ${shownFlag.label}`);
      chip.addEventListener("click", () => this.go({ flag: null }));
    }
    const attrLabel = this.attrFilterLabel(this.attrFilter);
    if (attrLabel) {
      const a = this.attr(this.attrFilter?.key)!;
      const chip = tools.createEl("button", { cls: "brewin-filter-chip", text: `${a.icon} ${attrLabel} ✕` });
      chip.setAttr("aria-label", `Stop showing only ${attrLabel}`);
      chip.addEventListener("click", () => this.go({ attr: null }));
    }
    if (!tools.childElementCount) tools.remove();

    // A fixed host so ticking a box redraws only the bar — a full re-render would drop
    // scroll position and search focus on every tick.
    root.createDiv({ cls: "brewin-bulk-host" });
  }

  private renderSearch(parent: HTMLElement): void {
    const searchEl = parent.createEl("input", { cls: "brewin-search", type: "search" });
    searchEl.placeholder = this.project ? "Search this project…" : this.view === "birthdays" ? "Search people…" : "Search tasks…";
    searchEl.value = this.query;
    searchEl.addEventListener("input", () => {
      this.query = searchEl.value;
      void this.renderBody();
    });
  }

  // ── The menu pane ──────────────────────────────────────────────────────────

  private renderMenu(menu: HTMLElement): void {
    const s = this.plugin.settings;
    const today = todayISO();
    const tasks = this.plugin.store.getTasks();
    const hidden = new Set(s.menuHidden);
    const editing = this.menuEditing;
    const shows = (key: string) => editing || !hidden.has(key);
    menu.toggleClass("is-editing", editing);

    const head = menu.createDiv({ cls: "brewin-menu-head" });
    if (this.drawer) {
      const top = head.createDiv({ cls: "brewin-menu-top" });
      top.createDiv({ cls: "brewin-menu-heading", text: "Planner" });
      const close = top.createEl("button", { cls: "clickable-icon" });
      setIcon(close, "x");
      close.setAttr("aria-label", "Close the menu");
      close.addEventListener("click", () => this.setMenuOpen(false));
    }
    const add = head.createEl("button", { cls: "mod-cta brewin-menu-new" });
    setIcon(add.createSpan({ cls: "brewin-menu-icon" }), "plus");
    add.createSpan({ cls: "brewin-menu-label", text: "New task" });
    this.railLabel(add, "New task");
    add.addEventListener("click", () => this.newTask());
    if (this.searchInMenu()) this.renderSearch(head);

    const scroll = menu.createDiv({ cls: "brewin-menu-scroll" });

    // Places to drop a task that aren't views. Only shown mid-drag, so they cost nothing otherwise.
    const drops = scroll.createDiv({ cls: "brewin-menu-drops" });
    for (const d of DROP_ONLY) this.menuItem(drops, { icon: d.icon, label: d.label, drop: d.key });

    if (shows(sectionKey("progress"))) this.renderProgress(scroll, tasks, today, hidden.has(sectionKey("progress")));

    // ── Views ──
    const views = scroll.createDiv({ cls: "brewin-menu-views" });
    const linked = linkedTaskCounts(tasks);
    for (const id of orderedViews(s.menuOrder)) {
      const key = viewKey(id);
      if (!shows(key)) continue;
      const v = DASH_VIEWS.find((x) => x.id === id);
      if (!v) continue;
      const count =
        id === "projects"
          ? this.activeProjects().reduce((n, p) => n + p.inline.length + (linked.get(p.path) ?? 0), 0)
          : id === "birthdays"
            ? this.birthdaysSoon(today)
            : this.counts[id];
      const item = this.menuItem(views, {
        icon: v.icon,
        label: v.label,
        count,
        alert: id === "attention",
        active: !this.project && this.view === id,
        hidden: hidden.has(key),
        drop: id === "today" || id === "inbox" ? key : undefined,
        onClick: () => this.go({ view: id, project: null }),
      });
      if (editing) this.editControls(item, key, id);
    }

    // ── Projects ── active ones, a 🚩 on any with nothing to do next; then what is waiting, and on what.
    const projBody = this.menuSection(scroll, "projects", "Projects");
    if (projBody) {
      const listed = this.projects.filter((p) => p.info.status === "active" || p.info.status === "waiting");
      listed.sort((a, b) => Number(a.info.status === "waiting") - Number(b.info.status === "waiting"));
      for (const p of listed) {
        const key = projectKey(p.path);
        if (!shows(key)) continue;
        const waiting = p.info.status === "waiting";
        const stalled = isStalled(p.info, p.inline);
        const item = this.menuItem(projBody, {
          icon: waiting ? "⏳" : stalled ? "🚩" : "⚡",
          label: p.name,
          sub: waiting ? (p.info.waitingOn ? `on ${p.info.waitingOn}` : "waiting") : undefined,
          note: stalled ? "no next action" : undefined,
          count: waiting ? null : p.inline.length + (linked.get(p.path) ?? 0),
          active: this.project === p.path,
          hidden: hidden.has(key),
          drop: key,
          onClick: () => this.go({ project: p.path }),
        });
        item.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const m = new Menu();
          m.addItem((i) => i.setTitle("Open project note").setIcon("file-text").onClick(() => this.openNote(p.path)));
          m.showAtMouseEvent(e);
        });
        if (editing) this.editControls(item, key);
      }
      if (!listed.length) projBody.createDiv({ cls: "brewin-menu-empty", text: "No active projects." });
    }

    // ── Contexts ── (they replace the old dropdown: tap to narrow the list, tap again to undo)
    const ctxBody = this.menuSection(scroll, "contexts", "Contexts");
    if (ctxBody) {
      const contexts = filterableContexts(tasks);
      for (const c of contexts) {
        const key = contextKey(c.value);
        if (!shows(key)) continue;
        const on = !!this.contextFilter && this.contextFilter.toLowerCase() === c.value.toLowerCase();
        const item = this.menuItem(ctxBody, {
          icon: "＠",
          label: c.value,
          count: c.count,
          active: on,
          hidden: hidden.has(key),
          drop: `context:${c.value}`,
          onClick: () => this.go({ context: on ? null : c.value }),
        });
        if (editing) this.editControls(item, key);
      }
      if (!contexts.length) ctxBody.createDiv({ cls: "brewin-menu-empty", text: "No contexts on open tasks." });
    }

    // ── Statuses ── the user's own flags: tap to show only those tasks, drop a task to flag it.
    const flagBody = this.menuSection(scroll, "statuses", "Statuses");
    if (flagBody) {
      const flags = s.statusFlags;
      const counts = flagCounts(tasks, flags);
      for (const f of flags) {
        const key = flagKey(f.id);
        if (!shows(key)) continue;
        const on = this.flagFilter === f.id;
        const item = this.menuItem(flagBody, {
          icon: f.icon,
          label: f.label,
          count: counts.get(f.id) ?? null,
          active: on,
          hidden: hidden.has(key),
          drop: key,
          // Most flags stand for statuses that Today and Week leave out, so the filter shows All.
          onClick: () => this.go(on ? { flag: null } : { view: "all", project: null, flag: f.id }),
        });
        if (editing) this.editControls(item, key);
      }
      if (!flags.length && !editing) {
        const add = this.menuItem(flagBody, { icon: "＋", label: "Add your own…", onClick: () => this.plugin.openSettings() });
        add.addClass("is-quiet");
      }
    }

    // ── The user's own attributes ── a section each: its values on open tasks; tap to show only those,
    // drop a task on one to give it that value. Numbers and dates list just "Has one".
    for (const a of s.attributes) {
      const body = this.menuSection(scroll, `attr:${a.key}`, `${a.icon} ${a.label}`);
      if (!body) continue;
      const values = attrMenuValues(a, tasks);
      for (const v of values) {
        const key = attrValueKey(a.key, v.value);
        if (!shows(key)) continue;
        const on = this.attrFilter?.key === a.key && this.attrFilter.value === v.value;
        const item = this.menuItem(body, {
          icon: a.icon,
          label: v.label,
          count: v.count,
          active: on,
          hidden: hidden.has(key),
          drop: v.value === "any" ? undefined : key,
          onClick: () => this.go(on ? { attr: null } : { view: "all", project: null, attr: { key: a.key, value: v.value } }),
        });
        if (editing) this.editControls(item, key);
      }
      if (!values.length) body.createDiv({ cls: "brewin-menu-empty", text: `No open task has ${a.label.toLowerCase()} yet.` });
    }

    // ── Saved filters ──
    const filterBody = this.menuSection(scroll, "filters", "Saved filters");
    if (filterBody) {
      const state = this.state();
      for (const f of s.savedFilters) {
        const item = this.menuItem(filterBody, {
          icon: "🔖",
          label: f.name,
          active: matchesFilter(f, state),
          onClick: () => this.go({ view: f.view, project: f.project, context: f.context, flag: f.flag ?? null, attr: f.attr ?? null, query: f.query, groupBy: f.groupBy }),
        });
        if (editing) this.filterControls(item, f);
      }
      if (!editing) {
        const save = this.menuItem(filterBody, { icon: "＋", label: "Save this view…", onClick: () => this.saveCurrentFilter() });
        save.addClass("is-quiet");
      }
    }

    // ── Elsewhere in the Planner ──
    const linkBody = this.menuSection(scroll, "links", "Go to");
    if (linkBody) {
      this.menuItem(linkBody, {
        icon: "📆",
        label: "Calendar",
        onClick: () => {
          this.setMenuOpen(false);
          void this.plugin.activateCalendar();
        },
      });
      this.menuItem(linkBody, {
        icon: "⏱",
        label: "Time report",
        onClick: () => {
          this.setMenuOpen(false);
          void this.plugin.activateTime();
        },
      });
    }

    const foot = menu.createDiv({ cls: "brewin-menu-foot" });
    const edit = foot.createEl("button", { cls: "brewin-menu-edit-btn" + (editing ? " mod-cta" : ""), text: editing ? "Done" : "✎ Edit menu" });
    edit.addEventListener("click", () => {
      this.menuEditing = !editing;
      this.redrawMenu();
    });
    if (editing) {
      foot.createEl("button", { cls: "brewin-menu-edit-btn", text: "Reset" }).addEventListener("click", async () => {
        s.menuOrder = [];
        s.menuHidden = [];
        s.menuFolded = [];
        await this.plugin.saveSettings();
        this.redrawMenu();
      });
    }
    if (!this.drawer) {
      const rail = s.menuCollapsed;
      const fold = foot.createEl("button", { cls: "clickable-icon brewin-menu-fold" });
      setIcon(fold, rail ? "chevrons-right" : "chevrons-left");
      fold.setAttr("aria-label", rail ? "Expand the menu" : "Fold the menu to icons");
      fold.addEventListener("click", () => void this.toggleMenu());
    }
  }

  /** Rebuild only the menu — for folding sections and editing it, where the list hasn't changed. */
  private redrawMenu(): void {
    const menu = this.menuEl;
    if (!menu) return;
    const scroll = menu.querySelector(".brewin-menu-scroll")?.scrollTop ?? 0;
    menu.empty();
    this.renderMenu(menu);
    const scroller = menu.querySelector(".brewin-menu-scroll");
    if (scroller) scroller.scrollTop = scroll;
  }

  /** Folded to icons, an entry's name is its tooltip; at full width the name is right there. */
  private railLabel(el: HTMLElement, label: string): void {
    if (!this.drawer && this.plugin.settings.menuCollapsed) el.setAttr("aria-label", label);
    else el.setAttr("title", label); // long project names are cut short at full width
  }

  private menuItem(
    parent: HTMLElement,
    o: {
      icon: string;
      label: string;
      /** A second, quieter line under the label. */
      sub?: string;
      /** Said in the tooltip only. */
      note?: string;
      count?: number | null;
      alert?: boolean;
      active?: boolean;
      hidden?: boolean;
      drop?: string;
      onClick?: () => void;
    }
  ): HTMLElement {
    const el = parent.createDiv({ cls: "brewin-menu-item" });
    el.toggleClass("is-active", !!o.active);
    el.toggleClass("is-hidden", !!o.hidden);
    el.setAttr("role", "button");
    el.tabIndex = 0;
    if (o.active) el.setAttr("aria-current", "page");
    el.createSpan({ cls: "brewin-menu-icon", text: o.icon });
    if (o.sub) {
      const text = el.createDiv({ cls: "brewin-menu-text" });
      text.createSpan({ cls: "brewin-menu-label", text: o.label });
      text.createSpan({ cls: "brewin-menu-sub", text: o.sub });
    } else el.createSpan({ cls: "brewin-menu-label", text: o.label });
    if (o.count) el.createSpan({ cls: "brewin-menu-count" + (o.alert ? " is-alert" : ""), text: String(o.count) });
    this.railLabel(el, [o.label, o.sub, o.note, o.count ? String(o.count) : ""].filter(Boolean).join(" · "));
    if (o.drop) el.setAttr("data-drop-menu", o.drop);
    const run = o.onClick;
    if (run && !this.menuEditing) {
      el.addEventListener("click", run);
      el.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        run();
      });
    }
    return el;
  }

  /**
   * A foldable group in the menu. Returns where its entries go, or null when it is folded (or
   * hidden, outside edit mode). Folding is remembered in settings, so it holds across devices.
   */
  private menuSection(parent: HTMLElement, id: MenuSection, label: string): HTMLElement | null {
    const s = this.plugin.settings;
    const key = sectionKey(id);
    const hidden = s.menuHidden.includes(key);
    if (hidden && !this.menuEditing) return null;
    const section = parent.createDiv({ cls: "brewin-menu-section" + (hidden ? " is-hidden" : "") });
    const folded = s.menuFolded.includes(id);
    const head = section.createDiv({ cls: "brewin-menu-section-head" });
    head.setAttr("role", "button");
    head.setAttr("aria-expanded", String(!folded));
    head.tabIndex = 0;
    head.createSpan({ cls: "brewin-menu-chevron", text: folded ? "▸" : "▾" });
    head.createSpan({ cls: "brewin-menu-section-label", text: label });
    const fold = async () => {
      s.menuFolded = folded ? s.menuFolded.filter((f) => f !== id) : [...s.menuFolded, id];
      await this.plugin.saveSettings();
      this.redrawMenu();
    };
    head.addEventListener("click", () => void fold());
    head.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      void fold();
    });
    if (this.menuEditing) this.hideButton(head, key, true);
    return folded ? null : section.createDiv({ cls: "brewin-menu-section-body" });
  }

  /** Today's progress, and what Brewin Habits and Brewin Fitness say is behind. */
  private renderProgress(parent: HTMLElement, tasks: Task[], today: string, hidden: boolean): void {
    const p = todayProgress(tasks, today);
    const box = parent.createDiv({ cls: "brewin-menu-progress" + (hidden ? " is-hidden" : "") });
    const line = box.createDiv({ cls: "brewin-menu-progress-line" });
    line.createSpan({ cls: "brewin-menu-progress-label", text: "Today" });
    line.createSpan({ cls: "brewin-menu-progress-figure", text: p.total ? `${p.done} of ${p.total} done` : "nothing planned" });
    line.createSpan({ cls: "brewin-menu-progress-short", text: `${p.done}/${p.total}` });
    if (this.menuEditing) this.hideButton(line, sectionKey("progress"), true);
    const bar = box.createDiv({ cls: "brewin-menu-progress-bar" });
    bar.createDiv({ cls: "brewin-menu-progress-fill" }).style.width = `${p.total ? Math.round((100 * p.done) / p.total) : 0}%`;
    this.railLabel(box, p.total ? `Today: ${p.done} of ${p.total} done` : "Nothing planned today");

    const habits = this.plugin.backlog.readHabitsBacklog().habitsBehind;
    const missed = this.plugin.backlog.readFitnessBacklog().missedSessionsCount;
    if (!habits && !missed) return;
    const backlog = box.createDiv({ cls: "brewin-menu-backlog" });
    if (habits) {
      const chip = backlog.createEl("button", { cls: "brewin-chip-mini", text: `🔥 ${habits} habit${habits === 1 ? "" : "s"} behind` });
      chip.addEventListener("click", () => void this.plugin.openSibling("brewin-habits"));
    }
    if (missed) {
      const chip = backlog.createEl("button", { cls: "brewin-chip-mini", text: `🏋 ${missed} session${missed === 1 ? "" : "s"} missed` });
      chip.addEventListener("click", () => void this.plugin.openSibling("brewin-fitness"));
    }
  }

  /** Edit mode: ↑ ↓ for views, and a show/hide eye for everything. */
  private editControls(item: HTMLElement, key: string, view?: DashView): void {
    const s = this.plugin.settings;
    const ctl = item.createDiv({ cls: "brewin-menu-edit" });
    if (view) {
      ([
        [-1, "arrow-up", "Move up"],
        [1, "arrow-down", "Move down"],
      ] as const).forEach(([delta, icon, tip]) => {
        const b = ctl.createEl("button", { cls: "clickable-icon" });
        setIcon(b, icon);
        b.setAttr("aria-label", tip);
        b.addEventListener("click", async (e) => {
          e.stopPropagation();
          s.menuOrder = moveView(s.menuOrder, view, delta);
          await this.plugin.saveSettings();
          this.redrawMenu();
        });
      });
    }
    this.hideButton(ctl, key, false, view);
  }

  private hideButton(parent: HTMLElement, key: string, inHeader: boolean, view?: DashView): void {
    const s = this.plugin.settings;
    const hidden = s.menuHidden.includes(key);
    const b = parent.createEl("button", { cls: "clickable-icon brewin-menu-eye" + (inHeader ? " is-in-header" : "") });
    setIcon(b, hidden ? "eye-off" : "eye");
    b.setAttr("aria-label", hidden ? "Show in the menu" : "Hide from the menu");
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (view && !canHideView(s.menuHidden, view)) {
        new Notice("Keep at least one view in the menu.");
        return;
      }
      s.menuHidden = toggleHidden(s.menuHidden, key);
      await this.plugin.saveSettings();
      this.redrawMenu();
    });
  }

  /** Edit mode for a saved filter: rename it, point it at what's showing now, or delete it. */
  private filterControls(item: HTMLElement, f: SavedFilter): void {
    const s = this.plugin.settings;
    const ctl = item.createDiv({ cls: "brewin-menu-edit" });
    const btn = (icon: string, tip: string, fn: () => void) => {
      const b = ctl.createEl("button", { cls: "clickable-icon" });
      setIcon(b, icon);
      b.setAttr("aria-label", tip);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
    };
    const replace = async (next: SavedFilter | null) => {
      s.savedFilters = next ? s.savedFilters.map((x) => (x.id === f.id ? next : x)) : s.savedFilters.filter((x) => x.id !== f.id);
      await this.plugin.saveSettings();
      this.redrawMenu();
    };
    btn("pencil", "Rename", () =>
      new PromptModal(this.app, {
        title: "Rename filter",
        initial: f.name,
        cta: "Rename",
        onSubmit: (name) => {
          if (name.trim()) void replace({ ...f, name: name.trim() });
        },
      }).open()
    );
    btn("refresh-cw", "Update to what's showing now", () => void replace({ ...f, ...this.state(), query: this.query.trim() }));
    btn("trash", "Delete", () =>
      new ConfirmModal(this.app, {
        title: `Delete “${f.name}”`,
        body: "Only the saved filter goes — no tasks are touched.",
        cta: "Delete",
        onConfirm: () => void replace(null),
      }).open()
    );
  }

  private saveCurrentFilter(): void {
    const state = this.state();
    const projectName = this.project ? this.projects.find((p) => p.path === this.project)?.name ?? null : null;
    new PromptModal(this.app, {
      title: "Save this view",
      body: "Keeps the view, project, context and search together under one name in the menu.",
      initial: suggestFilterName(state, projectName, this.flag(state.flag)?.label ?? null, this.attrFilterLabel(state.attr)),
      cta: "Save",
      onSubmit: async (name) => {
        const s = this.plugin.settings;
        if (!name.trim()) return;
        s.savedFilters = [...s.savedFilters, { ...state, query: state.query.trim(), id: newFilterId(s.savedFilters, Date.now()), name: name.trim() }];
        await this.plugin.saveSettings();
        this.redrawMenu();
        // The title becomes the filter's name now that the state has one.
        this.contentEl.querySelector(".brewin-dash-title")?.setText(this.currentTitle());
      },
    }).open();
  }

  /** A task dropped on a menu entry: do what the entry means, or say why not. */
  private async applyMenuDrop(key: string, task: Task): Promise<void> {
    const fresh = this.plugin.store.getByPath(task.path) ?? task;
    const today = todayISO();
    const action = resolveDrop(key, fresh, today, this.plugin.settings.firstDayOfWeek, this.plugin.settings.statusFlags, this.plugin.settings.attributes);
    if (!action) return;
    const store = this.plugin.store;
    const t = `“${fresh.title}”`;
    switch (action.kind) {
      case "refuse":
        new Notice(`${t} ${action.reason}.`);
        return;
      case "schedule":
        await store.moveToDay(fresh, action.iso);
        new Notice(`${t} → ${action.iso === today ? "today" : shortDate(action.iso)}.`);
        break;
      case "inbox":
        await store.backToInbox(fresh);
        new Notice(`${t} is back in the inbox${fresh.due ? " — it keeps its due date" : ""}.`);
        break;
      case "someday":
        await store.setStatus(fresh, "someday");
        new Notice(`${t} moved to Someday.`);
        break;
      case "context":
        await store.bulkAddContext([fresh], action.value);
        new Notice(`Added @${action.value} to ${t}.`);
        break;
      case "project": {
        await store.setProject(fresh, action.path);
        const name = this.projects.find((p) => p.path === action.path)?.name ?? "the project";
        new Notice(`${t} is now in ${name}.`);
        break;
      }
      case "attr": {
        const a = action.attr;
        const value = a.kind === "bool" ? true : parseAttrInput(a, this.attrValueAsWritten(a, action.value));
        await store.setAttrs(fresh.path, { [a.key]: value });
        new Notice(`${t}: ${a.label} → ${a.kind === "bool" ? "yes" : attrChip(a, value ?? "")?.replace(/^\S+\s/, "") ?? action.value}.`);
        break;
      }
      case "flag": {
        const refused = await store.setFlag(fresh, action.flag);
        new Notice(refused ? `${t} ${refused}.` : `${t} is now ${flagText(action.flag)}.`);
        if (refused) return;
        break;
      }
    }
    this.render();
  }

  /** The list for the current view, filtered by context and search. */
  private async renderBody(): Promise<void> {
    const root = this.bodyEl;
    if (!root) return;
    root.empty();
    const today = todayISO();
    const allTasks = this.plugin.store.getTasks();
    this.allTasks = allTasks;
    // Index over ALL tasks so parent/child relations survive context filtering.
    this.index = buildIndex(allTasks);
    let tasks = allTasks;
    // Case-insensitive, so filtering `obsidian` also catches a note tagged `Obsidian`.
    if (this.contextFilter) tasks = tasks.filter((t) => hasContext(t.contexts, this.contextFilter!));
    const flag = this.flag(this.flagFilter);
    if (flag) tasks = tasks.filter((t) => t.flag?.id === flag.id);
    const attrF = this.attr(this.attrFilter?.key);
    if (attrF && this.attrFilter) {
      const want = this.attrFilter.value;
      tasks = tasks.filter((t) => attrMatches(attrF, t.attrs, want));
    }
    // Search narrows whatever view is showing rather than replacing it.
    if (this.query.trim()) tasks = search(tasks, this.query);

    // A flag standing for Done (Cancelled, Won't do…) gathers finished tasks, which no view lists:
    // show them on their own, the most recently closed first.
    if (flag?.base === "done" && !this.project) {
      const closed = [...tasks].sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? "") || a.title.localeCompare(b.title));
      if (!closed.length) root.createDiv({ cls: "brewin-empty", text: `Nothing is ${flag.label} yet.` });
      else this.section(root, flagText(flag), closed);
      return this.renderBulkBar();
    }

    if (this.project) {
      this.renderProjectScope(root, tasks, today);
      return this.renderBulkBar();
    }
    if (this.view === "birthdays") {
      this.renderBirthdays(root, today);
      return;
    }

    const buckets = classify(tasks, today);

    // Group-by-context is an "All" refinement; the focused views have their own shape.
    if (this.view === "all" && this.groupBy === "context") {
      this.renderByContext(root, tasks);
      return this.renderBulkBar();
    }
    const groupAttr = this.view === "all" && this.groupBy.startsWith("attr:") ? this.attr(this.groupBy.slice(5)) : null;
    if (groupAttr) {
      const groups = groupByAttr(groupAttr, tasks);
      if (!groups.length) root.createDiv({ cls: "brewin-empty", text: "Nothing to group." });
      for (const g of groups) this.section(root, g.label === null ? `No ${groupAttr.label.toLowerCase()}` : `${groupAttr.icon} ${g.label}`, g.tasks);
      return this.renderBulkBar();
    }

    // A board, in any view that can be one — except Week by day and Projects, which draw their own.
    if (this.isBoard() && this.view !== "projects" && !(this.view === "week" && this.boardField() === "day")) {
      this.renderBoard(root, this.boardField(), this.boardTasks(tasks, today), today);
      return this.renderBulkBar();
    }

    if (this.view === "today") { this.renderToday(root, tasks, today); return this.renderBulkBar(); }
    if (this.view === "week") { this.renderWeek(root, tasks, today); return this.renderBulkBar(); }
    if (this.view === "inbox") { this.renderInbox(root, tasks); return this.renderBulkBar(); }
    if (this.view === "attention") { this.renderAttention(root, tasks, today); return this.renderBulkBar(); }
    if (this.view === "projects") { this.renderProjects(root, tasks, today); return this.renderBulkBar(); }
    if (this.view === "review") { await this.renderReview(root, today); return this.renderBulkBar(); }

    // ── Buckets (All) ──
    this.section(root, "🔴 Overdue", buckets.overdue, "brewin-overdue");
    if (buckets.carried.length) this.renderCarried(root, buckets.carried, today);
    this.section(root, "📌 Today", buckets.today, "brewin-today");

    if (buckets.upcoming.length) {
      const head = this.sectionHeader(root, "🗓 Upcoming", buckets.upcoming.length);
      const body = root.createDiv();
      head.addEventListener("click", () => body.toggleClass("brewin-collapsed", !body.hasClass("brewin-collapsed")));
      for (const group of groupByDate(buckets.upcoming)) {
        body.createEl("div", { cls: "brewin-date-label", text: relativeDay(group.date, today) });
        group.tasks.forEach((t) => this.taskRow(body, t));
      }
    }

    this.section(root, "📥 Unplanned", buckets.unplanned, "brewin-unplanned");
    this.section(root, "⏸ On hold", buckets.onhold, "brewin-onhold");
    if (buckets.someday.length) this.renderSomeday(root, buckets.someday);

    // ── Project tasks ──
    if (this.plugin.settings.showProjectTasks && !this.contextFilter && !this.flagFilter && !this.attrFilter) {
      const src = new ProjectTaskSource(this.app, this.plugin.settings);
      const projTasks = await src.getProjectTasks();
      if (projTasks.length) {
        this.sectionHeader(root, "⚡ Project tasks", projTasks.length);
        const byProject = new Map<string, ProjectTask[]>();
        projTasks.forEach((p) => {
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

    const anything = ["overdue", "carried", "today", "upcoming", "unplanned", "onhold", "someday"] as const;
    if (anything.every((k) => !buckets[k].length)) {
      root.createDiv({ cls: "brewin-empty", text: "No tasks. Press ＋ to capture one." });
    }
    this.renderBulkBar();
  }

  // ── Board cards ────────────────────────────────────────────────────────────

  /** A draggable task card. Dropping it on another day column reschedules it. */
  private card(parent: HTMLElement, task: Task, dayISO: string): void {
    const el = parent.createDiv({ cls: "brewin-card" + (task.status === "hold" ? " is-hold" : "") });

    const top = el.createDiv({ cls: "brewin-card-top" });
    const cb = top.createEl("input", { type: "checkbox" });
    cb.checked = task.status === "done";
    cb.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (task.status === "done") {
        await this.plugin.store.reopen(task);
        return void this.render();
      }
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
    if (task.flag) meta.createSpan({ cls: "brewin-meta-flag", text: task.flag.icon, attr: { "aria-label": task.flag.label } });
    task.contexts.forEach((c) => meta.createSpan({ cls: "brewin-meta-ctx", text: `@${c}` }));

    el.addEventListener("click", () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.editTask(task);
    });
    this.makeDraggable(el, task, true);
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
    top.createSpan({ cls: "brewin-card-title", text: plainText(pt.text) || "(untitled task)" });

    const meta = el.createDiv({ cls: "brewin-card-meta" });
    if (pt.scheduled) meta.createSpan({ text: `📅 ${pt.scheduled}` });
    if (pt.due) meta.createSpan({ cls: "brewin-meta-due", text: `🚩 ${pt.due}` });
    el.addEventListener("click", () => this.openProjectLine(pt));
  }

  /**
   * Press-and-hold drag for a task — a board card or, beside the menu, a list row. It lands on a
   * day column of the week board, or on a menu entry: Today, Inbox, a project, a context, or one
   * of the drop-only targets the menu shows while a drag is under way.
   *
   * A recurring task's dates belong to its rule, so the day targets refuse it; it can still be
   * given a context or a project.
   */
  private makeDraggable(el: HTMLElement, task: Task, isCard: boolean): void {
    el.addClass("brewin-draggable");

    let ghost: HTMLElement | null = null;
    // Where the pointer last was, for scrolling the menu while it is held near an edge.
    let lastX = 0;
    let lastY = 0;
    let frame = 0;
    const tick = () => {
      if (this.scrollMenuNear(lastX, lastY)) this.highlightColumn(lastX, lastY);
      frame = window.requestAnimationFrame(tick);
    };
    const teardown = () => {
      window.cancelAnimationFrame(frame);
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
        ghost.setText(task.title);
        hapticTick();
        if (!this.drawer) frame = window.requestAnimationFrame(tick); // the drawer is shut mid-drag
      },
      onMove: (x, y) => {
        lastX = x;
        lastY = y;
        if (ghost) {
          ghost.style.left = x + 10 + "px";
          ghost.style.top = y + 10 + "px";
        }
        this.highlightColumn(x, y);
      },
      onDrop: async (x, y) => {
        const target = this.columnAt(x, y);
        teardown();
        // The trailing click lands on a card (it has its own click handler) — not on a row.
        if (isCard) this.suppressClick = true;
        const iso = target?.getAttribute("data-drop-date");
        const key = target?.getAttribute("data-drop-menu");
        const col = target?.getAttribute("data-drop-col");
        if (col) {
          await this.applyBoardDrop(col, el.closest("[data-drop-col]")?.getAttribute("data-drop-col") ?? null, task);
        } else if (iso) {
          if (task.recurrence) {
            new Notice(`“${task.title}” repeats on its own schedule.`);
            return;
          }
          await this.plugin.store.setScheduled(task, iso);
          new Notice(`"${task.title}" moved to ${shortDate(iso)}.`);
          this.render();
        } else if (key) {
          await this.applyMenuDrop(key, task);
        }
      },
      onCancel: teardown,
    });
  }

  /**
   * Mid-drag, holding a task near the top or bottom of the menu scrolls it, so projects and
   * contexts below the fold can be reached. Returns whether it moved.
   */
  private scrollMenuNear(x: number, y: number): boolean {
    const scroller = this.menuEl?.querySelector<HTMLElement>(".brewin-menu-scroll");
    if (!scroller) return false;
    const r = scroller.getBoundingClientRect();
    if (x < r.left || x > r.right) return false;
    const edge = 56;
    const before = scroller.scrollTop;
    if (y > r.bottom - edge) scroller.scrollTop += Math.ceil((y - (r.bottom - edge)) / 4);
    else if (y < r.top + edge) scroller.scrollTop -= Math.ceil((r.top + edge - y) / 4);
    return scroller.scrollTop !== before;
  }

  private columnAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return (el?.closest("[data-drop-date], [data-drop-menu], [data-drop-col]") as HTMLElement | null) ?? null;
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
    // Active work only: on-hold and someday tasks are not part of planning a week.
    const allTasks = this.plugin.store.getTasks().filter((t) => t.status === "todo");
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

    // ── Week only: each project's next action, copied into the notebook with the week ──
    if (this.reviewView === "week") this.renderReviewProjects(root, today);

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

  /**
   * Project HQ's weekly transfer, inside the Review: each active or waiting project with its next
   * action, ticked as it's copied into the notebook — and any project without one, with a way to
   * choose one there and then, so none leaves the review stalled.
   */
  private renderReviewProjects(root: HTMLElement, today: string): void {
    const list = this.projects
      .filter((p) => p.info.status === "active" || p.info.status === "waiting")
      .sort((a, b) => Number(a.info.status === "waiting") - Number(b.info.status === "waiting"));
    if (!list.length) return;
    const copyable = list.filter((p) => !!p.info.next);
    const keyOf = (p: MenuProject) => `project|${p.path}`;

    const open = this.reviewProjOpen;
    const box = root.createDiv({ cls: "brewin-review-unscheduled brewin-review-projects" + (open ? "" : " is-collapsed") });
    const head = box.createDiv({ cls: "brewin-review-unsch-head" });
    head.createSpan({ cls: "brewin-expander", text: open ? "▾" : "▸" });
    head.createEl("h4", { text: "Projects — next actions" });
    const count = head.createSpan({ cls: "brewin-count" });
    const renderCount = () => {
      const n = copyable.filter((p) => this.transferred.has(keyOf(p))).length;
      count.setText(copyable.length ? `${n} of ${copyable.length}` : String(list.length));
    };
    renderCount();
    head.setAttr("role", "button");
    head.setAttr("tabindex", "0");
    head.setAttr("aria-expanded", String(open));
    const toggle = () => {
      this.reviewProjOpen = !this.reviewProjOpen;
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

    for (const p of list) {
      const key = keyOf(p);
      const row = box.createDiv({ cls: "brewin-review-row brewin-review-proj" + (this.transferred.has(key) ? " is-transferred" : "") });
      if (p.info.next) {
        // As on the days below: "written into the journal", never done. It touches no note.
        const tick = row.createEl("input", { type: "checkbox", cls: "brewin-transfer-box" });
        tick.checked = this.transferred.has(key);
        tick.setAttr("aria-label", `Mark ${p.name}'s next action as transferred`);
        tick.addEventListener("click", (e) => {
          e.stopPropagation();
          if (tick.checked) this.transferred.add(key);
          else this.transferred.delete(key);
          row.toggleClass("is-transferred", tick.checked);
          renderCount();
        });
      } else {
        // Nothing to copy yet. An invisible box keeps this row's text in line with the others.
        const blank = row.createEl("input", { type: "checkbox", cls: "brewin-transfer-box brewin-transfer-blank" });
        blank.disabled = true;
        blank.tabIndex = -1;
        blank.setAttr("aria-hidden", "true");
      }
      const waiting = p.info.status === "waiting";
      row.createSpan({ cls: "brewin-review-glyph", text: STATUS_GLYPH[waiting ? "waiting" : "active"] });
      const main = row.createDiv({ cls: "brewin-review-title brewin-review-proj-main" });
      main.createSpan({ cls: "brewin-task-link brewin-review-proj-name", text: p.name }).addEventListener("click", () => this.go({ project: p.path }));
      const stalled = isStalled(p.info, p.inline);
      const runners = p.inline.filter((st) => st.isNext).length;
      const what = waiting
        ? [p.info.waitingOn ? `waiting on ${p.info.waitingOn}` : "waiting", p.info.next ? `then: ${plainText(p.info.next)}` : ""].filter(Boolean).join(" · ")
        : plainText(p.info.next) || (stalled ? "🚩 No next action" : `No next action — ${runners} ⚡ step${runners === 1 ? "" : "s"} ready`);
      main.createSpan({ cls: "brewin-review-proj-next" + (!p.info.next && !waiting ? " is-unset" : ""), text: what });
      const d = deadline(p.info, today);
      if (d?.overdue) main.createSpan({ cls: "brewin-review-proj-due", text: `🏁 ${deadlineLabel(d)}` });
      if (!p.info.next) {
        const b = row.createEl("button", { cls: "brewin-chip-mini", text: "Choose…" });
        b.addEventListener("click", () => this.advanceNext(p, false));
      }
    }
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
        this.iconBtn(actions, "⏱️", this.plugin.timer.isRunning(task.path) ? "Focus timer (timing)" : "Focus timer", () => this.plugin.openFocus(task.path));
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

    act("💭 Someday", async () => {
      // Recurring tasks keep their schedule; a wishlist is for one-offs.
      const changed = await this.plugin.store.bulkSetStatus(this.selectedTasks().filter((x) => !x.recurrence), "someday");
      after(`${changed} task${changed === 1 ? "" : "s"} moved to Someday.`);
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

  /** Sections folded away this session, by key — they stay folded across redraws. The Birthdays
   *  page's long tail (everyone without a date) starts folded. */
  private folded = new Set<string>(["bday-nodate", "bday-hidden", "bday-died"]);

  /**
   * Plans for days that have passed, oldest first, each with one-tap answers. They used to sit in
   * Today's "Anytime" with their old dates — eight of ten "left" one morning were weeks old.
   */
  private renderCarried(root: HTMLElement, tasks: Task[], today: string): void {
    const head = this.sectionHeader(root, "⏳ Carried over", tasks.length);
    const allBtn = head.createEl("button", { text: "All to today", cls: "brewin-chip-mini" });
    allBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const n = await this.plugin.store.bulkReschedule(tasks, today);
      new Notice(`Moved ${n} task${n === 1 ? "" : "s"} to today.`);
      this.render();
    });
    const body = root.createDiv({ cls: "brewin-carried" });
    this.foldable(head, body, "carried");
    tasks.forEach((t) => this.taskRow(body, t, false, false, { triage: true }));
  }

  /** Someday: things that will never get a date, read as lists — one per context. */
  private renderSomeday(root: HTMLElement, tasks: Task[]): void {
    const head = this.sectionHeader(root, "💭 Someday", tasks.length);
    const body = root.createDiv({ cls: "brewin-someday" });
    this.foldable(head, body, "someday");
    for (const g of groupSomeday(tasks)) {
      const label = body.createDiv({ cls: "brewin-date-label" });
      label.createSpan({ text: g.context ? `@${g.context}` : "No context" });
      label.createSpan({ cls: "brewin-count", text: String(g.tasks.length) });
      g.tasks.forEach((t) => this.taskRow(body, t));
    }
  }

  /** Tap a section header to fold it; remembered for the rest of the session. */
  private foldable(head: HTMLElement, body: HTMLElement, key: string): void {
    body.toggleClass("brewin-collapsed", this.folded.has(key));
    head.addClass("is-foldable");
    head.addEventListener("click", () => {
      const now = !this.folded.has(key);
      if (now) this.folded.add(key);
      else this.folded.delete(key);
      body.toggleClass("brewin-collapsed", now);
    });
  }

  // ── Birthdays ──────────────────────────────────────────────────────────────

  /** How many birthdays fall within the warning window (at least a week) — the menu's count. */
  private birthdaysSoon(today: string): number {
    const days = Math.max(7, this.plugin.settings.birthdayRemindDays);
    return birthdaysBetween(this.plugin.birthdays.getPeople(), today, shiftISO(today, days) ?? today).length;
  }

  /** Birthdays: the year ahead month by month, then everyone whose note still needs a date. */
  private renderBirthdays(root: HTMLElement, today: string): void {
    const everyone = this.plugin.birthdays.getPeople();
    if (!everyone.length) {
      root.createDiv({
        cls: "brewin-empty",
        text: `No people notes found in ${this.plugin.settings.peopleFolder}. The folder is set under Birthdays in the Planner's settings.`,
      });
      return;
    }
    const q = this.query.trim().toLowerCase();
    const page = birthdayPage(q ? everyone.filter((p) => p.name.toLowerCase().includes(q)) : everyone, today);

    if (!page.months.length) {
      root.createDiv({ cls: "brewin-empty", text: q ? "Nobody by that name has a birthday set." : "No birthdays yet — set one below." });
    }
    for (const m of page.months) {
      const label = root.createDiv({ cls: "brewin-date-label" });
      label.createSpan({ text: m.label });
      label.createSpan({ cls: "brewin-count", text: String(m.rows.length) });
      for (const r of m.rows) {
        const row = root.createDiv({ cls: "brewin-bday-row" + (r.inDays === 0 ? " is-today" : "") });
        row.createSpan({ cls: "brewin-bday-date", text: shortDate(r.date) });
        const main = row.createDiv({ cls: "brewin-bday-main" });
        const name = main.createSpan({ cls: "brewin-task-link", text: r.person.name });
        name.addEventListener("click", () => this.openNote(r.person.path));
        const when = r.inDays === 0 ? "today 🎉" : r.inDays === 1 ? "tomorrow" : r.inDays <= 31 ? `in ${r.inDays} days` : "";
        const meta = [r.age != null ? `turns ${r.age}` : "", when].filter(Boolean).join(" · ");
        if (meta) main.createSpan({ cls: "brewin-bday-meta", text: meta });
        this.iconBtn(row, "✏️", "Change the date", () => this.promptBirthday(r.person));
      }
    }

    const listSection = (key: string, title: string, people: Person[], action: string | null, showRaw: boolean) => {
      if (!people.length) return;
      const head = this.sectionHeader(root, title, people.length);
      const body = root.createDiv();
      this.foldable(head, body, key);
      for (const p of people) {
        const row = body.createDiv({ cls: "brewin-bday-row is-missing" });
        const main = row.createDiv({ cls: "brewin-bday-main" });
        const name = main.createSpan({ cls: "brewin-task-link", text: p.name });
        name.addEventListener("click", () => this.openNote(p.path));
        if (showRaw && p.raw) main.createSpan({ cls: "brewin-bday-meta", text: p.raw });
        if (action) {
          const b = row.createEl("button", { cls: "brewin-chip-mini", text: action });
          b.addEventListener("click", () => this.promptBirthday(p));
        }
      }
    };
    // What can't be read is a mistake to fix, so it is open; the rest is reference, folded.
    listSection("bday-unreadable", "⚠️ Can't read the date", page.unreadable, "Fix…", true);
    listSection("bday-nodate", "No birthday yet", page.noDate, "Set…", false);
    listSection("bday-hidden", "Hidden — Birthday:: hidden", page.hidden, null, true);
    listSection("bday-died", "Died", page.died, null, true);
  }

  /** Ask for a birthday and write it into the person's note, in one consistent format. */
  private promptBirthday(p: Person): void {
    new PromptModal(this.app, {
      title: `Birthday — ${p.name}`,
      body: "With the year (1990-03-18) or without it (5 November).",
      placeholder: "5 November",
      initial: p.dob ? formatBirthDate(p.dob) : p.raw,
      cta: "Save",
      onSubmit: async (value) => {
        const d = parseBirthDate(value);
        if (!d) {
          new Notice(`Couldn't read “${value}” as a date — try 1990-03-18 or 5 November.`);
          return;
        }
        await this.plugin.birthdays.setDob(p, formatBirthDate(d));
        new Notice(`${p.name}: ${formatBirthDate(d)}`);
        this.render();
      },
    }).open();
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  /** Today: overdue pinned on top, then the day in clock order, then anything undated. */
  private renderToday(root: HTMLElement, tasks: Task[], today: string): void {
    const events = this.plugin.settings.showEventsOnCalendar
      ? eventsToItems(this.plugin.events.getEvents(), today, today)
      : [];
    // Today's training from the Fitness plan sits in the timeline with everything else.
    const a = todayAgenda(tasks, [...events, ...this.plugin.trainingItems(today, today)], today);

    const head = root.createDiv({ cls: "brewin-today-head" });
    head.createSpan({ cls: "brewin-today-date", text: prettyDate(today) });
    // "Left" is today's plan; carried-over tasks are counted apart until they are accepted back in.
    const carried = a.carried.length ? ` · ${a.carried.length} carried` : "";
    head.createSpan({
      cls: "brewin-count",
      text: (a.openCount === 0 ? `all clear · ${a.doneCount} done` : `${a.openCount} left · ${a.doneCount} done`) + carried,
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
        const isTraining = e.path.startsWith("training:");
        const chip = strip.createSpan({ cls: "brewin-allday-chip" + (isTraining ? " is-training" : ""), text: isTraining ? `🛌 ${e.title}` : e.title });
        if (e.location) chip.setAttr("title", `📍 ${e.location}`);
        // A rest day from the Fitness plan has no note behind it to open.
        if (!isTraining) chip.addEventListener("click", () => this.openNote(e.path));
      });
    }

    if (a.overdue.length) {
      this.sectionHeader(root, "🔴 Overdue", a.overdue.length);
      const band = root.createDiv({ cls: "brewin-overdue" });
      a.overdue.forEach((t) => this.taskRow(band, t));
    }

    if (a.carried.length) this.renderCarried(root, a.carried, today);

    if (a.timed.length) {
      this.sectionHeader(root, "⏰ Timed", a.timed.filter((r) => r.kind !== "event" && r.kind !== "training").length);
      const body = root.createDiv();
      const trainingByTitle = new Map(this.plugin.trainingItems(today, today).map((it) => [it.title, it]));
      for (const row of a.timed) {
        if (row.kind === "training") {
          // A session from the Fitness plan: tap to start it, or to open it once it is going.
          const item = trainingByTitle.get(row.title);
          const line = body.createDiv({ cls: "brewin-agenda-row is-training" + (row.done ? " done" : "") });
          line.createSpan({ cls: "brewin-agenda-time", text: row.time });
          line.createSpan({ cls: "brewin-agenda-title", text: `${row.done ? "✓" : "▲"} ${row.title}` });
          line.setAttr("aria-label", row.done ? "Training — open the session" : "Training — start the session");
          if (item) line.addEventListener("click", () => void this.plugin.openTraining(item));
          continue;
        }
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

    if (!a.overdue.length && !a.timed.length && !a.anytime.length && !a.carried.length) {
      root.createDiv({
        cls: "brewin-empty",
        text: a.doneCount ? "Everything for today is done." : "Nothing scheduled for today.",
      });
    }

    this.renderDoneToday(root, tasks, today);
  }

  /**
   * ✅ Completed: what was finished today, folded away under its heading (the fold is remembered).
   * A one-off unticks to reopen. A repeating task has already moved on to its next date when ticked,
   * so it is shown done, but can't be unticked from here.
   */
  private renderDoneToday(root: HTMLElement, tasks: Task[], today: string): void {
    const done = weekTaskReview(tasks, today, today, today);
    const n = done.doneOneOff.length + done.doneRecurring.length;
    if (!n) return;
    const s = this.plugin.settings;
    const head = this.sectionHeader(root, "✅ Completed", n);
    head.addClass("is-foldable", "brewin-done-head");
    const chevron = head.createSpan({ cls: "brewin-fold-chevron", text: s.todayDoneOpen ? "▾" : "▸" });
    head.prepend(chevron);
    head.setAttr("role", "button");
    head.setAttr("aria-expanded", String(s.todayDoneOpen));
    const body = root.createDiv({ cls: "brewin-done-today" });
    body.toggleClass("brewin-collapsed", !s.todayDoneOpen);
    head.addEventListener("click", async () => {
      s.todayDoneOpen = !s.todayDoneOpen;
      body.toggleClass("brewin-collapsed", !s.todayDoneOpen);
      chevron.setText(s.todayDoneOpen ? "▾" : "▸");
      head.setAttr("aria-expanded", String(s.todayDoneOpen));
      await this.plugin.saveSettings();
    });
    for (const t of done.doneOneOff) this.taskRow(body, t, true);
    for (const r of done.doneRecurring) {
      const row = body.createDiv({ cls: "brewin-task-row brewin-done-recurring" });
      const box = row.createEl("input", { type: "checkbox" });
      box.checked = true;
      box.disabled = true;
      box.setAttr("aria-label", "Done today — it is already on its next date");
      const main = row.createDiv({ cls: "brewin-task-main" });
      const title = main.createDiv({ cls: "brewin-task-title" });
      title.createSpan({ cls: "brewin-recur", text: "🔁 " });
      const link = title.createSpan({ cls: "brewin-task-link", text: r.task.title });
      link.addEventListener("click", () => this.editTask(r.task));
      const next = r.task.scheduled && r.task.scheduled > today ? ` · next ${relativeDay(r.task.scheduled, today)}` : "";
      main.createDiv({ cls: "brewin-task-meta", text: `done today${next}` });
    }
  }

  /** Week: the next 7 days, one group per day, empty days kept as visible breathing room. */
  private renderWeek(root: HTMLElement, tasks: Task[], today: string): void {
    const days = weekAgenda(tasks, today, 7);
    const total = days.reduce((n, d) => n + d.tasks.length, 0);

    // Seven board columns on a phone showed a day and a half; the list reads the whole week.
    if (this.layout() === "board" && !Platform.isPhone) {
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
    const someday = tasks.filter((t) => t.status === "someday");
    if (!list.length) {
      root.createDiv({ cls: "brewin-empty", text: "Inbox zero — everything has a date or a Someday." });
    } else {
      this.sectionHeader(root, "📥 Needs scheduling", list.length);
      list.forEach((t) => this.taskRow(root, t));
    }
    if (someday.length) this.renderSomeday(root, someday);
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
      const head = this.sectionHeader(root, "⏳ Slipped — planned for a day that's gone", g.slipped.length);
      const allBtn = head.createEl("button", { text: "All to today", cls: "brewin-chip-mini" });
      allBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const n = await this.plugin.store.bulkReschedule(g.slipped, today);
        new Notice(`Moved ${n} task${n === 1 ? "" : "s"} to today.`);
        this.render();
      });
      g.slipped.forEach((t) => this.taskRow(root, t, false, false, { triage: true }));
    }
    if (g.onhold.length) {
      this.sectionHeader(root, "⏸ On hold", g.onhold.length);
      g.onhold.forEach((t) => this.taskRow(root, t));
    }
  }

  /**
   * Projects: each active project with its next action and deadline, then its open work — task
   * notes, then the checkbox lines in its note. Waiting and Someday projects follow, as names.
   * A project's name opens it on its own page.
   */
  private renderProjects(root: HTMLElement, tasks: Task[], today: string): void {
    const src = new ProjectTaskSource(this.app, this.plugin.settings);
    const groups = this.activeProjects().map((p) => ({ p, notes: this.projectNotes(tasks, p.path) }));
    const waiting = this.projects.filter((p) => p.info.status === "waiting");
    // Someday, and any project whose status HQ wouldn't recognise — parked either way.
    const parked = this.projects.filter((p) => p.info.status === "someday" || p.info.status === null);
    if (!groups.length && !waiting.length && !parked.length) {
      root.createDiv({ cls: "brewin-empty", text: `No projects in ${this.plugin.settings.projectsFolder}.` });
      return;
    }
    if (!groups.length) root.createDiv({ cls: "brewin-empty", text: "No active projects." });

    if (groups.length && this.layout() === "board") {
      const board = root.createDiv({ cls: "brewin-board" });
      for (const { p, notes } of groups) {
        const col = board.createDiv({ cls: "brewin-board-col" });
        const head = col.createDiv({ cls: "brewin-board-head" });
        const link = head.createSpan({ cls: "brewin-task-link", text: p.name });
        link.addEventListener("click", () => this.go({ project: p.path }));
        head.createSpan({ cls: "brewin-count", text: String(notes.length + p.inline.length) });
        const body = col.createDiv({ cls: "brewin-board-body" });
        this.projectBrief(body, p, today);
        for (const t of notes) this.card(body, t, today);
        for (const item of p.inline) this.projectCard(body, src, item, today);
      }
    } else {
      for (const { p, notes } of groups) {
        const label = root.createDiv({ cls: "brewin-date-label brewin-project-label" });
        const link = label.createSpan({ cls: "brewin-task-link", text: p.name });
        link.addEventListener("click", () => this.go({ project: p.path }));
        const n = notes.length + p.inline.length;
        if (n) label.createSpan({ cls: "brewin-count", text: String(n) });
        this.projectBrief(root, p, today);
        for (const t of notes) this.taskRow(root, t);
        for (const item of p.inline) this.projectRow(root, src, item, today);
      }
    }

    const parkedList = (key: string, title: string, list: MenuProject[]) => {
      if (!list.length) return;
      const head = this.sectionHeader(root, title, list.length);
      const body = root.createDiv();
      this.foldable(head, body, key);
      for (const p of list) {
        const row = body.createDiv({ cls: "brewin-proj-row" });
        const link = row.createSpan({ cls: "brewin-task-link", text: p.name });
        link.addEventListener("click", () => this.go({ project: p.path }));
        const meta =
          p.info.status === "waiting"
            ? [p.info.waitingOn ? `waiting on ${p.info.waitingOn}` : "waiting", p.info.next ? `then: ${plainText(p.info.next)}` : ""]
            : [p.info.status === null ? "no status" : "", plainText(p.info.next)];
        const text = meta.filter(Boolean).join(" · ");
        if (text) row.createSpan({ cls: "brewin-proj-row-meta", text });
      }
    };
    parkedList("proj-waiting", "⏳ Waiting", waiting);
    parkedList("proj-someday", "💭 Someday", parked);
  }

  /**
   * Under a project's name: its next action (tap to change it, ✓ when it's done), or — when it has
   * none — what to do about that; and its deadline, when it has one.
   */
  private projectBrief(parent: HTMLElement, p: MenuProject, today: string, showDue = true): void {
    const box = parent.createDiv({ cls: "brewin-proj-brief" });
    const next = box.createDiv({ cls: "brewin-proj-next" });
    if (p.info.next) {
      next.createSpan({ cls: "brewin-proj-next-label", text: "Next" });
      const text = next.createSpan({ cls: "brewin-proj-next-text", text: plainText(p.info.next) });
      text.setAttr("role", "button");
      text.setAttr("aria-label", "Change the next action");
      text.addEventListener("click", () => this.editNext(p));
      const done = next.createEl("button", { cls: "brewin-chip-mini", text: "✓ Done" });
      done.setAttr("aria-label", "The next action is done — choose the one after it");
      done.addEventListener("click", () => this.advanceNext(p, true));
    } else {
      const runners = p.inline.filter((s) => s.isNext).length;
      const stalled = isStalled(p.info, p.inline);
      next.addClass(stalled ? "is-stalled" : "is-unset");
      box.toggleClass("is-stalled", stalled);
      next.createSpan({
        cls: "brewin-proj-next-text",
        text: stalled
          ? "🚩 No next action"
          : p.info.status === "active"
            ? `No next action — ${runners} ⚡ step${runners === 1 ? "" : "s"} ready`
            : "No next action",
      });
      next.createEl("button", { cls: "brewin-chip-mini", text: "Choose…" }).addEventListener("click", () => this.advanceNext(p, false));
    }
    const d = showDue ? deadline(p.info, today) : null;
    if (d) {
      const due = box.createDiv({ cls: "brewin-proj-due" + (d.overdue ? " is-overdue" : "") });
      due.setText(`🏁 ${shortDate(d.iso)} · ${deadlineLabel(d)}`);
      due.setAttr("role", "button");
      due.setAttr("aria-label", "Change the deadline");
      due.addEventListener("click", () => this.setProjectDue(p));
    }
  }

  /** The top of a project's own page: its status and deadline, what it waits on, and its next action. */
  private projectHead(root: HTMLElement, p: MenuProject, today: string): void {
    const head = root.createDiv({ cls: "brewin-proj-head" });
    const chips = head.createDiv({ cls: "brewin-proj-chips" });
    const st = p.info.status;
    const status = chips.createEl("button", {
      cls: "brewin-proj-status" + (st ? ` is-${st}` : ""),
      text: st ? `${STATUS_GLYPH[st]} ${STATUS_LABEL[st]}` : "No status",
    });
    status.setAttr("aria-label", "Change the project's status");
    status.addEventListener("click", (ev) => this.statusMenu(ev, p));
    const d = deadline(p.info, today);
    const due = chips.createEl("button", {
      cls: "brewin-proj-status brewin-proj-deadline" + (d?.overdue ? " is-overdue" : ""),
      text: d ? `🏁 ${shortDate(d.iso)} · ${deadlineLabel(d)}` : "🏁 Add a deadline",
    });
    if (!d) due.addClass("is-quiet");
    due.setAttr("aria-label", d ? "Change the deadline" : "Give the project a deadline");
    due.addEventListener("click", () => this.setProjectDue(p));
    if (st === "waiting") {
      const w = head.createDiv({ cls: "brewin-proj-waiting", text: p.info.waitingOn ? `⏳ Waiting on ${p.info.waitingOn}` : "⏳ Waiting — on what?" });
      w.setAttr("role", "button");
      w.addEventListener("click", () => this.changeStatus(p, "waiting"));
    }
    // The deadline is a chip above, so the brief below carries only the next action.
    this.projectBrief(head, p, today, false);
  }

  private statusMenu(ev: MouseEvent, p: MenuProject): void {
    const m = new Menu();
    for (const s of PROJECT_STATUSES) {
      m.addItem((i) =>
        i
          .setTitle(`${STATUS_GLYPH[s]} ${STATUS_LABEL[s]}${s === "waiting" ? "…" : ""}`)
          .setChecked(p.info.status === s)
          .onClick(() => this.changeStatus(p, s))
      );
    }
    m.showAtMouseEvent(ev);
  }

  /** Move a project to another status. Waiting asks on what; done asks first. */
  private changeStatus(p: MenuProject, status: ProjectStatus): void {
    const store = this.plugin.projects;
    if (status === "waiting") {
      new PromptModal(this.app, {
        title: `Waiting — ${p.name}`,
        body: "Who or what is it waiting on?",
        placeholder: "A reply from the landlord",
        initial: p.info.waitingOn,
        cta: "Save",
        onSubmit: async (value) => {
          await store.setStatus(p.info, "waiting", value);
          this.render();
        },
      }).open();
      return;
    }
    if (status === p.info.status) return;
    if (status === "done") {
      const open = p.inline.length + this.projectNotes(this.plugin.store.getTasks(), p.path).length;
      new ConfirmModal(this.app, {
        title: `Mark ${p.name} done?`,
        body:
          (open ? `Its ${open} open step${open === 1 ? " stays" : "s stay"} as they are. ` : "") +
          "It leaves the Planner and moves to Recently done in Project HQ.",
        cta: "Mark done",
        onConfirm: async () => {
          await store.setStatus(p.info, "done");
          if (this.project === p.path) {
            this.project = null;
            this.view = "projects";
          }
          new Notice(`✓ ${p.name} is done.`);
          this.render();
        },
      }).open();
      return;
    }
    void store.setStatus(p.info, status).then(() => {
      new Notice(`${p.name}: ${STATUS_LABEL[status]}`);
      this.render();
    });
  }

  /** Finish the next action and choose the one after it — or, with `done` false, just choose one. */
  private advanceNext(p: MenuProject, done: boolean): void {
    const steps = [...p.inline].sort((a, b) => a.line - b.line); // offered in the note's own order
    new NextActionModal(this.app, {
      project: p.info,
      steps,
      done,
      onSubmit: async (c) => {
        await this.plugin.projects.advance(p.info, { done, ...c });
        new Notice(c.next ? `${p.name} — next: ${plainText(c.next)}` : `${p.name}: no next action yet.`);
        this.render();
      },
    }).open();
  }

  private editNext(p: MenuProject): void {
    new PromptModal(this.app, {
      title: `Next action — ${p.name}`,
      body: "One physical action. Leave it empty to clear it.",
      initial: p.info.next,
      cta: "Save",
      allowEmpty: true,
      onSubmit: async (value) => {
        if (value === p.info.next) return;
        await this.plugin.projects.setNext(p.info, value);
        this.render();
      },
    }).open();
  }

  private async setProjectDue(p: MenuProject): Promise<void> {
    const r = await pickDate(this.app, p.info.due, this.plugin.settings.firstDayOfWeek, { selectedLabel: "Deadline" });
    if (r === undefined || r === p.info.due) return;
    await this.plugin.projects.setDue(p.info, r);
    this.render();
  }

  /** A project's open task notes, soonest first. */
  private projectNotes(tasks: Task[], path: string): Task[] {
    return tasks
      .filter((t) => t.projectPath === path && isOpen(t))
      .sort((a, b) => (a.scheduled ?? a.due ?? "9999").localeCompare(b.scheduled ?? b.due ?? "9999") || a.title.localeCompare(b.title));
  }

  /** One project on its own: its task notes, then the checkbox lines in its note. */
  private renderProjectScope(root: HTMLElement, tasks: Task[], today: string): void {
    const p = this.projects.find((x) => x.path === this.project);
    if (!p) return;
    this.projectHead(root, p, today);
    const src = new ProjectTaskSource(this.app, this.plugin.settings);
    const notes = this.projectNotes(tasks, p.path);
    // Checkbox lines carry no contexts, so narrowing to a context leaves only the task notes.
    let lines = this.contextFilter ? [] : p.inline;
    if (this.query.trim()) lines = search(lines.map((pt) => ({ pt, title: pt.text, contexts: [] as string[] })), this.query).map((h) => h.pt);

    if (!notes.length && !lines.length) {
      const narrowed = !!this.query.trim() || !!this.contextFilter;
      root.createDiv({
        cls: "brewin-empty",
        text: narrowed ? "Nothing in this project matches." : "Nothing open in this project. Add a task with ＋, or move one here from its ⋯ menu.",
      });
      return;
    }
    if (notes.length) {
      this.sectionHeader(root, "📝 Tasks", notes.length);
      const body = root.createDiv();
      notes.forEach((t) => this.taskRow(body, t));
    }
    if (lines.length) {
      const head = this.sectionHeader(root, "📄 In the project note", lines.length);
      head.setAttr("title", "Checkbox lines in the note itself");
      const body = root.createDiv();
      lines.forEach((pt) => this.projectRow(body, src, pt, today));
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

  private taskRow(parent: HTMLElement, task: Task, isDone = false, isSubtask = false, opts: { triage?: boolean } = {}): void {
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
    // Dates said the way they matter — "16 days ago", "Fri", "24 Dec" — with the exact date a
    // long-press away, rather than an ISO string to decode.
    // Planned and due the same day: the deadline says it once, rather than the same date twice.
    if (task.scheduled && !(task.due === task.scheduled && !task.startTime)) {
      const time = task.startTime ? ` ${task.startTime}${task.endTime ? `–${task.endTime}` : ""}` : "";
      const s = meta.createSpan({ cls: "brewin-meta-sched", text: `📅 ${relativeDay(task.scheduled, today)}${time}` });
      s.setAttr("title", task.scheduled);
    }
    if (task.due) {
      const d = meta.createSpan({ cls: "brewin-meta-due", text: `🚩 ${task.due < today ? relativeDay(task.due, today) : `due ${relativeDay(task.due, today)}`}` });
      d.setAttr("title", `Due ${task.due}`);
    }
    // The task's own status, when it has one — tap to see everything else that has it.
    const flag = task.flag;
    if (flag) {
      const chip = meta.createSpan({ cls: "brewin-meta-flag", text: flagText(flag) });
      chip.setAttr("aria-label", `Show only ${flag.label}`);
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        this.go({ view: "all", project: null, flag: flag.id });
      });
    }
    // Time on it: a running focus clock says so; otherwise what's logged, against any estimate.
    const spent = totalMinutes(task.timeLog ?? []);
    if (this.plugin.timer.isRunning(task.path)) {
      const chip = meta.createSpan({ cls: "brewin-meta-timing", text: "⏱ timing" });
      chip.setAttr("aria-label", "Open the focus window");
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.openFocus(task.path);
      });
    } else if (spent) {
      meta.createSpan({ cls: "brewin-meta-spent", text: `⌛ ${minutesText(spent)}${task.estimate ? ` of ${formatEstimate(task.estimate)}` : ""}` });
    }
    // The user's own attributes marked "show on rows" — tap one to see every task with that value.
    for (const a of this.plugin.settings.attributes) {
      const v = task.attrs?.[a.key];
      if (!a.onRow || v === undefined) continue;
      const text = attrChip(a, v);
      if (!text) continue;
      const chip = meta.createSpan({ cls: "brewin-meta-attr", text });
      chip.setAttr("aria-label", `${a.label}: show every task with this`);
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const value = a.kind === "bool" ? "yes" : a.kind === "number" || a.kind === "date" ? "any" : attrMenuValues(a, [{ status: "todo", attrs: { [a.key]: v } }])[0]?.value;
        if (value) this.go({ view: "all", project: null, attr: { key: a.key, value } });
      });
    }
    task.contexts.forEach((c) => meta.createSpan({ cls: "brewin-meta-ctx", text: `@${c}` }));
    // The project it belongs to — tap to see the rest of that project. Not repeated on the project's own page.
    if (task.projectPath && task.projectPath !== this.project) {
      const path = task.projectPath;
      const chip = meta.createSpan({ cls: "brewin-meta-project", text: `⚡ ${path.split("/").pop()?.replace(/\.md$/, "") ?? path}` });
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.projects.some((p) => p.path === path)) this.go({ project: path });
        else this.openNote(path); // not an active project, so it has no page here
      });
    }
    // Parent breadcrumb (skip when already shown nested under that parent)
    if (task.parentPath && !isSubtask) {
      const p = this.index.byPath.get(task.parentPath);
      if (p) {
        const crumb = meta.createSpan({ cls: "brewin-parent-crumb", text: `↳ ${p.title}` });
        crumb.addEventListener("click", () => this.openNote(p.path));
      }
    }

    // Carried over: answer "when, then?" in one tap instead of opening the task. The strip is
    // added to the row after its action icons, so it spans the row's full width underneath.
    let triageStrip: HTMLElement | null = null;
    if (opts.triage && task.status !== "done") {
      const strip = createDiv({ cls: "brewin-triage" });
      triageStrip = strip;
      const act = (label: string, fn: () => Promise<void>) =>
        strip.createEl("button", { text: label, cls: "brewin-triage-btn" }).addEventListener("click", async (e) => {
          e.stopPropagation();
          await fn();
          this.render();
        });
      act("Today", () => this.plugin.store.setScheduled(task, today));
      act("Tomorrow", () => this.plugin.store.setScheduled(task, shiftISO(today, 1)));
      act("Next week", () => this.plugin.store.setScheduled(task, nextWeekStart(today, this.plugin.settings.firstDayOfWeek)));
      // A recurring task's next occurrence is not a wish; it stays on its schedule.
      if (!task.recurrence) act("Someday", () => this.plugin.store.setStatus(task, "someday"));
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
      this.iconBtn(actions, "⏱️", this.plugin.timer.isRunning(task.path) ? "Focus timer (timing)" : "Focus timer", () => this.plugin.openFocus(task.path));
      this.iconBtn(actions, "⋯", "More", (ev) => this.rowMenu(ev, task));
    }
    if (triageStrip) row.appendChild(triageStrip);
    // Beside the menu, a row can be dragged onto it. Not in the drawer: the menu is shut while you drag.
    if (!this.drawer && !isDone && task.status !== "done") this.makeDraggable(row, task, false);

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

  /**
   * Menu values are lower case so that matching ignores case; a drop writes the value back as it is
   * spelt — a choice as listed, text or a link as another task already has it.
   */
  private attrValueAsWritten(a: TaskAttribute, value: string): string {
    if (a.kind === "choice") return (a.options ?? []).find((o) => o.toLowerCase() === value) ?? value;
    for (const t of this.plugin.store.getTasks()) {
      const v = t.attrs?.[a.key];
      if (typeof v === "string" && attrMatches(a, t.attrs, value)) return v;
    }
    return value;
  }

  /** The user's status flags, as menu items: each one this task could take, and taking its own off. */
  private flagMenuItems(menu: Menu, task: Task): void {
    const flags = this.plugin.settings.statusFlags.filter((f) => !flagRefusal(task, f));
    if (!flags.length && !task.flag) return;
    menu.addSeparator();
    for (const f of flags) {
      menu.addItem((i) =>
        i.setTitle(flagText(f)).onClick(async () => {
          const refused = await this.plugin.store.setFlag(task, f);
          if (refused) new Notice(`“${task.title}” ${refused}.`);
          this.render();
        })
      );
    }
    const own = task.flag;
    if (own) {
      menu.addItem((i) =>
        i.setTitle(`Clear ${flagText(own)}`).setIcon("x").onClick(async () => {
          await this.plugin.store.clearFlag(task);
          this.render();
        })
      );
    }
    menu.addSeparator();
  }

  private rowMenu(ev: MouseEvent, task: Task): void {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Edit task…").setIcon("pencil").onClick(() => this.editTask(task)));
    menu.addItem((i) => i.setTitle("Focus timer…").setIcon("timer").onClick(() => this.plugin.openFocus(task.path)));
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
    } else if (task.status !== "someday") {
      menu.addItem((i) => i.setTitle("Put on hold").setIcon("pause").onClick(async () => { await this.plugin.store.setStatus(task, "hold"); this.render(); }));
    }
    if (task.status === "someday") {
      menu.addItem((i) => i.setTitle("Back to the inbox").setIcon("inbox").onClick(async () => { await this.plugin.store.setStatus(task, "todo"); this.render(); }));
    } else if (!task.recurrence && task.status !== "done") {
      menu.addItem((i) => i.setTitle("Move to Someday").setIcon("cloud").onClick(async () => { await this.plugin.store.setStatus(task, "someday"); this.render(); }));
    }
    this.flagMenuItems(menu, task);
    menu.addItem((i) =>
      i.setTitle(task.project ? "Move to another project…" : "Move to project…").setIcon("folder-input").onClick(() => {
        new ProjectSuggestModal(this.app, this.projects.map(({ path, name }) => ({ path, name })), async (p) => {
          await this.plugin.store.setProject(task, p.path);
          new Notice(`“${task.title}” is now in ${p.name}.`);
          this.render();
        }).open();
      })
    );
    if (task.project) {
      menu.addItem((i) => i.setTitle("Remove from project").setIcon("folder-minus").onClick(async () => { await this.plugin.store.setProject(task, null); this.render(); }));
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
    // An empty "- [ ]" line in the note still deserves a visible row, or it reads as a stray checkbox.
    titleLine.createSpan({ cls: pt.text ? "" : "brewin-untitled", text: plainText(pt.text) || "(untitled task)" });
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
