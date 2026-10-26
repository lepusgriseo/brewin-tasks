import { Notice, Platform, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { BrewinSettings, BrewinSettingTab, DEFAULT_SETTINGS, PROJECTS_CATEGORY } from "./settings";
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
import { eventsToItems, projectTasksToItems, tasksToItems } from "./calendarItem";
import { attentionTasks, expandRecurringTasks, formatWeekTaskBlock, groupByProject, unscheduledTasks, weekTaskReview } from "./views";
import { fillSection, isLiveReview } from "./section";
import { autoScheduleDay, freeGapsToday } from "./autoSchedule";
import { CalendarItem } from "./types";
import { TemplateStore } from "./templateStore";
import { TemplateSuggestModal } from "./templateSuggestModal";
import { DEFAULT_TEMPLATE_ICON, PlannerTemplate, templateCommandId } from "./plannerTemplate";
import { archivable } from "./status";
import { parseTimes, planIsRest, planSlots, TrainingSource, trainingItems } from "./training";
import { BirthdayStore } from "./birthdayStore";
import { ProjectStore } from "./projectStore";
import { birthdayLabel, birthdaysBetween } from "./birthdays";
import { ProjectTaskSource } from "./projectTasks";
import { dayBrief, DayBrief } from "./dayBrief";
import { rangeBrief, RangeBrief } from "./rangeBrief";
import { sanitizeFlags } from "./statusFlags";
import { sanitizeAttributes } from "./attributes";
import { TaskTimer } from "./timer";
import { FloatingTimer } from "./floatingTimer";
import { FocusModal } from "./focusModal";
import { minutesText } from "./timeTrack";

/** Heading the weekly-review command fills. Must match `_Template/Weekly Review.md`. */
const TASK_SECTION_HEADING = "### Tasks this week";

export default class BrewinTasksPlugin extends Plugin {
  settings!: BrewinSettings;
  store!: TaskStore;
  events!: EventStore;
  reminders!: ReminderService;
  backlog!: BacklogStore;
  templates!: TemplateStore;
  birthdays!: BirthdayStore;
  projects!: ProjectStore;
  /** The focus timer — one clock at a time, kept on the task note. */
  timer!: TaskTimer;
  /** The pill that shows a running clock while its focus window is shut. */
  floating!: FloatingTimer;
  private refreshQueued = false;

  /**
   * Read-only, for notes: `app.plugins.plugins["brewin-tasks"].api.day("2026-10-22")` from
   * dataviewjs. The day note (`00_Systems/Scripts/Day/view.js`) and the review notes
   * (`00_Systems/Scripts/Review/view.js`) are the callers; `version` lets them notice a change of
   * shape (adding a function, as `range` was in 1.56.0, keeps it).
   */
  readonly api = {
    version: 1,
    day: (iso: string): Promise<DayBrief> => this.dayBrief(iso),
    /** Inclusive ISO range, for the weekly and monthly reviews (`00_Systems/Scripts/Review`). */
    range: (fromISO: string, toISO: string): Promise<RangeBrief> => this.rangeBrief(fromISO, toISO),
  };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new TaskStore(this.app, this.settings);
    this.events = new EventStore(this.app, this.settings);
    this.backlog = new BacklogStore(this.app, this.settings);
    this.templates = new TemplateStore(this.app, this.settings);
    this.birthdays = new BirthdayStore(this.app, this.settings);
    this.projects = new ProjectStore(this.app, this.settings);
    this.timer = new TaskTimer(this);
    this.floating = new FloatingTimer(this);
    this.timer.onChange(() => {
      this.floating.update();
      this.queueRefresh();
    });
    CaptureModal.openFocus = (path) => this.openFocus(path);
    CaptureModal.saveSettings = async () => {
      await this.saveSettings();
      this.refreshViews();
    };
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
      id: "brewin-toggle-dashboard-menu",
      name: "Toggle the dashboard menu",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(DashboardView);
        if (!view) return false;
        if (!checking) void view.toggleMenu();
        return true;
      },
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
    this.addCommand({ id: "brewin-focus-timer", name: "Focus timer…", callback: () => this.pickFocus() });
    this.addCommand({
      id: "brewin-pause-timer",
      name: "Pause the focus timer",
      checkCallback: (checking) => {
        if (!this.timer.running) return false;
        if (!checking) void this.pauseTimer();
        return true;
      },
    });
    this.addCommand({
      id: "brewin-new-event",
      name: "New event",
      callback: () =>
        new EventModal(this.app, this.events, this.settings, () => this.refreshViews())
          .withTemplateLibrary(this.templates)
          .open(),
    });
    this.addCommand({
      id: "brewin-new-from-template",
      name: "New from template…",
      callback: () => this.pickTemplate(),
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

    this.app.workspace.onLayoutReady(() => this.registerTemplateCommands());

    this.addSettingTab(new BrewinSettingTab(this.app, this));

    // Refresh open dashboards when task/project notes change. Skip our own Tasks Backlog.md —
    // otherwise writing it would re-trigger this listener, recompute it again, write again,
    // forever.
    //
    // Only changes under folders the Planner draws from count. Listening to the whole vault meant
    // editing any note — or a sync landing — rebuilt the calendar and threw the dashboard back to
    // its top, which on a phone is most of the time.
    const onVaultChange = (file: TAbstractFile, oldPath?: string) => {
      if (file.path === this.backlog.notePath) return;
      // A people note: re-read its birthday first, so the redraw shows the new date.
      if (this.birthdays.owns(file.path) || (oldPath && this.birthdays.owns(oldPath))) {
        void this.birthdays.update(file, oldPath).then(() => this.queueRefresh());
        return;
      }
      if (!this.isOurs(file.path) && !(oldPath && this.isOurs(oldPath))) return;
      this.queueRefresh();
    };
    // A project note the Planner just wrote is read from what was written until the cache has it.
    // Registered first, so the redraw that follows the change reads the cache, not the stale copy.
    this.registerEvent(this.app.metadataCache.on("changed", (f) => this.projects.forget(f.path)));
    this.registerEvent(this.app.metadataCache.on("changed", (f) => onVaultChange(f)));
    // A clock started or stopped on another device arrives as a change to a task note.
    this.registerEvent(this.app.metadataCache.on("changed", (f) => {
      if (f.path.startsWith(this.settings.itemsFolder + "/") || f.path.startsWith(this.settings.routinesFolder + "/")) this.timer.reload();
    }));
    this.registerEvent(this.app.vault.on("create", (f) => onVaultChange(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => onVaultChange(f)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => onVaultChange(f, old)));

    this.app.workspace.onLayoutReady(() => {
      // A phone restores its layout from its own workspace file, so a dashboard an earlier version
      // put in the right drawer would sit there until next opened. Clear it out on load.
      if (Platform.isMobile) {
        const { workspace } = this.app;
        for (const type of [BREWIN_VIEW_TYPE, TIME_VIEW_TYPE]) {
          for (const leaf of workspace.getLeavesOfType(type)) {
            const root = leaf.getRoot();
            if (root === workspace.leftSplit || root === workspace.rightSplit) leaf.detach();
          }
        }
      }
      // Give the metadata cache a moment to finish indexing before deciding what is old enough.
      window.setTimeout(() => void this.fileAwayDoneTasks(), 4000);
      // Birthdays are read from the people notes' text, once, then kept up to date by the watcher.
      void this.birthdays.loadAll().then(() => this.refreshViews());
      // A clock left running when Obsidian closed is still running: pick it up.
      this.timer.reload();
      this.floating.update();
    });
  }

  onunload(): void {
    // Leaves are cleaned up by Obsidian. The floating timer is ours, on the document itself. A
    // running clock is not stopped: it is on the task note, and carries on when the plugin loads.
    this.floating?.destroy();
  }

  /** A task's focus window. Asking for another task's closes the open one first (asking, if it is timing). */
  openFocus(path: string): void {
    const current = FocusModal.current;
    if (current?.path === path) return;
    current?.close();
    if (FocusModal.current) return; // they chose to stay
    new FocusModal(this.app, this, path).open();
  }

  /** The command: the task note that's open, else the running clock's task, else pick one. */
  private pickFocus(): void {
    const active = this.app.workspace.getActiveFile();
    const task = active ? this.store.getByPath(active.path) : null;
    if (task) return this.openFocus(task.path);
    if (this.timer.running) return this.openFocus(this.timer.running.path);
    const open = this.store.getTasks().filter((t) => t.status !== "done");
    new TaskSuggestModal(this.app, open, (t) => this.openFocus(t.path), "Which task are you working on?").open();
  }

  /** Stop the clock and log the session, saying how much was logged. */
  async pauseTimer(): Promise<void> {
    const run = this.timer.running;
    if (!run) return;
    const title = this.store.getByPath(run.path)?.title ?? "the task";
    const min = await this.timer.pause();
    new Notice(min ? `${minutesText(min)} logged on “${title}”.` : "Under half a minute — not logged.");
  }

  /** Folders whose notes change what the Planner shows — its own, and Fitness's for training. */
  private isOurs(path: string): boolean {
    const s = this.settings;
    const fitness = this.fitness()?.settings as { sessionsFolder?: string; plansFolder?: string } | undefined;
    const folders = [
      s.itemsFolder, s.routinesFolder, s.eventsFolder, s.projectsFolder, s.tripsFolder,
      s.templatesFolder, s.accountabilityFolder, fitness?.sessionsFolder, fitness?.plansFolder,
    ];
    return folders.some((f) => !!f && (path === `${f}.md` || path.startsWith(`${f}/`)));
  }

  // ── Done tasks file themselves away ───────────────────────────────────────

  private lastFiledOn = "";
  private filing = false;

  /**
   * Move done tasks into the Done folder once they are a few days old. The command existed but had
   * filed 3 of 102, which left the Items folder mostly finished work. Runs at most once a day.
   */
  private async fileAwayDoneTasks(): Promise<void> {
    const today = todayISO();
    if (this.filing || this.lastFiledOn === today) return;
    this.lastFiledOn = today;
    const due = archivable(this.store.getTasks(), today, this.settings.autoArchiveDoneDays, this.settings.doneFolder);
    if (!due.length) return;
    this.filing = true;
    try {
      const n = await this.store.archiveTasks(due);
      if (n >= 5) new Notice(`Filed ${n} completed task${n === 1 ? "" : "s"} into Done.`);
    } finally {
      this.filing = false;
    }
  }

  // ── Brewin Fitness's plan, on the calendar ────────────────────────────────

  /** The Fitness plugin, when it is installed and enabled. */
  /** Open a sibling Brewin plugin's own view — nothing happens when it isn't installed and enabled. */
  async openSibling(id: "brewin-habits" | "brewin-fitness"): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sibling = (this.app as any).plugins?.plugins?.[id];
    if (id === "brewin-habits") await sibling?.activateHabits?.();
    else await sibling?.activateDashboard?.();
  }

  private fitness(): any | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.app as any).plugins?.plugins?.["brewin-fitness"] ?? null;
  }

  /**
   * What Fitness has scheduled, read once: the active plan and the sessions index. Asking Fitness
   * per day would re-read every session note for every day of a month view.
   */
  private trainingSource(): TrainingSource | null {
    if (!this.settings.trainingOnCalendar) return null;
    const fit = this.fitness();
    const plan = fit?.plans?.getActivePlan?.();
    if (!plan?.schedule) return null;
    const sessions: Array<{ path: string; date: string; routine: string | null; status: string }> = fit.sessions?.getSessions?.() ?? [];
    const byKey = new Map(sessions.filter((s) => s.routine).map((s) => [`${s.date}|${s.routine!.toLowerCase()}`, s]));
    return {
      slots: (d) => planSlots(plan.schedule, d),
      isRest: (d) => planIsRest(plan.schedule, d),
      session: (routine, d) => {
        const s = byKey.get(`${d}|${routine.toLowerCase()}`);
        return s ? { path: s.path, status: s.status } : null;
      },
    };
  }

  /** Training sessions from the Fitness plan, as calendar items. Empty when Fitness is not on. */
  trainingItems(fromISO: string, toISO: string): CalendarItem[] {
    const src = this.trainingSource();
    if (!src) return [];
    return trainingItems(src, fromISO, toISO, parseTimes(this.settings.trainingTimes), this.settings.trainingMinutes);
  }

  /** Birthdays from the people notes, as all-day calendar items. Tapping one opens the person's note. */
  birthdayItems(fromISO: string, toISO: string): CalendarItem[] {
    if (!this.settings.birthdaysOnCalendar) return [];
    return birthdaysBetween(this.birthdays.getPeople(), fromISO, toISO).map((b) => ({
      kind: "birthday",
      path: b.person.path,
      title: birthdayLabel(b.person.name, b.age),
      date: b.date,
      allDay: true,
      start: null,
      end: null,
      done: false,
      category: "Birthdays",
      recurring: false,
    }));
  }

  /**
   * Everything the Calendar places between two days: tasks (repeats expanded), events, active
   * projects' steps, training from the Fitness plan and birthdays. The Calendar passes its own
   * switches and hidden categories; the day note takes everything.
   */
  async calendarItems(
    fromISO: string,
    toISO: string,
    o: { tasks?: boolean; events?: boolean; projectTasks?: boolean; shown?: (category: string) => boolean } = {}
  ): Promise<CalendarItem[]> {
    const shown = o.shown ?? (() => true);
    const items: CalendarItem[] = [];
    if (o.tasks ?? true) {
      // Recurring tasks are EXPANDED across the range, same as recurring events — otherwise there'd
      // be nothing beyond the current occurrence to drag or edit. Multi-day tasks are left to the
      // caller's spanning bar.
      const all = this.store.getTasks();
      items.push(
        ...tasksToItems(all.filter((t) => !t.recurrence), fromISO, toISO, this.settings.slotBlockMinutes, { skipMultiDay: true }),
        ...expandRecurringTasks(all.filter((t) => !!t.recurrence), fromISO, toISO, this.settings.slotBlockMinutes)
      );
    }
    if (o.events ?? true) items.push(...eventsToItems(this.events.getEvents(), fromISO, toISO).filter((it) => shown(it.category)));
    if (o.projectTasks ?? true) {
      const pts = await new ProjectTaskSource(this.app, this.settings).getProjectTasks(true); // active projects only
      items.push(...projectTasksToItems(pts, fromISO, toISO, PROJECTS_CATEGORY));
    }
    // Brewin Fitness's plan — one source of truth for training instead of hand-made events.
    items.push(...this.trainingItems(fromISO, toISO).filter((it) => shown(it.category)));
    // Birthdays from the people notes' DOB:: lines.
    items.push(...this.birthdayItems(fromISO, toISO));
    return items;
  }

  /** What one day holds, for the day note — see `dayBrief`. */
  async dayBrief(iso: string): Promise<DayBrief> {
    const steps = new Map(groupByProject(await new ProjectTaskSource(this.app, this.settings).getProjectTasks()).map((g) => [g.path, g.tasks]));
    return dayBrief({
      date: iso,
      today: todayISO(),
      items: await this.calendarItems(iso, iso, { tasks: false }),
      tasks: this.store.getTasks(),
      projects: this.projects.list().map((info) => ({ info, openSteps: steps.get(info.path) ?? [] })),
    });
  }

  /** What a stretch of days held, for the review notes — see `rangeBrief`. */
  async rangeBrief(fromISO: string, toISO: string): Promise<RangeBrief> {
    return rangeBrief({
      from: fromISO,
      to: toISO,
      today: todayISO(),
      items: await this.calendarItems(fromISO, toISO, { tasks: false, projectTasks: false }),
      tasks: this.store.getTasks(),
      focusCategory: this.settings.timerToCalendar ? this.settings.timerCategory : null,
    });
  }

  /** Open a training item: the logged session if there is one, else start it in Fitness. */
  async openTraining(item: CalendarItem): Promise<void> {
    const fit = this.fitness();
    if (!fit || !item.training || item.training.rest) return;
    if (item.training.sessionPath) await fit.openSession?.(item.training.sessionPath);
    else await fit.startScheduledRoutine?.(item.training.routine, item.date);
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
    if (isLiveReview(await this.app.vault.read(file))) {
      new Notice("This review shows its tasks live — nothing to insert. Its 📌 button freezes the week.");
      return;
    }
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
    const task = taskFromFrontmatter((cache?.frontmatter ?? {}) as Record<string, unknown>, file.path, file.basename, this.settings.statusFlags, this.settings.attributes);
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
    await this.reveal(BREWIN_VIEW_TYPE, this.sideOrMain());
  }

  async activateCalendar(): Promise<void> {
    await this.reveal(CALENDAR_VIEW_TYPE, "main");
  }

  async activateTime(): Promise<void> {
    await this.reveal(TIME_VIEW_TYPE, this.sideOrMain());
  }

  /** On a phone the right sidebar is a drawer, which is where the dashboard used to end up hidden. */
  private sideOrMain(): "main" | "sidebar" {
    return this.settings.dashboardInSidebar && !Platform.isMobile ? "sidebar" : "main";
  }

  /**
   * Show a view where it belongs. A leaf found in the wrong place is closed rather than reused —
   * otherwise a layout saved by an older version would keep restoring it there.
   */
  private async reveal(type: string, where: "main" | "sidebar"): Promise<void> {
    const { workspace } = this.app;
    const inSidebar = (l: WorkspaceLeaf) => {
      const root = l.getRoot();
      return root === workspace.leftSplit || root === workspace.rightSplit;
    };
    const wantSidebar = where === "sidebar";
    let leaf: WorkspaceLeaf | null = null;
    for (const l of workspace.getLeavesOfType(type)) {
      if (inSidebar(l) === wantSidebar && !leaf) leaf = l;
      else if (inSidebar(l) !== wantSidebar) l.detach();
    }
    if (!leaf) {
      leaf = wantSidebar ? workspace.getRightLeaf(false) ?? workspace.getLeaf("tab") : workspace.getLeaf("tab");
      await leaf.setViewState({ type, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  /** Open a note by vault path — used by reminder popups. */
  async openPath(path: string): Promise<void> {
    if (path.startsWith("training:")) {
      // "training:<date>:<routine>" — a session not started yet. Start it in Fitness.
      const [, date, ...rest] = path.split(":");
      const routine = rest.join(":");
      const item = this.trainingItems(date, date).find((it) => it.title === routine);
      if (item) await this.openTraining(item);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new Notice("Note not found: " + path);
  }

  /** Open the searchable library, then the right modal with that template applied. */
  pickTemplate(dateISO?: string, time?: string): void {
    const library = this.templates.list();
    if (library.length === 0) {
      new Notice(`No templates yet — add a note to ${this.settings.templatesFolder} with \`planner_template: event\` or \`: task\`.`);
      return;
    }
    new TemplateSuggestModal(this.app, library, (t) => this.openFromTemplate(t, dateISO, time)).open();
  }

  /** Create from one template. `dateISO` is the day a calendar cell was clicked, when it was. */
  openFromTemplate(t: PlannerTemplate, dateISO?: string, time?: string): void {
    if (t.kind === "event") {
      new EventModal(this.app, this.events, this.settings, () => this.refreshViews(), dateISO)
        .withTemplateLibrary(this.templates)
        .applyTemplate(t, { startTime: time })
        .open();
      return;
    }
    new CaptureModal(
      this.app,
      this.store,
      this.settings,
      () => this.refreshViews(),
      undefined,
      undefined,
      dateISO ? { scheduled: dateISO, startTime: time } : undefined
    )
      .withTemplateLibrary(this.templates)
      .applyTemplate(t, { startTime: time })
      .open();
  }

  /**
   * One command per template, so each can take a hotkey or a mobile toolbar slot.
   *
   * Obsidian has no public way to remove a command, so these are registered once per session:
   * adding or renaming a template shows up after a reload. The searchable
   * "New from template…" command always reflects the library as it is right now.
   */
  private registerTemplateCommands(): void {
    for (const t of this.templates.list()) {
      this.addCommand({
        id: templateCommandId(t),
        name: `New ${t.kind}: ${t.name}`,
        icon: t.icon ?? DEFAULT_TEMPLATE_ICON[t.kind],
        callback: () => {
          // Re-read by name so an edited template is honoured without a reload.
          const fresh = this.templates.byName(t.name, t.kind) ?? t;
          this.openFromTemplate(fresh);
        },
      });
    }
  }

  /** Open the Planner's own tab in Obsidian's settings (the menu's "Add your own…" status). */
  openSettings(): void {
    // `app.setting` is real but not in the public typings.
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
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
      void this.fileAwayDoneTasks();
      this.refreshViews();
    }, 300);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.statusFlags = sanitizeFlags(this.settings.statusFlags);
    this.settings.attributes = sanitizeAttributes(this.settings.attributes);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
