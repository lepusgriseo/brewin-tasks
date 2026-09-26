import { Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { BrewinSettings, BrewinSettingTab, DEFAULT_SETTINGS } from "./settings";
import { TaskStore } from "./taskStore";
import { CaptureModal } from "./captureModal";
import { BREWIN_VIEW_TYPE, DashboardView } from "./dashboardView";
import { pickDate } from "./datePicker";
import { taskFromFrontmatter } from "./task";
import { EventStore } from "./eventStore";
import { EventModal } from "./eventModal";
import { CALENDAR_VIEW_TYPE, CalendarView } from "./calendarView";
import { TIME_VIEW_TYPE, TimeView } from "./timeView";
import { TaskSuggestModal } from "./taskSuggestModal";
import { ReminderService } from "./reminderService";
import { BacklogStore } from "./backlogStore";
import { ConfirmModal } from "./confirmModal";
import { formatHM, isoWeekOf, minutesOfDay, nowMinutes, todayISO, weekRange } from "./dates";
import { eventsToItems, tasksToItems } from "./calendarItem";
import { attentionTasks, expandRecurringTasks, formatWeekTaskBlock, unscheduledTasks, weekTaskReview } from "./views";
import { fillSection } from "./section";
import { autoScheduleDay, freeGapsToday } from "./autoSchedule";
import { CalendarItem } from "./types";

/** Heading the weekly-review command fills. Must match `_Template/Weekly Review.md`. */
const TASK_SECTION_HEADING = "### Tasks this week";

export default class BrewinTasksPlugin extends Plugin {
  settings!: BrewinSettings;
  store!: TaskStore;
  events!: EventStore;
  reminders!: ReminderService;
  backlog!: BacklogStore;
  private refreshQueued = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new TaskStore(this.app, this.settings);
    this.events = new EventStore(this.app, this.settings);
    this.backlog = new BacklogStore(this.app, this.settings);
    this.reminders = new ReminderService(this);
    this.reminders.start();

    this.registerView(BREWIN_VIEW_TYPE, (leaf: WorkspaceLeaf) => new DashboardView(leaf, this));
    this.registerView(CALENDAR_VIEW_TYPE, (leaf: WorkspaceLeaf) => new CalendarView(leaf, this));
    this.registerView(TIME_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TimeView(leaf, this));

    this.addRibbonIcon("calendar", "Brewin: calendar", () => this.activateCalendar());
    this.addRibbonIcon("checkmark", "Brewin Planner dashboard", () => this.activateView());
    this.addRibbonIcon("plus-circle", "Brewin: quick capture", () => this.openCapture());

    this.addCommand({
      id: "brewin-quick-capture",
      name: "Quick capture",
      callback: () => this.openCapture(),
    });
    this.addCommand({
      id: "brewin-open-dashboard",
      name: "Open dashboard",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "brewin-edit-active",
      name: "Edit task",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && this.isTaskFile(file.path);
        if (ok && !checking) this.editActive();
        return ok;
      },
    });
    this.addCommand({
      id: "brewin-schedule-active",
      name: "Schedule active task",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && this.isTaskFile(file.path);
        if (ok && !checking) this.scheduleActive();
        return ok;
      },
    });
    this.addCommand({
      id: "brewin-archive-done",
      name: "Archive done tasks",
      callback: async () => {
        const n = await this.store.archiveDone();
        new Notice(`Archived ${n} completed task${n === 1 ? "" : "s"}.`);
        this.refreshViews();
      },
    });
    this.addCommand({
      id: "brewin-reschedule-overdue",
      name: "Reschedule overdue to today",
      callback: async () => {
        const overdue = attentionTasks(this.store.getTasks(), todayISO()).overdue;
        if (!overdue.length) {
          new Notice("Nothing overdue.");
          return;
        }
        const n = await this.store.bulkReschedule(overdue, todayISO());
        new Notice(`Rescheduled ${n} task${n === 1 ? "" : "s"} to today.`);
        this.refreshViews();
      },
    });
    this.addCommand({
      id: "brewin-search-tasks",
      name: "Search tasks",
      callback: () => {
        const open = this.store.getTasks().filter((t) => t.status !== "done");
        if (!open.length) {
          new Notice("No open tasks.");
          return;
        }
        new TaskSuggestModal(
          this.app,
          open,
          (task) => new CaptureModal(this.app, this.store, this.settings, () => this.refreshViews(), task).open(),
          "Search tasks…"
        ).open();
      },
    });
    this.addCommand({
      id: "brewin-test-reminder",
      name: "Test a reminder",
      callback: () => this.reminders.testFire(),
    });
    this.addCommand({ id: "brewin-open-calendar", name: "Open calendar", callback: () => this.activateCalendar() });
    this.addCommand({
      id: "brewin-new-event",
      name: "New event",
      callback: () => new EventModal(this.app, this.events, this.settings, () => this.refreshViews()).open(),
    });
    this.addCommand({ id: "brewin-archive-past-events", name: "Archive past events", callback: () => this.archivePastEventsFlow() });
    this.addCommand({ id: "brewin-open-time", name: "Open time report", callback: () => this.activateTime() });
    this.addCommand({
      id: "brewin-auto-schedule-today",
      name: "Auto-schedule today's free time",
      callback: async () => {
        const res = await this.autoScheduleToday();
        this.reportAutoSchedule(res);
        this.refreshViews();
      },
    });
    this.addCommand({
      id: "brewin-insert-week-task-summary",
      name: "Insert this week's task summary",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && file.extension === "md";
        if (ok && !checking) void this.insertWeekTaskSummary(file!);
        return ok;
      },
    });

    this.addSettingTab(new BrewinSettingTab(this.app, this));

    // Refresh open dashboards when task/project notes change. Skip our own Tasks Backlog.md —
    // otherwise writing it would re-trigger this listener, recompute it again, write again,
    // forever.
    const onVaultChange = (file: TAbstractFile) => {
      if (file.path === this.backlog.notePath) return;
      this.queueRefresh();
    };
    this.registerEvent(this.app.metadataCache.on("changed", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));
  }

  onunload(): void {
    // Leaves are cleaned up by Obsidian; nothing else to tear down.
  }

  private isTaskFile(path: string): boolean {
    return (
      path.startsWith(this.settings.itemsFolder + "/") ||
      path.startsWith(this.settings.routinesFolder + "/")
    );
  }

  openCapture(): void {
    new CaptureModal(this.app, this.store, this.settings, () => this.refreshViews()).open();
  }

  /** Confirm, then move every event dated before today into the archive folder. */
  archivePastEventsFlow(): void {
    const past = this.events.pastEvents(todayISO());
    if (!past.length) {
      new Notice("No past events to archive.");
      return;
    }
    new ConfirmModal(this.app, {
      title: "Archive past events",
      body: `Move ${past.length} event${past.length === 1 ? "" : "s"} dated before today into "${this.settings.eventsArchiveFolder}"? Recurring events stay put.`,
      cta: "Archive",
      onConfirm: async () => {
        const n = await this.events.archivePastEvents(todayISO());
        new Notice(`Archived ${n} past event${n === 1 ? "" : "s"}.`);
        this.refreshViews();
      },
    }).open();
  }

  /**
   * Fill today's free gaps with unscheduled tasks — priority first, same-context tasks kept
   * adjacent (see `autoSchedule.ts`). Never reaches into the past: the search window starts at
   * "now" when that's later than the configured start. Shared by the command and the Today
   * view's button so the two can never disagree about what "auto-schedule" does.
   */
  async autoScheduleToday(): Promise<{ scheduled: number; unplaced: number }> {
    const s = this.settings;
    const today = todayISO();
    const windowStart = Math.max(nowMinutes(), minutesOfDay(s.autoScheduleStart) ?? 0);
    const windowEnd = minutesOfDay(s.autoScheduleEnd) ?? 24 * 60;

    const allTasks = this.store.getTasks();
    const items: CalendarItem[] = [
      ...eventsToItems(this.events.getEvents(), today, today),
      ...tasksToItems(allTasks.filter((t) => !t.recurrence), today, today, s.slotBlockMinutes),
      ...expandRecurringTasks(allTasks.filter((t) => !!t.recurrence), today, today, s.slotBlockMinutes),
    ];
    const busy: [number, number][] = items
      .filter((it): it is CalendarItem & { start: string; end: string } => it.date === today && !it.allDay && !!it.start && !!it.end)
      .map((it) => [minutesOfDay(it.start) ?? 0, minutesOfDay(it.end) ?? 0]);

    const gaps = freeGapsToday(busy, windowStart, windowEnd);
    const { placements, unplaced } = autoScheduleDay(unscheduledTasks(allTasks), gaps, s.defaultTaskMinutes);

    for (const p of placements) {
      await this.store.scheduleAt(p.task, today, formatHM(p.start), formatHM(p.end));
    }
    return { scheduled: placements.length, unplaced: unplaced.length };
  }

  reportAutoSchedule(res: { scheduled: number; unplaced: number }): void {
    if (!res.scheduled && !res.unplaced) {
      new Notice("No unscheduled tasks or no free time today.");
      return;
    }
    new Notice(
      `Scheduled ${res.scheduled} task${res.scheduled === 1 ? "" : "s"}` +
        (res.unplaced ? ` · ${res.unplaced} didn't fit today.` : ".")
    );
  }

  /** Open the create/edit window for the task note currently open. */
  editActive(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const task = this.store.getByPath(file.path);
    if (!task) {
      new Notice("This note isn't a Brewin task.");
      return;
    }
    new CaptureModal(this.app, this.store, this.settings, () => this.refreshViews(), task).open();
  }

  /**
   * Which ISO week a review note is about: its `Week:` frontmatter, else a `YYYY-Www` in the
   * filename, else the current ISO week (with a heads-up). Returns the week label and its
   * Mon–Sun bounds, or null when nothing resolves.
   */
  private resolveReviewWeek(file: TFile): { label: string; start: string; end: string } | null {
    const fmWeek = this.app.metadataCache.getFileCache(file)?.frontmatter?.Week;
    const fromFm = fmWeek != null ? weekRange(String(fmWeek)) : null;
    if (fromFm) return { label: String(fmWeek).trim(), ...fromFm };

    const nameLabel = /(\d{4}-W\d{2})/.exec(file.basename)?.[1];
    const fromName = nameLabel ? weekRange(nameLabel) : null;
    if (fromName) return { label: nameLabel!, ...fromName };

    const label = isoWeekOf(todayISO());
    const fromToday = weekRange(label);
    if (fromToday) {
      new Notice(`No Week: frontmatter — using the current ISO week ${label}.`);
      return { label, ...fromToday };
    }
    new Notice("Couldn't work out which week to summarise.");
    return null;
  }

  /** Write a frozen summary of the week's tasks (done / missed / still open) into `file`. */
  async insertWeekTaskSummary(file: TFile): Promise<void> {
    const week = this.resolveReviewWeek(file);
    if (!week) return;
    const review = weekTaskReview(this.store.getTasks(), week.start, week.end, todayISO());
    const block = formatWeekTaskBlock(review, {
      weekLabel: week.label,
      startISO: week.start,
      endISO: week.end,
      generatedISO: todayISO(),
    });
    await this.app.vault.process(file, (data) => fillSection(data, TASK_SECTION_HEADING, block));
    new Notice(`Task summary for ${week.label} inserted.`);
  }

  async scheduleActive(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const cache = this.app.metadataCache.getFileCache(file);
    const task = taskFromFrontmatter((cache?.frontmatter ?? {}) as Record<string, unknown>, file.path, file.basename);
    const r = await pickDate(this.app, task.scheduled, this.settings.firstDayOfWeek, {
      selectedLabel: "Scheduled",
      relatedISO: task.due,
      relatedLabel: "Due",
    });
    if (r !== undefined) {
      await this.store.setScheduled(task, r);
      this.refreshViews();
      new Notice(r ? `Scheduled for ${r}` : "Schedule cleared");
    }
  }

  async activateView(): Promise<void> {
    await this.reveal(BREWIN_VIEW_TYPE);
  }

  async activateCalendar(): Promise<void> {
    await this.reveal(CALENDAR_VIEW_TYPE, true);
  }

  async activateTime(): Promise<void> {
    await this.reveal(TIME_VIEW_TYPE);
  }

  private async reveal(type: string, mainPane = false): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      // Calendar wants a big main-pane leaf; dashboards go in the right sidebar.
      leaf = mainPane ? workspace.getLeaf(true) : workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /** Open a note by vault path — used by reminder popups. */
  async openPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new Notice("Note not found: " + path);
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BREWIN_VIEW_TYPE)) {
      if (leaf.view instanceof DashboardView) leaf.view.render();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)) {
      if (leaf.view instanceof CalendarView) leaf.view.render();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(TIME_VIEW_TYPE)) {
      if (leaf.view instanceof TimeView) leaf.view.render();
    }
  }

  private queueRefresh(): void {
    // A vault edit may have added or moved something timed, so the reminder source list is
    // no longer trustworthy. Flagging is cheap; rescanning every 30s would not be.
    this.reminders?.markStale();
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    window.setTimeout(() => {
      this.refreshQueued = false;
      void this.backlog.writeOwn(this.store.getTasks(), todayISO());
      this.refreshViews();
    }, 300);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
