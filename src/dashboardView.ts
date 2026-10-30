import { App, ItemView, Menu, Modal, Notice, Platform, Scope, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { groupSomeday, nextWeekStart, relativeDay } from "./status";
import { classify, groupByContext, groupByDate } from "./buckets";
import { shiftISO, todayISO } from "./dates";
import { pickDate } from "./datePicker";
import { ProjectTask, ProjectTaskSource } from "./projectTasks";
import { noteTasksToItems } from "./noteTasks";
import type { ChecklistItem } from "./checklist";
import type { GoalProgress, GoalProject } from "./goals";
import { buildTimeline } from "./timeline";
import { DASH_BINDINGS, dashKey, DashKeyAction, isTyping } from "./keys";
import { KeysModal } from "./keysModal";
import { CaptureModal } from "./captureModal";
import { buildIndex, canComplete, childrenOf, progressOf, TaskIndex, validParentCandidates } from "./hierarchy";
import { openDependencies } from "./dependencies";
import { isSlotDone, slotProgress, slotTitle } from "./slots";
import { TaskSuggestModal } from "./taskSuggestModal";
import { DeleteTaskModal } from "./deleteTaskModal";
import type BrewinTasksPlugin from "./main";
import { eventsToItems, projectTasksToItems, tasksToItems } from "./calendarItem";
import { attachLongPressDrag, hapticTick } from "./dragHandle";
import { isSubmitKey, pressable, restoreFocus, saveFocus, showMenuFor } from "./a11y";
import { isTop, toggleTop, TOP_LIMIT } from "./planDay";
import { buildContextIndex, canonicaliseContext, ContextIndex, filterableContexts, hasContext } from "./contexts";
import { ConfirmModal } from "./confirmModal";
import { parseQuery, ParsedQuery, QUERY_HELP, search, searchTasks } from "./search";
import { stepAnchor, visibleRange } from "./calendar";
import { EventModal } from "./eventModal";
import { PROJECTS_CATEGORY } from "./settings";
import { PromptModal } from "./promptModal";
import { ProjectSuggestModal } from "./projectSuggestModal";
import { completionRefusal, isOpen } from "./status";
import { toWikilink } from "./task";
import { birthdayPage, birthdaysBetween, formatBirthDate, parseBirthDate, Person } from "./birthdays";
import { deadline, deadlineLabel, isStalled, nextSteps, plainText, PROJECT_STATUSES, ProjectStatus, STATUS_GLYPH, STATUS_LABEL } from "./projects";
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
import { BUILTIN_STATUSES, flagCounts, flagRefusal, flagText, StatusFlag } from "./statusFlags";
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
  /** Tasks whose checklist is open beneath their row (survives re-render)… */
  private checklistOpen = new Set<string>();
  /** …and those checklists' items, read before each full render draws them. */
  private checklists = new Map<string, ChecklistItem[]>();
  /** Checkbox tasks from the rest of the vault (noteTasks.ts), read with each full render. */
  private noteTaskList: ProjectTask[] = [];
  /**
   * Until when a click is the tail of a drop, so it doesn't also open the task (epoch ms). A time,
   * not a flag: on a touch screen a drag sends no click at all, and a flag left set ate the next tap.
   */
  private suppressClickUntil = 0;
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
    // Its own keys (keys.ts) while it is the active pane: exact modifiers, so Obsidian's hotkeys still
    // work, and a key not taken (returning undefined) goes on to whatever is being typed into.
    this.scope = new Scope(this.app.scope);
    for (const [mods, key] of DASH_BINDINGS) this.scope.register(mods, key, (e) => (this.onKey(e) ? false : undefined));
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
    // Checkbox tasks in other notes and open checklists are read here too, before anything is drawn,
    // so a redraw that has been overtaken stops before it touches the page.
    const wantsNotes = !this.project && (["today", "week", "attention", "all"] as DashView[]).includes(this.view);
    const [projects, notes, checklists] = await Promise.all([
      this.loadProjects(),
      wantsNotes ? this.plugin.noteTasks() : Promise.resolve([]),
      this.loadChecklists(),
    ]);
    if (seq !== this.renderSeq) return;
    this.projects = projects;
    this.noteTaskList = notes;
    this.checklists = checklists;
    // The project shown on its own was finished, archived or renamed: fall back to the view under it.
    if (this.project && !projects.some((p) => p.path === this.project)) this.project = null;

    const root = this.contentEl;
    // Keep your place in both columns: this redraws after every tick and every relevant vault change.
    const mainScroll = this.mainEl?.scrollTop ?? 0;
    const menuScroll = this.menuEl?.querySelector(".brewin-menu-scroll")?.scrollTop ?? 0;
    const active = root.doc.activeElement;
    const typing = active instanceof HTMLInputElement && active.classList.contains("brewin-search") && root.contains(active) ? active.selectionStart : null;
    // Where the keyboard was — this redraw follows every tick, and used to drop focus to the page.
    const focus = typing === null ? saveFocus(root) : null;

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

    this.menuEl = root.createDiv({ cls: "brewin-menu", attr: { id: this.menuId } });
    if (this.drawer) {
      this.menuEl.setAttr("role", "dialog");
      this.menuEl.setAttr("aria-label", "Planner menu");
    }
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
    } else restoreFocus(root, focus, this.burgerEl ?? this.menuEl?.querySelector<HTMLElement>(".brewin-menu-new"));
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

  /** ☰, when the menu is a drawer — where focus goes back to as it shuts. */
  private burgerEl: HTMLElement | null = null;
  /** Ties ☰ to the drawer it opens, for screen readers. */
  private readonly menuId = `brewin-menu-${Math.random().toString(36).slice(2, 8)}`;

  private setMenuOpen(open: boolean): void {
    const was = this.menuOpen && this.drawer;
    this.menuOpen = open;
    this.contentEl.toggleClass("is-menu-open", open && this.drawer);
    this.burgerEl?.setAttr("aria-expanded", String(open && this.drawer));
    if (!this.drawer || was === open) return;
    // Into the drawer as it opens; back to ☰ as it shuts, if the keyboard was in it.
    if (open) this.menuEl?.querySelector<HTMLElement>(".brewin-menu-top button")?.focus({ preventScroll: true });
    else if (this.menuEl?.contains(this.contentEl.doc.activeElement)) this.burgerEl?.focus({ preventScroll: true });
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
  private layout(): "list" | "board" | "timeline" {
    const l = BOARD_DEFAULT[this.view] ? this.plugin.settings.layouts[this.view] ?? "list" : "list";
    // A timeline is the Projects view's alone.
    return l === "timeline" && this.view !== "projects" ? "list" : l;
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
    if (action.kind === "none") return;
    if (action.kind === "refuse") return void new Notice(`${t} ${action.reason}.`);
    await this.plugin.act(async () => {
      switch (action.kind) {
        case "status": {
          if (action.status === "done") {
            const res = await store.complete(fresh);
            return res.ok ? `✓ ${t}` : `${t} can't be done yet — ${completionRefusal(res)}.`;
          }
          // Out of Done, its completed date goes in the same write. (Reading the task back between two
          // writes gave the old one, completed date and all, which the second write then kept.)
          if (fresh.status === "done" && action.status === "todo") await store.reopen(fresh);
          else await store.setStatus({ ...fresh, completed: null }, action.status);
          return `${t} → ${BUILTIN_STATUSES.find((s) => s.id === action.status)?.label ?? action.status}`;
        }
        case "flag": {
          const refused = await store.setFlag(fresh, action.flag);
          return refused ? `${t} ${refused}.` : `${t} → ${flagText(action.flag)}`;
        }
        case "priority":
          await store.setPriority(fresh, action.priority);
          return `${t} → ${action.priority} priority`;
        case "contexts":
          await store.updateFields(fresh, { contexts: action.contexts });
          return `${t} → ${action.contexts.length ? action.contexts.map((c) => `@${c}`).join(" ") : "no context"}`;
        case "project":
          await store.setProject(fresh, action.path);
          return `${t} → ${action.path ? this.projects.find((p) => p.path === action.path)?.name ?? "the project" : "no project"}`;
        case "attr": {
          const a = action.attr;
          const value = action.value === null ? null : a.kind === "bool" ? true : parseAttrInput(a, this.attrValueAsWritten(a, action.value));
          await store.setAttrs(fresh.path, { [a.key]: value });
          return `${t}: ${a.label} → ${value === null ? "none" : a.kind === "bool" ? "yes" : attrChip(a, value ?? "")?.replace(/^\S+\s/, "") ?? action.value}`;
        }
      }
    });
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
  /** Open on one view, out of any project or filter — a link from outside Obsidian (uri.ts). */
  showView(view: DashView): void {
    this.go({ view, project: null, context: null, flag: null, attr: null, query: "" });
  }

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

  /** The open checklists' items, read from their notes. */
  private async loadChecklists(): Promise<Map<string, ChecklistItem[]>> {
    const out = new Map<string, ChecklistItem[]>();
    for (const path of this.checklistOpen) {
      const task = this.plugin.store.getByPath(path);
      if (task) out.set(path, await this.plugin.store.checklist(task));
    }
    return out;
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
    this.burgerEl = null;
    if (this.drawer) {
      const burger = bar.createEl("button", { cls: "clickable-icon brewin-menu-btn" });
      setIcon(burger, "menu");
      // Something is overdue: say so on the button, since the menu with its red count is shut.
      burger.setAttr("aria-label", this.counts.attention ? `Menu — ${this.counts.attention} need attention` : "Menu");
      burger.setAttr("aria-controls", this.menuId);
      burger.setAttr("aria-expanded", String(this.menuOpen));
      burger.setAttr("data-focus", "burger");
      if (this.counts.attention) burger.createSpan({ cls: "brewin-menu-btn-dot" });
      burger.addEventListener("click", () => this.setMenuOpen(!this.menuOpen));
      this.burgerEl = burger;
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
      const grp = actions.createEl("select", { cls: "brewin-groupby dropdown", attr: { "aria-label": "Group the list by", "data-focus": "groupby" } });
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
      const options: (readonly ["list" | "board" | "timeline", string, string])[] = [
        ["list", "≡", "List"],
        ["board", "▦", "Board"],
      ];
      if (this.view === "projects") options.push(["timeline", "▬", "Timeline"]);
      options.forEach(([value, icon, name]) => {
        const b = lay.createEl("button", { text: Platform.isPhone ? icon : `${icon} ${name}`, cls: current === value ? "active" : "" });
        b.setAttr("aria-label", name);
        b.setAttr("aria-pressed", String(current === value));
        b.setAttr("data-focus", `layout:${value}`);
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
    const selBtn = actions.createEl("button", { cls: "brewin-select-toggle" + (this.selecting ? " mod-cta" : ""), attr: { "data-focus": "select" } });
    if ((this.view === "birthdays" || this.view === "goals") && !this.project) selBtn.addClass("brewin-hidden"); // there are no tasks to select
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
    searchEl.placeholder = this.project ? "Search this project… (? for filters)" : this.view === "birthdays" ? "Search people…" : "Search tasks… (? for filters)";
    searchEl.setAttr("aria-label", this.project ? "Search this project" : this.view === "birthdays" ? "Search people" : "Search tasks — type ? for filters");
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
            : id === "goals"
              ? this.plugin.goals().open.length
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
    const el = parent.createDiv({ cls: "brewin-menu-item", attr: { "data-focus": `menu:${o.drop ?? o.label}` } });
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
    const head = section.createDiv({ cls: "brewin-menu-section-head", attr: { "data-focus": `section:${id}` } });
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
        danger: true,
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
    if (action.kind === "refuse") return void new Notice(`${t} ${action.reason}.`);
    await this.plugin.act(async () => {
      switch (action.kind) {
        case "schedule":
          await store.moveToDay(fresh, action.iso);
          return `${t} → ${action.iso === today ? "today" : shortDate(action.iso)}`;
        case "inbox":
          await store.backToInbox(fresh);
          return `${t} is back in the inbox${fresh.due ? " — it keeps its due date" : ""}`;
        case "someday":
          await store.setStatus(fresh, "someday");
          return `${t} moved to Someday`;
        case "context":
          await store.bulkAddContext([fresh], action.value);
          return `Added @${action.value} to ${t}`;
        case "project":
          await store.setProject(fresh, action.path);
          return `${t} is now in ${this.projects.find((p) => p.path === action.path)?.name ?? "the project"}`;
        case "attr": {
          const a = action.attr;
          const value = a.kind === "bool" ? true : parseAttrInput(a, this.attrValueAsWritten(a, action.value));
          await store.setAttrs(fresh.path, { [a.key]: value });
          return `${t}: ${a.label} → ${a.kind === "bool" ? "yes" : attrChip(a, value ?? "")?.replace(/^\S+\s/, "") ?? action.value}`;
        }
        case "flag": {
          const refused = await store.setFlag(fresh, action.flag);
          return refused ? `${t} ${refused}.` : `${t} is now ${flagText(action.flag)}`;
        }
      }
    });
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
    // Search narrows whatever view is showing rather than replacing it — by what a task says, and by
    // what it is: `@home !high due:week -bins` (search.ts). "?" lists what the box understands.
    if (this.query.trim() === "?") {
      this.renderSearchHelp(root);
      return;
    }
    const query = parseQuery(this.query, this.plugin.settings.attributes.map((a) => a.key));
    if (this.query.trim()) tasks = searchTasks(tasks, query, { today, blocked: (t) => openDependencies(allTasks, t).length > 0 });
    if (query.unknown.length) {
      root.createDiv({ cls: "brewin-search-note", text: `Not understood: ${query.unknown.join(", ")} — type ? for what the search box knows.` });
    }
    // Checkbox tasks in other notes have no contexts, statuses or attributes: any such filter leaves them out.
    const notes = this.contextFilter || flag || attrF ? [] : this.narrowSteps(this.noteTaskList, query);

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
    if (this.view === "goals") {
      this.renderGoals(root, today);
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

    if (this.view === "today") { this.renderToday(root, tasks, today, notes); return this.renderBulkBar(); }
    if (this.view === "week") { this.renderWeek(root, tasks, today, notes); return this.renderBulkBar(); }
    if (this.view === "inbox") { this.renderInbox(root, tasks); return this.renderBulkBar(); }
    if (this.view === "attention") { this.renderAttention(root, tasks, today, notes); return this.renderBulkBar(); }
    if (this.view === "projects") { this.renderProjects(root, tasks, today); return this.renderBulkBar(); }
    if (this.view === "review") { await this.renderReview(root, today); return this.renderBulkBar(); }

    // ── Buckets (All) ──
    this.section(root, "🔴 Overdue", buckets.overdue, "brewin-overdue");
    if (buckets.carried.length) this.renderCarried(root, buckets.carried, today);
    this.section(root, "📌 Today", buckets.today, "brewin-today");

    if (buckets.upcoming.length) {
      const head = this.sectionHeader(root, "🗓 Upcoming", buckets.upcoming.length);
      const body = root.createDiv();
      this.foldHeading(head, body, true);
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

    // ── Checkbox tasks in other notes, by note ──
    if (notes.length) {
      this.sectionHeader(root, "🗒 In your notes", notes.length);
      const src = new ProjectTaskSource(this.app, this.plugin.settings);
      const byNote = new Map<string, ProjectTask[]>();
      for (const pt of notes) byNote.set(pt.projectPath, [...(byNote.get(pt.projectPath) ?? []), pt]);
      for (const list of [...byNote.values()].sort((a, b) => a[0].projectName.localeCompare(b[0].projectName))) {
        root.createEl("div", { cls: "brewin-date-label", text: list[0].projectName });
        list.forEach((pt) => this.projectRow(root, src, pt, today, false));
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
    if (anything.every((k) => !buckets[k].length) && !notes.length) {
      root.createDiv({ cls: "brewin-empty", text: "No tasks. Press ＋ to capture one." });
    }
    this.renderBulkBar();
  }

  // ── Board cards ────────────────────────────────────────────────────────────

  /** A draggable task card. Dropping it on another day column reschedules it. */
  private card(parent: HTMLElement, task: Task, dayISO: string): void {
    const el = parent.createDiv({ cls: "brewin-card" + (task.status === "hold" ? " is-hold" : "") });

    const top = el.createDiv({ cls: "brewin-card-top" });
    const cb = top.createEl("input", { type: "checkbox", attr: { "data-focus": `check:${task.path}` } });
    cb.checked = task.status === "done";
    cb.setAttr("aria-label", task.status === "done" ? `Reopen “${task.title}”` : `Complete “${task.title}”`);
    cb.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await this.plugin.act(async () => {
        if (task.status === "done") {
          await this.plugin.store.reopen(task);
          return `Reopened “${task.title}”`;
        }
        const res = await this.plugin.store.complete(task);
        return res.ok ? `✓ “${task.title}”` : `Can't complete “${task.title}” — ${completionRefusal(res)}.`;
      });
      this.render();
    });
    const pri = PRIORITY_ICON[task.priority];
    // The title is the card's control for a keyboard: Enter clicks it, and the card's click opens the task.
    const cardTitle = top.createSpan({ cls: "brewin-card-title", text: `${pri ? pri + " " : ""}${task.recurrence ? "🔁 " : ""}${task.title}` });
    pressable(cardTitle, { label: `Edit “${task.title}”` }).setAttr("data-focus", `title:${task.path}`);

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
      if (Date.now() < this.suppressClickUntil) {
        this.suppressClickUntil = 0;
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
    cb.setAttr("aria-label", `Tick “${plainText(pt.text) || "untitled step"}” in the project note`);
    cb.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation(); // the card's own click opens the step — not wanted on a tick
      await this.tickStep(src, pt);
    });
    const ptTitle = top.createSpan({ cls: "brewin-card-title", text: plainText(pt.text) || "(untitled task)" });
    pressable(ptTitle, { label: `Edit the step “${plainText(pt.text) || "untitled step"}”` });

    const meta = el.createDiv({ cls: "brewin-card-meta" });
    if (pt.scheduled) meta.createSpan({ text: `📅 ${pt.scheduled}` });
    if (pt.due) meta.createSpan({ cls: "brewin-meta-due", text: `🚩 ${pt.due}` });
    el.addEventListener("click", () => this.plugin.openStep(pt, () => this.render()));
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
        // On this pane's own document: in a pop-out window the main window's body is elsewhere.
        ghost = el.doc.body.createDiv({ cls: "brewin-drag-ghost" });
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
        if (isCard) this.suppressClickUntil = Date.now() + 400;
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
          await this.change(`“${task.title}” moved to ${shortDate(iso)}`, () => this.plugin.store.setScheduled(task, iso));
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
    const el = this.contentEl.doc.elementFromPoint(x, y) as HTMLElement | null;
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
    // Checkbox tasks in other notes, on their days.
    items.push(...noteTasksToItems(await this.plugin.noteTasks(), from, to));

    const days = reviewWeek(items, from, to);
    const total = reviewRowCount(days);

    // ── Navigation ──
    const nav = root.createDiv({ cls: "brewin-review-nav" });
    const seg = nav.createDiv({ cls: "brewin-view-seg" });
    (["week", "day"] as const).forEach((v) => {
      const b = seg.createEl("button", { text: v === "week" ? "Week" : "Day", cls: this.reviewView === v ? "active" : "" });
      b.setAttr("aria-pressed", String(this.reviewView === v));
      b.setAttr("data-focus", `review:${v}`);
      b.addEventListener("click", () => this.setReviewView(v));
    });
    const unit = this.reviewView === "day" ? "day" : "week";
    const prev = nav.createEl("button", { text: "‹", attr: { "aria-label": `Previous ${unit}`, "data-focus": "review:prev" } });
    prev.addEventListener("click", () => this.setReviewAnchor(stepAnchor(this.reviewView, this.reviewAnchorISO!, -1)));
    nav.createSpan({
      cls: "brewin-review-range",
      text: this.reviewView === "day" ? prettyDate(from) : `${prettyDate(from)} – ${prettyDate(to)}`,
    });
    const next = nav.createEl("button", { text: "›", attr: { "aria-label": `Next ${unit}`, "data-focus": "review:next" } });
    next.addEventListener("click", () => this.setReviewAnchor(stepAnchor(this.reviewView, this.reviewAnchorISO!, 1)));
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
    // Every open #next step is a next action to copy — all of them, as Life HQ lists them.
    const nextText = (p: MenuProject) => nextSteps(p.inline).map((s) => plainText(s.text)).join(" · ");
    const copyable = list.filter((p) => !!nextText(p));
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
      const next = nextText(p);
      if (next) {
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
      pressable(main.createSpan({ cls: "brewin-task-link brewin-review-proj-name", text: p.name })).addEventListener("click", () => this.go({ project: p.path }));
      const what = waiting
        ? [p.info.waitingOn ? `waiting on ${p.info.waitingOn}` : "waiting", next ? `then: ${next}` : ""].filter(Boolean).join(" · ")
        : next || "🚩 No next action";
      main.createSpan({ cls: "brewin-review-proj-next" + (!next && !waiting ? " is-unset" : ""), text: what });
      const d = deadline(p.info, today);
      if (d?.overdue) main.createSpan({ cls: "brewin-review-proj-due", text: `🏁 ${deadlineLabel(d)}` });
      if (!next) {
        const b = row.createEl("button", { cls: "brewin-chip-mini", text: "Choose…" });
        b.addEventListener("click", () => this.advanceNext(p, null));
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
        pressable(row.createSpan({ cls: "brewin-task-link", text: it.title })).addEventListener("click", () => {
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
      pressable(row.createSpan({ cls: "brewin-task-link", text: `${pri ? pri + " " : ""}${task.title}` })).addEventListener("click", () => {
        new CaptureModal(this.app, this.plugin.store, this.plugin.settings, () => this.render(), task).open();
      });
      const btn = row.createEl("button", { text: "📅 Schedule", cls: "brewin-chip brewin-chip-mini" });
      btn.addEventListener("click", () => void this.change(`“${task.title}” → ${shortDate(dayISO)}`, () => this.plugin.store.setScheduled(task, dayISO)));
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

    const title = pressable(el.createSpan({ cls: "brewin-review-title brewin-task-link", text: row.title }));
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
          if (r !== undefined) await this.change(r ? `“${task.title}” → ${shortDate(r)}` : `“${task.title}” has no date now`, () => this.plugin.store.setScheduled(task, r));
        });
        this.iconBtn(actions, "⏱️", this.plugin.timer.isRunning(task.path) ? "Focus timer (timing)" : "Focus timer", () => this.plugin.openFocus(task.path));
        this.iconBtn(actions, "⋯", `More for “${task.title}”`, (ev) => this.rowMenu(ev, task));
      }
    }
  }

  private openReviewItem(row: ReviewRow): void {
    if (row.kind === "project" || row.kind === "note") {
      void this.plugin.openStepAt(row.path, row.line ?? 0, () => this.render());
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

    // Each bulk change is one step Undo can take back, whole.
    const run = async (work: () => Promise<string>) => {
      await this.plugin.act(work);
      this.selected.clear();
      this.render();
    };

    act("📅 Schedule…", async () => {
      const picked = await pickDate(this.app, todayISO(), this.plugin.settings.firstDayOfWeek, {
        selectedLabel: "Scheduled",
      });
      if (picked === undefined) return; // dismissed
      const tasks = this.selectedTasks();
      await run(async () => {
        const changed = await this.plugin.store.bulkSchedule(tasks, picked);
        return picked ? `Scheduled ${changed} task${changed === 1 ? "" : "s"} for ${picked}` : `Cleared the date on ${changed}`;
      });
    });

    act("＠ Context…", () => {
      const idx = buildContextIndex(
        this.plugin.store.getTasks().flatMap((t) => t.contexts),
        this.plugin.settings.contexts
      );
      new ContextPromptModal(this.app, idx, async (value) => {
        if (!value) return;
        await run(async () => {
          const changed = await this.plugin.store.bulkAddContext(this.selectedTasks(), value);
          return `Added @${value} to ${changed} task${changed === 1 ? "" : "s"}`;
        });
      }).open();
    });

    act("⏱ Estimate…", () => {
      new EstimatePromptModal(this.app, async (minutes) => {
        await run(async () => {
          const changed = await this.plugin.store.bulkSetEstimate(this.selectedTasks(), minutes);
          return minutes ? `Set ${formatEstimate(minutes)} on ${changed}` : `Cleared the estimate on ${changed}`;
        });
      }).open();
    });

    act("🔴 Priority", () =>
      run(async () => {
        const changed = await this.plugin.store.bulkSetPriority(this.selectedTasks(), "high");
        return `${changed} task${changed === 1 ? "" : "s"} set to high`;
      })
    );

    act("⏸ Hold", () =>
      run(async () => {
        const changed = await this.plugin.store.bulkSetStatus(this.selectedTasks(), "hold");
        return `${changed} task${changed === 1 ? "" : "s"} put on hold`;
      })
    );

    act("💭 Someday", () =>
      run(async () => {
        // Recurring tasks keep their schedule; a wishlist is for one-offs.
        const changed = await this.plugin.store.bulkSetStatus(this.selectedTasks().filter((x) => !x.recurrence), "someday");
        return `${changed} task${changed === 1 ? "" : "s"} moved to Someday`;
      })
    );

    act("✓ Complete", () =>
      run(async () => {
        const { done, blocked } = await this.plugin.store.bulkComplete(this.selectedTasks());
        return blocked.length
          ? `Completed ${done}. ${blocked.length} blocked (open subtasks or unfinished dependencies): ${blocked.map((b) => b.title).join(", ")}`
          : `Completed ${done} task${done === 1 ? "" : "s"}`;
      })
    );

    act(
      "🗑 Delete",
      () => {
        const tasks = this.selectedTasks();
        new ConfirmModal(this.app, {
          title: `Delete ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
          danger: true,
          body:
            `They'll go to your vault's trash (recoverable via Obsidian's "Deleted files" setting). ` +
            `Any subtasks are kept and un-parented rather than deleted with them.`,
          cta: "Delete",
          onConfirm: () =>
            void run(async () => {
              const removed = await this.plugin.store.bulkDelete(tasks);
              return `Deleted ${removed} note${removed === 1 ? "" : "s"}`;
            }),
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
      await this.plugin.act(async () => {
        const n = await this.plugin.store.bulkReschedule(tasks, today);
        return `Moved ${n} task${n === 1 ? "" : "s"} to today`;
      });
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
    this.foldHeading(head, body, !this.folded.has(key), (open) => {
      if (open) this.folded.delete(key);
      else this.folded.add(key);
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
        const name = pressable(main.createSpan({ cls: "brewin-task-link", text: r.person.name }));
        name.addEventListener("click", () => this.openNote(r.person.path));
        const when = r.inDays === 0 ? "today 🎉" : r.inDays === 1 ? "tomorrow" : r.inDays <= 31 ? `in ${r.inDays} days` : "";
        const meta = [r.age != null ? `turns ${r.age}` : "", when].filter(Boolean).join(" · ");
        if (meta) main.createSpan({ cls: "brewin-bday-meta", text: meta });
        this.iconBtn(row, "✏️", `Change ${r.person.name}'s birthday`, () => this.promptBirthday(r.person));
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
        const name = pressable(main.createSpan({ cls: "brewin-task-link", text: p.name }));
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
  private renderToday(root: HTMLElement, tasks: Task[], today: string, notes: ProjectTask[]): void {
    const events = this.plugin.settings.showEventsOnCalendar
      ? [...eventsToItems(this.plugin.events.getEvents(), today, today), ...this.plugin.ics.items(today, today)]
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
      // One step for Undo: every task it placed goes back where it was.
      await this.plugin.act(async () => this.plugin.autoScheduleMessage(await this.plugin.autoScheduleToday()));
      this.render();
    });
    head.createEl("button", { text: "☀️ Plan my day", cls: "brewin-chip-mini", attr: { "data-focus": "plan-day" } }).addEventListener("click", () => this.plugin.planDay());
    head.createEl("button", { text: "🌙 Shut down", cls: "brewin-chip-mini", attr: { "data-focus": "shut-down" } }).addEventListener("click", () => this.plugin.shutDown());

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
        // A rest day from the Fitness plan has no note behind it to open; another calendar's event, its details.
        const external = this.plugin.ics.item(e.path);
        if (external) pressable(chip, { label: `${e.title}, from ${external.category} — see the details` }).addEventListener("click", () => this.plugin.openExternal(external));
        else if (!isTraining) pressable(chip).addEventListener("click", () => this.openNote(e.path));
      });
    }

    // ⭐ The day's top three head the list (Plan my day, or ⋯ → Top 3); they aren't repeated below,
    // except on the clock, which stays a complete timeline.
    const top = tasks.filter((t) => isTop(t, today));
    const topOpen = new Set(top.filter((t) => t.status !== "done").map((t) => t.path));
    if (top.length) {
      this.sectionHeader(root, "⭐ Top 3", topOpen.size);
      const band = root.createDiv({ cls: "brewin-top" });
      for (const t of top) this.taskRow(band, t, t.status === "done");
    }
    const notTop = (list: Task[]) => list.filter((t) => !topOpen.has(t.path));
    const overdue = notTop(a.overdue);
    const carriedOver = notTop(a.carried);
    const anytime = notTop(a.anytime);

    if (overdue.length) {
      this.sectionHeader(root, "🔴 Overdue", overdue.length);
      const band = root.createDiv({ cls: "brewin-overdue" });
      overdue.forEach((t) => this.taskRow(band, t));
    }

    if (carriedOver.length) this.renderCarried(root, carriedOver, today);

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
          // Named by what it is, then what a press does — not the same words on every row.
          line.setAttr("aria-label", `${row.time} ${row.title} — ${row.done ? "open the session" : "start the session"}`);
          if (item) pressable(line).addEventListener("click", () => void this.plugin.openTraining(item));
          continue;
        }
        if (row.kind === "event") {
          // Context only — an event isn't yours to tick from the task dashboard.
          const line = body.createDiv({ cls: "brewin-agenda-row is-event" });
          line.createSpan({ cls: "brewin-agenda-time", text: row.time });
          line.createSpan({ cls: "brewin-agenda-title", text: row.title });
          if (row.location) line.createSpan({ cls: "brewin-agenda-location", text: `📍 ${row.location}` });
          // Another calendar's event opens its details; the Planner's own, its note.
          const external = this.plugin.ics.item(row.path);
          line.setAttr("aria-label", `${row.time} ${row.title}${row.location ? `, ${row.location}` : ""} — ${external ? `from ${external.category}, see the details` : "open the event's note"}`);
          pressable(line).addEventListener("click", () => (external ? this.plugin.openExternal(external) : this.openNote(row.path)));
          continue;
        }
        if (row.kind === "slot" && row.task) {
          const line = body.createDiv({ cls: "brewin-agenda-row" + (row.done ? " done" : "") });
          line.createSpan({ cls: "brewin-agenda-time", text: row.time });
          const box = line.createEl("input", { type: "checkbox", attr: { "data-focus": `slot:${row.path}:${row.slotTime}` } });
          box.checked = row.done;
          box.setAttr("aria-label", `${row.title} at ${row.time} — ${row.done ? "untick" : "tick"}`);
          box.addEventListener("click", async (e) => {
            e.preventDefault();
            await this.plugin.act(async () => {
              const res = await this.plugin.store.toggleSlot(row.task!, row.slotTime!, today);
              return res.ok ? `${row.title} at ${row.time} ${row.done ? "unticked" : "ticked"}` : `Can't complete “${row.task!.title}” — ${completionRefusal(res)}.`;
            });
            this.render();
          });
          line.createSpan({ cls: "brewin-agenda-title", text: row.title });
          continue;
        }
        if (row.task) this.taskRow(body, row.task);
      }
    }

    if (anytime.length) {
      this.sectionHeader(root, "📋 Anytime", anytime.length);
      const body = root.createDiv();
      anytime.forEach((t) => this.taskRow(body, t));
    }

    // Checkbox tasks in other notes planned or due by today — a to-do in a day note, a dated line elsewhere.
    const noteDue = notes.filter((pt) => (pt.scheduled !== null && pt.scheduled <= today) || (pt.due !== null && pt.due <= today));
    if (noteDue.length) this.noteSection(root, "🗒 In your notes", noteDue, today);

    if (!a.overdue.length && !a.timed.length && !a.anytime.length && !a.carried.length && !top.length && !noteDue.length) {
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
    head.addClass("brewin-done-head");
    const chevron = head.createSpan({ cls: "brewin-fold-chevron", text: s.todayDoneOpen ? "▾" : "▸" });
    chevron.setAttr("aria-hidden", "true");
    head.prepend(chevron);
    const body = root.createDiv({ cls: "brewin-done-today" });
    this.foldHeading(head, body, s.todayDoneOpen, (open) => {
      s.todayDoneOpen = open;
      chevron.setText(open ? "▾" : "▸");
      void this.plugin.saveSettings();
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
      const link = pressable(title.createSpan({ cls: "brewin-task-link", text: r.task.title }));
      link.addEventListener("click", () => this.editTask(r.task));
      const next = r.task.scheduled && r.task.scheduled > today ? ` · next ${relativeDay(r.task.scheduled, today)}` : "";
      main.createDiv({ cls: "brewin-task-meta", text: `done today${next}` });
    }
  }

  /** Week: the next 7 days, one group per day, empty days kept as visible breathing room. */
  private renderWeek(root: HTMLElement, tasks: Task[], today: string, notes: ProjectTask[]): void {
    const days = weekAgenda(tasks, today, 7);
    // Checkbox tasks in other notes, on their do-date (else their deadline).
    const src = new ProjectTaskSource(this.app, this.plugin.settings);
    const notesOn = (iso: string) => notes.filter((pt) => (pt.scheduled ?? pt.due) === iso);
    const total = days.reduce((n, d) => n + d.tasks.length + notesOn(d.date).length, 0);

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
        const dayNotes = notesOn(day.date);
        const n = day.tasks.length + dayNotes.length;
        if (n) head.createSpan({ cls: "brewin-count", text: String(n) });
        const body = col.createDiv({ cls: "brewin-board-body" });
        if (!n) body.createDiv({ cls: "brewin-board-empty", text: "—" });
        day.tasks.forEach((t) => this.card(body, t, day.date));
        dayNotes.forEach((pt) => this.projectRow(body, src, pt, today));
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
      const dayNotes = notesOn(day.date);
      const n = day.tasks.length + dayNotes.length;
      if (n) label.createSpan({ cls: "brewin-count", text: String(n) });
      if (!n) {
        root.createDiv({ cls: "brewin-day-clear", text: "clear" });
        continue;
      }
      day.tasks.forEach((t) => this.taskRow(root, t));
      dayNotes.forEach((pt) => this.projectRow(root, src, pt, today));
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
  private renderAttention(root: HTMLElement, tasks: Task[], today: string, notes: ProjectTask[]): void {
    const g = attentionTasks(tasks, today);
    const notesPast = notes.filter((pt) => (pt.scheduled !== null && pt.scheduled < today) || (pt.due !== null && pt.due < today));
    if (!g.overdue.length && !g.slipped.length && !g.onhold.length && !notesPast.length) {
      root.createDiv({ cls: "brewin-empty", text: "Nothing overdue, slipped or parked." });
      return;
    }
    if (g.overdue.length) {
      const head = this.sectionHeader(root, "🔴 Overdue — past its due date", g.overdue.length);
      const pushBtn = head.createEl("button", { text: "Push all to today", cls: "brewin-chip-mini" });
      pushBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.plugin.act(async () => {
          const n = await this.plugin.store.bulkReschedule(g.overdue, today);
          return `Rescheduled ${n} task${n === 1 ? "" : "s"} to today`;
        });
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
        await this.plugin.act(async () => {
          const n = await this.plugin.store.bulkReschedule(g.slipped, today);
          return `Moved ${n} task${n === 1 ? "" : "s"} to today`;
        });
        this.render();
      });
      g.slipped.forEach((t) => this.taskRow(root, t, false, false, { triage: true }));
    }
    if (g.onhold.length) {
      this.sectionHeader(root, "⏸ On hold", g.onhold.length);
      g.onhold.forEach((t) => this.taskRow(root, t));
    }
    if (notesPast.length) this.noteSection(root, "🗒 In your notes — past their date", notesPast, today);
  }

  /**
   * Checkbox lines (project steps, tasks in other notes) under a search: they have words but no
   * contexts, statuses or attributes, so a query with any filter leaves them out.
   */
  private narrowSteps(list: ProjectTask[], q: ParsedQuery): ProjectTask[] {
    if (!this.query.trim()) return list;
    if (q.filters.length) return [];
    const kept = list.filter((pt) => {
      const words = plainText(pt.text).toLowerCase();
      return q.phrases.every((p) => words.includes(p)) && !q.exclude.some((w) => words.includes(w));
    });
    return q.text.trim() ? search(kept.map((pt) => ({ pt, title: plainText(pt.text), contexts: [] as string[] })), q.text).map((h) => h.pt) : kept;
  }

  /** What the search box understands, for "?". */
  private renderSearchHelp(root: HTMLElement): void {
    const box = root.createDiv({ cls: "brewin-search-help" });
    box.createEl("h4", { text: "The search box understands" });
    const list = box.createEl("dl");
    for (const [what, means] of QUERY_HELP) {
      list.createEl("dt").createEl("code", { text: what });
      list.createEl("dd", { text: means });
    }
    box.createEl("p", { cls: "setting-item-description", text: "Mix them with words: @home due:week bins. A saved filter keeps them too." });
  }

  /** Checkbox tasks from other notes, earliest first, each saying which note it is in. */
  private noteSection(root: HTMLElement, title: string, list: ProjectTask[], today: string): void {
    this.sectionHeader(root, title, list.length);
    const src = new ProjectTaskSource(this.app, this.plugin.settings);
    const day = (pt: ProjectTask) => [pt.scheduled, pt.due].filter((d): d is string => !!d).sort()[0] ?? "";
    const body = root.createDiv();
    [...list].sort((a, b) => day(a).localeCompare(day(b)) || a.text.localeCompare(b.text)).forEach((pt) => this.projectRow(body, src, pt, today));
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

    if (groups.length && this.layout() === "timeline") {
      this.renderTimeline(root, tasks, today);
      return;
    }
    if (groups.length && this.layout() === "board") {
      const board = root.createDiv({ cls: "brewin-board" });
      for (const { p, notes } of groups) {
        const col = board.createDiv({ cls: "brewin-board-col" });
        const head = col.createDiv({ cls: "brewin-board-head" });
        const link = pressable(head.createSpan({ cls: "brewin-task-link", text: p.name }));
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
        const link = pressable(label.createSpan({ cls: "brewin-task-link", text: p.name }));
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
        const link = pressable(row.createSpan({ cls: "brewin-task-link", text: p.name }));
        link.addEventListener("click", () => this.go({ project: p.path }));
        const next = nextSteps(p.inline)[0];
        const then = next ? plainText(next.text) : "";
        const meta =
          p.info.status === "waiting"
            ? [p.info.waitingOn ? `waiting on ${p.info.waitingOn}` : "waiting", then ? `then: ${then}` : ""]
            : [p.info.status === null ? "no status" : "", then];
        const text = meta.filter(Boolean).join(" · ");
        if (text) row.createSpan({ cls: "brewin-proj-row-meta", text });
      }
    };
    parkedList("proj-waiting", "⏳ Waiting", waiting);
    parkedList("proj-someday", "💭 Someday", parked);
  }

  /**
   * Under a project's name: its next action — its first open `#next` step (tap to edit it, ✓ when
   * it's done) — or, when it has none, what to do about that; and its deadline, when it has one.
   */
  private projectBrief(parent: HTMLElement, p: MenuProject, today: string, showDue = true): void {
    const box = parent.createDiv({ cls: "brewin-proj-brief" });
    const next = box.createDiv({ cls: "brewin-proj-next" });
    const steps = nextSteps(p.inline);
    if (steps.length) {
      const first = steps[0];
      next.createSpan({ cls: "brewin-proj-next-label", text: "Next" });
      const text = next.createSpan({ cls: "brewin-proj-next-text", text: plainText(first.text) });
      pressable(text, { label: `Next action: ${plainText(first.text)} — edit it` });
      text.addEventListener("click", () => this.plugin.openStep(first, () => this.render()));
      if (steps.length > 1) {
        next.createSpan({ cls: "brewin-count", text: `+${steps.length - 1}`, attr: { title: steps.slice(1).map((s) => plainText(s.text)).join("\n") } });
      }
      const done = next.createEl("button", { cls: "brewin-chip-mini", text: "✓ Done" });
      done.setAttr("aria-label", "The next action is done — choose the one after it");
      done.addEventListener("click", () => this.advanceNext(p, first));
    } else {
      const stalled = isStalled(p.info, p.inline);
      next.addClass(stalled ? "is-stalled" : "is-unset");
      box.toggleClass("is-stalled", stalled);
      next.createSpan({ cls: "brewin-proj-next-text", text: stalled ? "🚩 No next action" : "No next action" });
      next.createEl("button", { cls: "brewin-chip-mini", text: "Choose…" }).addEventListener("click", () => this.advanceNext(p, null));
    }
    const d = showDue ? deadline(p.info, today) : null;
    if (d) {
      const due = box.createDiv({ cls: "brewin-proj-due" + (d.overdue ? " is-overdue" : "") });
      due.setText(`🏁 ${shortDate(d.iso)} · ${deadlineLabel(d)}`);
      pressable(due, { label: `Deadline ${shortDate(d.iso)}, ${deadlineLabel(d)} — change it` });
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
    // The goal it serves (`goal:`) — tap for the Goals view.
    const goal = this.plugin.goalOf(p.path);
    if (goal) {
      const chip = chips.createEl("button", { cls: "brewin-proj-status brewin-proj-goal", text: `🎯 ${goal.basename}` });
      chip.setAttr("aria-label", `Serves the goal ${goal.basename} — show the goals`);
      chip.addEventListener("click", () => this.go({ view: "goals", project: null }));
    }
    if (st === "waiting") {
      const w = pressable(head.createDiv({ cls: "brewin-proj-waiting", text: p.info.waitingOn ? `⏳ Waiting on ${p.info.waitingOn}` : "⏳ Waiting — on what?" }));
      w.addEventListener("click", () => this.changeStatus(p, "waiting"));
    }
    // The deadline is a chip above, so the brief below carries only the next action.
    this.projectBrief(head, p, today, false);
  }

  /** 🎯 Goals: each goal being worked towards, with its projects and how far along they are; then the rest. */
  private renderGoals(root: HTMLElement, today: string): void {
    const o = this.plugin.goals();
    if (!o.open.length && !o.other.length) {
      root.createDiv({ cls: "brewin-empty", text: `No goal notes in ${this.plugin.settings.goalsFolder} — notes tagged #goal, with a target_date. Projects join one with goal: [[…]].` });
    }
    for (const g of o.open) this.goalCard(root, g, today);
    if (o.unlinked.length) {
      this.sectionHeader(root, "⚡ Projects serving no goal", o.unlinked.length);
      const body = root.createDiv({ cls: "brewin-goal-unlinked" });
      for (const p of o.unlinked) this.goalProjectRow(body, p, today);
    }
    if (o.other.length) {
      this.sectionHeader(root, "💤 Parked or finished", o.other.length);
      const body = root.createDiv();
      for (const g of o.other) this.goalCard(body, g, today, true);
    }
  }

  private goalCard(parent: HTMLElement, g: GoalProgress, today: string, quiet = false): void {
    const card = parent.createDiv({ cls: "brewin-goal" + (quiet ? " is-quiet" : "") });
    const head = card.createDiv({ cls: "brewin-goal-head" });
    const name = pressable(head.createSpan({ cls: "brewin-goal-name brewin-task-link", text: `🎯 ${g.goal.name}` }), { label: `${g.goal.name} — open the goal's note` });
    name.addEventListener("click", () => this.openNote(g.goal.path));
    if (g.daysLeft !== null && !quiet) {
      const left = g.daysLeft < 0 ? `${-g.daysLeft} days past` : g.daysLeft === 0 ? "due today" : `${g.daysLeft} days left`;
      head.createSpan({ cls: "brewin-goal-left" + (g.daysLeft < 0 ? " is-overdue" : ""), text: left, attr: { title: g.goal.targetDate ?? "" } });
    }
    const meta = [g.goal.area, g.goal.period, quiet ? g.goal.status || "no status" : ""].filter(Boolean).join(" · ");
    if (meta) card.createDiv({ cls: "brewin-goal-meta", text: meta });
    if (g.total) {
      const pct = Math.round((g.done / g.total) * 100);
      const bar = card.createDiv({ cls: "brewin-goal-bar", attr: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": `${g.done} of ${g.total} steps and tasks done` } });
      bar.createDiv({ cls: "brewin-goal-fill" }).style.width = `${pct}%`;
    }
    if (quiet) return;
    if (!g.projects.length) card.createDiv({ cls: "brewin-goal-empty", text: "No project serves it yet — give one goal: [[…]] in its properties." });
    for (const p of g.projects) this.goalProjectRow(card, p, today);
  }

  /** A project under its goal: status, how much is done, its deadline and its next action. */
  private goalProjectRow(parent: HTMLElement, p: GoalProject, today: string): void {
    const row = parent.createDiv({ cls: "brewin-goal-project" });
    const name = pressable(row.createSpan({ cls: "brewin-task-link", text: p.name }), { label: `${p.name} — show the project` });
    name.addEventListener("click", () => this.go({ project: p.path }));
    const meta = row.createDiv({ cls: "brewin-task-meta" });
    const st = (PROJECT_STATUSES as string[]).includes(p.status ?? "") ? (p.status as ProjectStatus) : null;
    if (st) meta.createSpan({ text: `${STATUS_GLYPH[st]} ${STATUS_LABEL[st]}` });
    if (p.total) meta.createSpan({ text: `${p.done}/${p.total} done` });
    if (p.due) meta.createSpan({ cls: p.due < today ? "brewin-meta-overdue" : "brewin-meta-due", text: `🏁 ${shortDate(p.due)}`, attr: { title: p.due } });
    const next = nextSteps(this.projects.find((x) => x.path === p.path)?.inline ?? [])[0];
    if (next) row.createDiv({ cls: "brewin-goal-next", text: `→ ${plainText(next.text)}` });
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
    showMenuFor(m, ev);
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
        onSubmit: (value) => void this.change(`${p.name}: waiting${value ? ` on ${value}` : ""}`, () => store.setStatus(p.info, "waiting", value)),
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
          if (this.project === p.path) {
            this.project = null;
            this.view = "projects";
          }
          await this.change(`✓ ${p.name} is done`, () => store.setStatus(p.info, "done"));
        },
      }).open();
      return;
    }
    void this.change(`${p.name}: ${STATUS_LABEL[status]}`, () => store.setStatus(p.info, status));
  }

  /** Finish the `#next` step `done` and choose the one after it — or, with `done` null, just choose one. */
  private advanceNext(p: MenuProject, done: ProjectTask | null): void {
    const steps = [...p.inline].sort((a, b) => a.line - b.line); // offered in the note's own order
    new NextActionModal(this.app, {
      project: p.info,
      steps,
      done,
      onSubmit: (c) => {
        const chosen = c.add || (c.promote ? c.promote.text : "");
        const label = chosen ? `${p.name} — next: ${plainText(chosen)}` : done ? `✓ ${plainText(done.text)}` : `${p.name}: no next action yet`;
        void this.change(label, () => this.plugin.projects.advance(p.info, { done, ...c }));
      },
    }).open();
  }

  private async setProjectDue(p: MenuProject): Promise<void> {
    const r = await pickDate(this.app, p.info.due, this.plugin.settings.firstDayOfWeek, { selectedLabel: "Deadline" });
    if (r === undefined || r === p.info.due) return;
    await this.change(r ? `${p.name}: deadline ${shortDate(r)}` : `${p.name}: deadline cleared`, () => this.plugin.projects.setDue(p.info, r));
  }

  /** A project's open task notes, soonest first. */
  /** Projects as a timeline: bars from start to deadline, dated work as marks, a line for today. */
  private renderTimeline(root: HTMLElement, tasks: Task[], today: string): void {
    const live = this.projects.filter((p) => p.info.status === "active" || p.info.status === "waiting");
    const tl = buildTimeline(
      live.map((p) => ({
        path: p.path,
        name: p.name,
        status: p.info.status,
        started: p.info.started,
        due: p.info.due,
        items: [
          ...p.inline.filter((s) => s.scheduled || s.due).map((s) => ({ key: `step:${s.line}`, label: plainText(s.text) || "(untitled step)", date: (s.scheduled ?? s.due)!, kind: "step" as const })),
          ...this.projectNotes(tasks, p.path)
            .filter((t) => t.scheduled || t.due)
            .map((t) => ({ key: `task:${t.path}`, label: t.title, date: (t.scheduled ?? t.due)!, end: t.endDate, kind: "task" as const })),
        ],
      })),
      today
    );
    const dayPx = Platform.isPhone ? 5 : 8;
    const wrap = root.createDiv({ cls: "brewin-tl" });
    const grid = wrap.createDiv({ cls: "brewin-tl-grid" });
    grid.style.setProperty("--tl-width", `${tl.days * dayPx}px`);
    const head = grid.createDiv({ cls: "brewin-tl-row brewin-tl-head" });
    // The range can run past a year, so it is said with years: "Apr 2026 – Jul 2027".
    const monthYear = (iso: string) => `${new Date(`${iso}T00:00:00Z`).toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${iso.slice(0, 4)}`;
    head.createDiv({ cls: "brewin-tl-name", text: `${monthYear(tl.from)} – ${monthYear(tl.to)}` });
    const scale = head.createDiv({ cls: "brewin-tl-track" });
    for (const m of tl.months) scale.createDiv({ cls: "brewin-tl-month", text: m.label }).style.left = `${m.at * dayPx}px`;
    for (const row of tl.rows) {
      const r = grid.createDiv({ cls: "brewin-tl-row" });
      const name = pressable(r.createDiv({ cls: "brewin-tl-name brewin-task-link", text: row.name }), { label: `${row.name} — show the project` });
      name.addEventListener("click", () => this.go({ project: row.path }));
      const track = r.createDiv({ cls: "brewin-tl-track" });
      track.createDiv({ cls: "brewin-tl-today" }).style.left = `${tl.today * dayPx + dayPx / 2}px`;
      if (row.bar) {
        const b = track.createDiv({
          cls: `brewin-tl-bar is-${row.status ?? "none"}` + (row.bar.openStart ? " open-start" : "") + (row.bar.openEnd ? " open-end" : "") + (row.bar.overdue ? " is-overdue" : ""),
        });
        b.style.left = `${row.bar.from * dayPx}px`;
        b.style.width = `${(row.bar.to - row.bar.from + 1) * dayPx}px`;
        const p = live.find((x) => x.path === row.path)!;
        b.setAttr("title", `${p.info.started ? `Started ${shortDate(p.info.started)}` : "No start date"} · ${p.info.due ? `deadline ${shortDate(p.info.due)}` : "no deadline"}`);
      }
      for (const m of row.marks) {
        const el = pressable(track.createDiv({ cls: `brewin-tl-mark is-${m.kind}` + (m.to > m.at ? " is-span" : "") + (m.overdue ? " is-overdue" : "") }), {
          label: `${m.label}, ${shortDate(m.date)}${m.overdue ? ", overdue" : ""}`,
        });
        el.style.left = `${m.at * dayPx + (m.to > m.at ? 0 : dayPx / 2)}px`;
        if (m.to > m.at) el.style.width = `${(m.to - m.at + 1) * dayPx}px`;
        el.setAttr("title", `${m.label} · ${shortDate(m.date)}`);
        el.addEventListener("click", () => {
          if (m.key.startsWith("step:")) void this.plugin.openStepAt(row.path, Number(m.key.slice(5)), () => this.render());
          else {
            const t = this.plugin.store.getByPath(m.key.slice(5));
            if (t) this.editTask(t);
          }
        });
      }
    }
    if (!tl.rows.length) root.createDiv({ cls: "brewin-empty", text: "No active or waiting projects." });
    // Opened on today, with a little of what came before.
    window.requestAnimationFrame(() => (wrap.scrollLeft = Math.max(0, tl.today * dayPx - wrap.clientWidth / 3)));
  }

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
    const lines = this.contextFilter ? [] : this.narrowSteps(p.inline, parseQuery(this.query, this.plugin.settings.attributes.map((a) => a.key)));

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
    h.createSpan({ cls: "brewin-section-title", text: title });
    h.createSpan({ cls: "brewin-count", text: String(count) });
    return h;
  }

  /**
   * A heading that folds the list under it: tap anywhere on it, or reach its name with the keyboard
   * (the name is the control, so a button inside the heading — "All to today" — stays its own).
   */
  private foldHeading(head: HTMLElement, body: HTMLElement, open: boolean, onToggle?: (open: boolean) => void): void {
    const name = head.querySelector<HTMLElement>(".brewin-section-title") ?? head;
    pressable(name, { expanded: open });
    name.setAttr("data-focus", `fold:${name.textContent ?? ""}`);
    body.toggleClass("brewin-collapsed", !open);
    head.addClass("is-foldable");
    head.addEventListener("click", () => {
      const nowOpen = body.hasClass("brewin-collapsed");
      body.toggleClass("brewin-collapsed", !nowOpen);
      name.setAttr("aria-expanded", String(nowOpen));
      onToggle?.(nowOpen);
    });
  }

  private section(root: HTMLElement, title: string, items: Task[], cls = ""): void {
    if (!items.length) return;
    const head = this.sectionHeader(root, title, items.length);
    if (cls) head.addClass(cls); // classList.add("") throws — never pass an empty class
    const body = root.createDiv();
    this.foldHeading(head, body, true);
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

    const cb = row.createEl("input", { type: "checkbox", attr: { "data-focus": `check:${task.path}` } });
    cb.checked = isDone || task.status === "done";
    cb.setAttr(
      "aria-label",
      cb.checked ? `Reopen “${task.title}”` : sp?.next && !sp.dayComplete ? `Tick ${slotTitle(sp.next)} of “${task.title}”` : `Complete “${task.title}”`
    );
    if (blocked || openDeps.length) cb.addClass("brewin-locked");
    cb.addEventListener("click", async (e) => {
      e.preventDefault();
      await this.plugin.act(async () => {
        if (task.status === "done") {
          await this.plugin.store.reopen(task);
          return `Reopened “${task.title}”`;
        }
        // For a slot task the checkbox ticks the NEXT open slot rather than the whole task.
        const res = await this.plugin.store.complete(task);
        // Hard block: open subtasks and/or unfinished dependencies both refuse completion.
        if (!res.ok) return `Can't complete “${task.title}” — ${completionRefusal(res)}.`;
        if (sp?.next) {
          // Counted from before the tick — the note itself may not have been re-read yet.
          const done = sp.done + 1;
          return done >= sp.total ? `“${task.title}” done for the day` : `${slotTitle(sp.next)} ticked — ${done}/${sp.total} today`;
        }
        return task.recurrence ? `✓ “${task.title}” — back on its next date` : `✓ “${task.title}”`;
      });
      this.render();
    });

    const main = row.createDiv({ cls: "brewin-task-main" });
    const titleLine = main.createDiv({ cls: "brewin-task-title" });

    // Expander for parents
    if (kids.length) {
      const open = this.expanded.has(task.path);
      const exp = titleLine.createSpan({ cls: "brewin-expander", text: open ? "▾" : "▸" });
      pressable(exp, { label: `${open ? "Hide" : "Show"} the subtasks of “${task.title}”`, expanded: open }).setAttr("data-focus", `expand:${task.path}`);
      exp.addEventListener("click", (e) => {
        e.stopPropagation();
        open ? this.expanded.delete(task.path) : this.expanded.add(task.path);
        this.render();
      });
    }

    const pri = PRIORITY_ICON[task.priority];
    if (pri) titleLine.createSpan({ text: pri + " " });
    if (task.recurrence) titleLine.createSpan({ cls: "brewin-recur", text: "🔁 " });
    // Its name is the title — every row used to be announced as "Edit task".
    const link = pressable(titleLine.createSpan({ cls: "brewin-task-link", text: task.title }));
    link.setAttr("aria-haspopup", "dialog");
    link.setAttr("data-focus", `title:${task.path}`);
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
      pressable(chip, { expanded: open });
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        open ? this.expanded.delete(task.path) : this.expanded.add(task.path);
        this.render();
      });
    }

    const meta = main.createDiv({ cls: "brewin-task-meta" });
    if (isTop(task, today) && task.status !== "done") meta.createSpan({ cls: "brewin-meta-top", text: "⭐", attr: { "aria-label": "One of today's top three", title: "One of today's top three" } });
    // The checklist in its note — tap to tick its items here, beneath the row.
    const cl = task.checklist;
    if (cl) {
      const open = this.checklistOpen.has(task.path);
      const chip = pressable(meta.createSpan({ cls: "brewin-meta-check" + (cl.done === cl.total ? " is-done" : ""), text: `☑ ${cl.done}/${cl.total}` }), {
        label: `Checklist, ${cl.done} of ${cl.total} done — ${open ? "hide" : "show"} it`,
        expanded: open,
      });
      chip.setAttr("data-focus", `checklist:${task.path}`);
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        open ? this.checklistOpen.delete(task.path) : this.checklistOpen.add(task.path);
        this.render();
      });
    }
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
      const chip = pressable(meta.createSpan({ cls: "brewin-meta-flag", text: flagText(flag) }), { label: `${flag.label} — show every task with it` });
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        this.go({ view: "all", project: null, flag: flag.id });
      });
    }
    // Time on it: a running focus clock says so; otherwise what's logged, against any estimate.
    const spent = totalMinutes(task.timeLog ?? []);
    if (this.plugin.timer.isRunning(task.path)) {
      const chip = pressable(meta.createSpan({ cls: "brewin-meta-timing", text: "⏱ timing" }), { label: "Timing — open the focus window" });
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
      const chip = pressable(meta.createSpan({ cls: "brewin-meta-attr", text }), { label: `${a.label} ${text.replace(/^\S+\s/, "")} — show every task with it` });
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
      const projectName = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
      const chip = pressable(meta.createSpan({ cls: "brewin-meta-project", text: `⚡ ${projectName}` }), { label: `Project ${projectName} — show it` });
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
        const crumb = pressable(meta.createSpan({ cls: "brewin-parent-crumb", text: `↳ ${p.title}` }), { label: `Part of “${p.title}” — open it` });
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
          await this.plugin.act(async () => {
            await fn();
            return `“${task.title}” → ${label.toLowerCase()}`;
          });
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
      this.iconBtn(actions, "✏️", `Edit “${task.title}”`, () => this.editTask(task), `edit:${task.path}`);
      this.iconBtn(actions, "📅", `Reschedule “${task.title}”`, async () => {
        const r = await pickDate(this.app, task.scheduled, this.plugin.settings.firstDayOfWeek, {
          selectedLabel: "Scheduled",
          relatedISO: task.due,
          relatedLabel: "Due",
        });
        if (r !== undefined) await this.change(r ? `“${task.title}” → ${shortDate(r)}` : `“${task.title}” has no date now`, () => this.plugin.store.setScheduled(task, r));
      });
      this.iconBtn(actions, "⏱️", this.plugin.timer.isRunning(task.path) ? "Focus timer (timing)" : "Focus timer", () => this.plugin.openFocus(task.path), `focus:${task.path}`);
      this.iconBtn(actions, "⋯", `More for “${task.title}”`, (ev) => this.rowMenu(ev, task), `more:${task.path}`);
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
        const box = line.createEl("input", { type: "checkbox", attr: { "data-focus": `slot:${task.path}:${slot.time}` } });
        box.checked = done;
        box.setAttr("aria-label", `${slotTitle(slot)} — ${done ? "untick" : "tick"}`);
        box.addEventListener("click", async (e) => {
          e.preventDefault();
          await this.plugin.act(async () => {
            const res = await this.plugin.store.toggleSlot(task, slot.time, slotDay);
            return res.ok ? `${slotTitle(slot)} ${done ? "unticked" : "ticked"} — “${task.title}”` : `Can't complete “${task.title}” — ${completionRefusal(res)}.`;
          });
          this.render();
        });
        line.createSpan({ cls: "brewin-slot-label", text: slotTitle(slot) });
      }
    }

    // The checklist, as its note reads — ticked in place, and offered back with Undo.
    const items = this.checklistOpen.has(task.path) ? this.checklists.get(task.path) : undefined;
    if (items) {
      const group = parent.createDiv({ cls: "brewin-slot-group brewin-checklist-group" });
      if (!items.length) group.createDiv({ cls: "brewin-slot-row", text: "The checklist has gone from the note." });
      for (const item of items) {
        const line = group.createDiv({ cls: "brewin-slot-row" + (item.done ? " done" : "") });
        const box = line.createEl("input", { type: "checkbox", attr: { "data-focus": `check:${task.path}:${item.line}` } });
        box.checked = item.done;
        box.setAttr("aria-label", `${item.text} — ${item.done ? "untick" : "tick"}`);
        box.addEventListener("click", async (e) => {
          e.preventDefault();
          await this.plugin.act(async () =>
            (await this.plugin.store.tickChecklist(task, item, !item.done)) ? `${item.done ? "☐" : "☑"} ${item.text}` : `“${item.text}” has changed in the note since it was read.`
          );
          this.render();
        });
        line.createSpan({ cls: "brewin-slot-label", text: item.text });
      }
    }

    // Nested subtasks
    if (kids.length && this.expanded.has(task.path)) {
      const sub = parent.createDiv({ cls: "brewin-subtask-group" });
      kids.forEach((k) => this.taskRow(sub, k, k.status === "done", true));
    }
  }

  /** Tick a project step in its note — with its completion date, and offered back with Undo. */
  private async tickStep(src: ProjectTaskSource, pt: ProjectTask): Promise<void> {
    const name = plainText(pt.text) || "untitled step";
    await this.plugin.act(async () =>
      (await src.complete(pt)) ? `✓ ${name}` : `“${name}” has changed in ${pt.projectName} since it was read.`
    );
    this.render();
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

  /** Star a task as one of today's top three, or take the star off — never a fourth. */
  /** A key pressed while the dashboard is the active pane (keys.ts). True when it was one of its own. */
  onKey(e: KeyboardEvent): boolean {
    const active = this.contentEl.doc.activeElement;
    if (isTyping(e.target) || isTyping(active)) return false;
    const a = dashKey(e);
    if (!a) return false;
    switch (a.kind) {
      case "move":
        return this.moveRow(a.by);
      case "row":
        return this.rowKey(a.act, active instanceof HTMLElement ? active : null);
      case "new":
        this.newTask();
        return true;
      case "search": {
        const input = Array.from(this.contentEl.querySelectorAll<HTMLInputElement>(".brewin-search")).find((el) => el.offsetParent !== null);
        input?.focus();
        input?.select();
        return !!input;
      }
      case "view": {
        const id = orderedViews(this.plugin.settings.menuOrder)[a.index];
        if (id) this.go({ view: id, project: null });
        return !!id;
      }
      case "undo":
        void this.plugin.undo();
        return true;
      case "help":
        new KeysModal(this.app, "dashboard").open();
        return true;
    }
  }

  /** j / k: the next or previous row's title — what every row key acts from. */
  private moveRow(by: 1 | -1): boolean {
    const found = this.bodyEl?.querySelectorAll<HTMLElement>(".brewin-task-row .brewin-task-link, .brewin-card [data-focus^='title:']");
    const titles = Array.from(found ?? []).filter((t) => t.offsetParent !== null);
    if (!titles.length) return false;
    const rowOf = (el: Element | null) => el?.closest(".brewin-task-row, .brewin-card") ?? null;
    const at = titles.findIndex((t) => rowOf(t) === rowOf(this.contentEl.doc.activeElement));
    const next = titles[at < 0 ? (by > 0 ? 0 : titles.length - 1) : Math.min(titles.length - 1, Math.max(0, at + by))];
    next.focus();
    next.scrollIntoView({ block: "nearest" });
    return true;
  }

  /** x e s d p t Delete, on the row the keyboard is on. A project step or a note's task ticks and opens only. */
  private rowKey(act: Extract<DashKeyAction, { kind: "row" }>["act"], active: HTMLElement | null): boolean {
    const row = active?.closest<HTMLElement>(".brewin-task-row, .brewin-card");
    if (!row || !this.contentEl.contains(row)) return false;
    const title = row.querySelector<HTMLElement>(".brewin-task-link, [data-focus^='title:']");
    if (act === "tick") {
      const box = row.querySelector<HTMLInputElement>(":scope > input[type=checkbox]");
      box?.click();
      return !!box;
    }
    if (act === "edit") {
      title?.click();
      return !!title;
    }
    const key = title?.getAttribute("data-focus") ?? "";
    const task = key.startsWith("title:") ? this.plugin.store.getByPath(key.slice(6)) : null;
    if (!task) return false;
    const fdow = this.plugin.settings.firstDayOfWeek;
    switch (act) {
      case "schedule":
        void pickDate(this.app, task.scheduled, fdow, { selectedLabel: "Scheduled", relatedISO: task.due, relatedLabel: "Due" }).then((r) => {
          if (r !== undefined) void this.change(r ? `“${task.title}” → ${shortDate(r)}` : `“${task.title}” has no date now`, () => this.plugin.store.setScheduled(task, r));
        });
        return true;
      case "due":
        void pickDate(this.app, task.due, fdow, { selectedLabel: "Due", relatedISO: task.scheduled, relatedLabel: "Scheduled" }).then((r) => {
          if (r !== undefined) void this.change(r ? `“${task.title}” due ${shortDate(r)}` : `“${task.title}”: due date cleared`, () => this.plugin.store.setDue(task, r));
        });
        return true;
      case "postpone": {
        if (task.status === "done" || task.status === "someday") return false;
        const menu = new Menu();
        this.plugin.addPostponeItems(menu, task, () => this.render());
        const r = row.getBoundingClientRect();
        menu.showAtPosition({ x: r.left + 24, y: r.bottom });
        return true;
      }
      case "top":
        void this.toggleTop(task);
        return true;
      case "delete":
        this.deleteTask(task);
        return true;
    }
  }

  private async toggleTop(task: Task): Promise<void> {
    const today = todayISO();
    const next = toggleTop(this.plugin.store.getTasks(), task, today);
    if (next === undefined) return void new Notice(`${TOP_LIMIT} are starred for today already — unstar one first.`);
    await this.change(next ? `⭐ “${task.title}” is one of today's top ${TOP_LIMIT}` : `“${task.title}” isn't a top task now`, () => this.plugin.store.setTop(task, next));
  }

  /** One change to a task, offered back with Undo, then a redraw. */
  private async change(message: string, fn: () => Promise<unknown>): Promise<void> {
    await this.plugin.act(async () => {
      await fn();
      return message;
    });
    this.render();
  }

  /** The user's status flags, as menu items: each one this task could take, and taking its own off. */
  private flagMenuItems(menu: Menu, task: Task): void {
    const flags = this.plugin.settings.statusFlags.filter((f) => !flagRefusal(task, f));
    if (!flags.length && !task.flag) return;
    menu.addSeparator();
    for (const f of flags) {
      menu.addItem((i) =>
        i.setTitle(flagText(f)).onClick(async () => {
          await this.plugin.act(async () => {
            const refused = await this.plugin.store.setFlag(task, f);
            return refused ? `“${task.title}” ${refused}.` : `“${task.title}” is now ${flagText(f)}`;
          });
          this.render();
        })
      );
    }
    const own = task.flag;
    if (own) {
      menu.addItem((i) =>
        i.setTitle(`Clear ${flagText(own)}`).setIcon("x").onClick(() => void this.change(`“${task.title}”: ${flagText(own)} cleared`, () => this.plugin.store.clearFlag(task)))
      );
    }
    menu.addSeparator();
  }

  private rowMenu(ev: MouseEvent, task: Task): void {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Edit task…").setIcon("pencil").onClick(() => this.editTask(task)));
    menu.addItem((i) => i.setTitle("Focus timer…").setIcon("timer").onClick(() => this.plugin.openFocus(task.path)));
    if (task.status !== "done") {
      const today = todayISO();
      const starred = isTop(task, today);
      menu.addItem((i) =>
        i.setTitle(starred ? "Not one of today's top 3" : "⭐ One of today's top 3").setIcon("star").onClick(() => void this.toggleTop(task))
      );
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Set due date").setIcon("flag").onClick(async () => {
      const r = await pickDate(this.app, task.due, this.plugin.settings.firstDayOfWeek, {
        selectedLabel: "Due",
        relatedISO: task.scheduled,
        relatedLabel: "Scheduled",
      });
      if (r !== undefined) await this.change(r ? `“${task.title}” due ${shortDate(r)}` : `“${task.title}”: due date cleared`, () => this.plugin.store.setDue(task, r));
    }));
    this.plugin.addPostponeItems(menu, task, () => this.render());
    const t = `“${task.title}”`;
    if (task.status === "hold") {
      menu.addItem((i) => i.setTitle("Un-hold").setIcon("play").onClick(() => void this.change(`${t} is off hold`, () => this.plugin.store.setStatus(task, "todo"))));
    } else if (task.status !== "someday") {
      menu.addItem((i) => i.setTitle("Put on hold").setIcon("pause").onClick(() => void this.change(`${t} put on hold`, () => this.plugin.store.setStatus(task, "hold"))));
    }
    if (task.status === "someday") {
      menu.addItem((i) => i.setTitle("Back to the inbox").setIcon("inbox").onClick(() => void this.change(`${t} is back in the inbox`, () => this.plugin.store.setStatus(task, "todo"))));
    } else if (!task.recurrence && task.status !== "done") {
      menu.addItem((i) => i.setTitle("Move to Someday").setIcon("cloud").onClick(() => void this.change(`${t} moved to Someday`, () => this.plugin.store.setStatus(task, "someday"))));
    }
    this.flagMenuItems(menu, task);
    menu.addItem((i) =>
      i.setTitle(task.project ? "Move to another project…" : "Move to project…").setIcon("folder-input").onClick(() => {
        new ProjectSuggestModal(this.app, this.projects.map(({ path, name }) => ({ path, name })), (p) =>
          void this.change(`${t} is now in ${p.name}`, () => this.plugin.store.setProject(task, p.path))
        ).open();
      })
    );
    if (task.project) {
      menu.addItem((i) => i.setTitle("Remove from project").setIcon("folder-minus").onClick(() => void this.change(`${t} taken out of its project`, () => this.plugin.store.setProject(task, null))));
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
          await this.plugin.act(async () =>
            (await this.plugin.store.setParent(task, picked)) ? `${t} is now under “${picked.title}”` : "That would create a loop — pick a different parent."
          );
          this.render();
        }).open();
      })
    );
    if (task.parentPath) {
      menu.addItem((i) =>
        i.setTitle("Clear parent").setIcon("unlink").onClick(() => void this.change(`${t} is a task of its own again`, () => this.plugin.store.setParent(task, null)))
      );
    }

    menu.addSeparator();
    (["high", "normal", "low"] as const).forEach((p) =>
      menu.addItem((i) => i.setTitle(`Priority: ${p}`).onClick(() => void this.change(`${t}: ${p} priority`, () => this.plugin.store.setPriority(task, p))))
    );
    menu.addItem((i) => i.setTitle("Open note").setIcon("file").onClick(() => this.openNote(task.path)));
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Delete task…").setIcon("trash").onClick(() => this.deleteTask(task))
    );
    showMenuFor(menu, ev);
  }

  /** Confirm and delete, making the fate of any subtasks explicit. */
  private deleteTask(task: Task): void {
    const kids = childrenOf(this.index, task);
    new DeleteTaskModal(this.app, task.title, kids.length, async (choice) => {
      if (!choice) return;
      await this.plugin.act(async () => {
        const n = await this.plugin.store.deleteTask(task, choice === "with-subtasks");
        return n === 1 ? `Deleted “${task.title}”` : `Deleted ${n} tasks`;
      });
      this.expanded.delete(task.path);
      this.render();
    }).open();
  }

  /** Quick inline prompt for adding one subtask to an existing task. */
  private promptSubtask(task: Task): void {
    new SubtaskPrompt(this.app, task.title, async (title) => {
      this.expanded.add(task.path); // reveal what was just added
      await this.change(`Added “${title}” under “${task.title}”`, () => this.plugin.store.addSubtask(task, title));
    }).open();
  }

  /** A project's step, or a checkbox task from another note — `showNote` says which note on the row. */
  private projectRow(parent: HTMLElement, src: ProjectTaskSource, pt: ProjectTask, today: string, showNote = true): void {
    const row = parent.createDiv({ cls: "brewin-task-row brewin-project-row" });
    const cb = row.createEl("input", { type: "checkbox" });
    cb.setAttr("aria-label", `Tick “${plainText(pt.text) || "untitled step"}” in ${pt.fromNote ? pt.projectName : "the project note"}`);
    cb.addEventListener("click", async (e) => {
      e.preventDefault();
      await this.tickStep(src, pt);
    });
    const main = row.createDiv({ cls: "brewin-task-main" });
    const titleLine = main.createDiv({ cls: "brewin-task-title" });
    if (pt.isNext) titleLine.createSpan({ cls: "brewin-next", text: "⚡ " });
    // An empty "- [ ]" line in the note still deserves a visible row, or it reads as a stray checkbox.
    // Its words open the step's own window: words, dates and #next changed in place on the line.
    const words = titleLine.createSpan({ cls: "brewin-task-link" + (pt.text ? "" : " brewin-untitled"), text: plainText(pt.text) || "(untitled task)" });
    pressable(words).addEventListener("click", () => this.plugin.openStep(pt, () => this.render()));
    const meta = main.createDiv({ cls: "brewin-task-meta" });
    // The note a checkbox task lives in — tap to open it at the line.
    if (pt.fromNote && showNote) {
      const chip = pressable(meta.createSpan({ cls: "brewin-meta-note", text: `🗒 ${pt.projectName}` }), { label: `Open ${pt.projectName} at this line` });
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const file = this.app.vault.getAbstractFileByPath(pt.projectPath);
        if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file, { eState: { line: pt.line } });
      });
    }
    // Dates said the way task rows say them, with the exact date a long-press away.
    if (pt.scheduled) meta.createSpan({ cls: "brewin-meta-sched", text: `📅 ${relativeDay(pt.scheduled, today)}`, attr: { title: pt.scheduled } });
    if (pt.due) {
      const overdue = pt.due < today;
      meta.createSpan({ cls: overdue ? "brewin-meta-overdue" : "brewin-meta-due", text: `🚩 ${overdue ? relativeDay(pt.due, today) : `due ${relativeDay(pt.due, today)}`}`, attr: { title: `Due ${pt.due}` } });
    }
    const actions = row.createDiv({ cls: "brewin-task-actions" });
    this.iconBtn(actions, "📅", "Schedule", async () => {
      const r = await pickDate(this.app, pt.scheduled, this.plugin.settings.firstDayOfWeek, {
        selectedLabel: "Scheduled",
        relatedISO: pt.due,
        relatedLabel: "Due",
      });
      if (r === undefined) return;
      await this.plugin.act(async () => ((await src.setDate(pt, "scheduled", r)) ? `“${plainText(pt.text)}” → ${r ?? "no date"}` : null));
      this.render();
    });
  }

  private iconBtn(parent: HTMLElement, icon: string, tip: string, onClick: (ev: MouseEvent) => void, focusKey?: string): void {
    const b = parent.createEl("button", { cls: "brewin-icon-btn", text: icon });
    b.setAttr("aria-label", tip);
    if (focusKey) b.setAttr("data-focus", focusKey);
    b.addEventListener("click", (ev) => onClick(ev));
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
    input.setAttr("aria-label", "Subtask");
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      this.onSubmit(v);
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if (isSubmitKey(e)) submit();
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
    input.setAttr("aria-label", "Context");
    input.style.width = "100%";
    input.addEventListener("input", () => (this.value = input.value));
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (isSubmitKey(e)) {
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
    input.setAttr("aria-label", "Estimate");
    input.style.width = "100%";
    input.addEventListener("input", () => (this.raw = input.value));
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (isSubmitKey(e)) {
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
