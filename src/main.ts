import { App, FuzzySuggestModal, MarkdownFileInfo, MarkdownView, Menu, normalizePath, Notice, Platform, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { BrewinSettings, BrewinSettingTab, DEFAULT_SETTINGS, FOLDER_KEYS, IcsCalendar, NEW_CALENDAR_NAME, PROJECTS_CATEGORY } from "./settings";
import { IcsService } from "./icsService";
import { ExternalEventModal } from "./externalEventModal";
import { cleanFolder } from "./paths";
import { collectTags, fieldsOf, TaskStore } from "./taskStore";
import { CaptureModal } from "./captureModal";
import { BREWIN_VIEW_TYPE, DashboardView } from "./dashboardView";
import { pickDate } from "./datePicker";
import { parentLinkpath, sanitizeFilename, taskFromFrontmatter } from "./task";
import { EventStore } from "./eventStore";
import { EventModal } from "./eventModal";
import { CALENDAR_VIEW_TYPE, CalendarView } from "./calendarView";
import { TIME_VIEW_TYPE, TimeView } from "./timeView";
import { TaskSuggestModal } from "./taskSuggestModal";
import { ReminderService } from "./reminderService";
import { BacklogStore } from "./backlogStore";
import { ConfirmModal } from "./confirmModal";
import { addMinutesHM, coerceISO, formatHM, isoWeekOf, minutesOfDay, nowMinutes, shortDate, todayISO, weekRange } from "./dates";
import { eventsToItems, projectTasksToItems, tasksToItems } from "./calendarItem";
import { attentionTasks, expandRecurringTasks, formatWeekTaskBlock, groupByProject, unscheduledTasks, weekTaskReview } from "./views";
import { fillSection, isLiveReview } from "./section";
import { autoScheduleDay, freeGapsToday } from "./autoSchedule";
import { CalendarItem, Task } from "./types";
import { postponeChoices } from "./postpone";
import { currentOccurrenceISO } from "./recurrence";
import { GoalInfo, GoalProject, goalsOverview, GoalsOverview } from "./goals";
import { parseProjectTemplate, projectNoteFromTemplate, ProjectTemplate } from "./projectTemplate";
import { PromptModal } from "./promptModal";
import { TemplateStore } from "./templateStore";
import { TemplateSuggestModal } from "./templateSuggestModal";
import { DEFAULT_TEMPLATE_ICON, PlannerTemplate, templateCommandId } from "./plannerTemplate";
import { archivable, completionRefusal } from "./status";
import { parseTimes, planIsRest, planSlots, TrainingSource, trainingItems } from "./training";
import { BirthdayStore } from "./birthdayStore";
import { ProjectStore } from "./projectStore";
import { birthdayLabel, birthdaysBetween } from "./birthdays";
import { ProjectTask, ProjectTaskSource } from "./projectTasks";
import { dayBrief, DayBrief } from "./dayBrief";
import { rangeBrief, RangeBrief } from "./rangeBrief";
import { sanitizeFlags } from "./statusFlags";
import { sanitizeAttributes } from "./attributes";
import { TaskTimer } from "./timer";
import { FloatingTimer } from "./floatingTimer";
import { FocusModal } from "./focusModal";
import { minutesText, pomodoroPhase } from "./timeTrack";
import { planPropertyTypes, PropertyType } from "./propertyTypes";
import { reconcile, SeenTask, seenFrom } from "./reconcile";
import { tasksBaseYaml } from "./basesTemplate";
import { createNote, journal, UndoEntry, writeText } from "./undo";
import { StepModal } from "./stepModal";
import { forgetNoteTasks, hadNoteTasks, NoteTaskSource, noteTasksToItems } from "./noteTasks";
import { PlanDayModal } from "./planDayModal";
import { ShutdownModal } from "./shutdownModal";
import { readUri, URI_ACTION, UriView } from "./uri";
import { lineAsTask, LineTask } from "./inlineTask";
import { parseCapture } from "./nlp";
import { plainText } from "./projects";

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Bump when TASK_PROPERTY_TYPES gains a property, so the types are set again on the next load. */
const PROPERTY_TYPES_VERSION = 3; // 2: `top` · 3: `recurrence_from`

/** Heading the weekly-review command fills. Must match `_Template/Weekly Review.md`. */
const TASK_SECTION_HEADING = "### Tasks this week";

export default class BrewinTasksPlugin extends Plugin {
  settings!: BrewinSettings;
  store!: TaskStore;
  events!: EventStore;
  /** Other calendars (.ics subscriptions), read-only — see icsService.ts. */
  ics!: IcsService;
  reminders!: ReminderService;
  backlog!: BacklogStore;
  templates!: TemplateStore;
  birthdays!: BirthdayStore;
  projects!: ProjectStore;
  /** The focus timer — one clock at a time, kept on the task note. */
  timer!: TaskTimer;
  /** The pill that shows a running clock while its focus window is shut. */
  floating!: FloatingTimer;
  /** The pending redraw after vault changes, if one is queued. */
  private refreshTimer: number | null = null;
  /** Set once the plugin unloads: work still waiting on a timer finds it and stops. */
  private unloaded = false;

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
    /** Goals, their projects and progress — see goals.ts. */
    goals: (): GoalsOverview => this.goals(),
  };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new TaskStore(this.app, this.settings);
    this.events = new EventStore(this.app, this.settings);
    this.ics = new IcsService(this);
    this.ics.loadCopies();
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
    CaptureModal.skip = (task) => this.act(() => this.skip(task)).then(() => this.refreshViews());
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
      id: "brewin-new-project-from-template",
      name: "New project from template…",
      callback: () => void this.newProjectFromTemplate(),
    });
    // obsidian://brewin-planner?… — capture and open from outside Obsidian (uri.ts).
    this.registerObsidianProtocolHandler(URI_ACTION, (params) => void this.openLink(params));
    this.addCommand({
      id: "brewin-line-to-task",
      name: "Make this line a Planner task",
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        const line = editor.getCursor().line;
        const raw = editor.getLine(line);
        const found = file && !this.isTaskFile(file.path) ? lineAsTask(raw) : null;
        if (!file || !found) return false;
        if (!checking) void this.lineToTask(ctx, file, line, raw, found);
        return true;
      },
    });
    this.addCommand({
      id: "brewin-task-from-note",
      name: "New task linked to this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md" || this.isTaskFile(file.path)) return false;
        if (!checking) this.newTaskFrom(file);
        return true;
      },
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
      name: "Open task window for this note",
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
        await this.act(async () => {
          const n = await this.store.archiveDone();
          return `Archived ${n} completed task${n === 1 ? "" : "s"}`;
        });
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
        await this.act(async () => {
          const n = await this.store.bulkReschedule(overdue, todayISO());
          return `Rescheduled ${n} task${n === 1 ? "" : "s"} to today`;
        });
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
    this.addCommand({ id: "brewin-create-base", name: "Create a Base of your tasks", callback: () => void this.createTasksBase() });
    this.addCommand({ id: "brewin-undo", name: "Undo the last Planner change", callback: () => void this.undo() });
    this.addCommand({ id: "brewin-plan-day", name: "Plan my day", callback: () => this.planDay() });
    this.addCommand({ id: "brewin-shut-down", name: "Shut down the day", callback: () => this.shutDown() });
    this.addCommand({
      id: "brewin-property-types",
      name: "Set task property types for Bases",
      callback: () => void this.applyPropertyTypes({ quiet: false }),
    });
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
        await this.act(async () => this.autoScheduleMessage(await this.autoScheduleToday()));
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
    // Other calendars: fetched once the vault is up, then every half hour while Obsidian is open.
    this.app.workspace.onLayoutReady(() => void this.ics.refresh());
    this.registerInterval(window.setInterval(() => void this.ics.refresh(), 30 * 60 * 1000));
    this.addCommand({ id: "brewin-refresh-calendars", name: "Refresh other calendars", callback: () => void this.ics.refresh() });
    // Pomodoro: a chime and a note when a round or a break ends — checked each second while a clock runs.
    this.registerInterval(window.setInterval(() => this.pomodoroTick(), 1000));

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
    // The task index is dropped by any change that could alter a task — a task note's properties, or a
    // note appearing, going or moving (parents, projects and dependencies are links to other notes).
    // Registered first, so every listener after these reads the changed state.
    this.registerEvent(this.app.metadataCache.on("changed", (f) => {
      if (this.isTaskFile(f.path)) this.store.invalidate();
    }));
    this.registerEvent(this.app.vault.on("create", () => this.store.invalidate()));
    this.registerEvent(this.app.vault.on("delete", () => this.store.invalidate()));
    this.registerEvent(this.app.vault.on("rename", () => this.store.invalidate()));
    // A project note the Planner just wrote is read from what was written until the cache has it.
    // Registered first, so the redraw that follows the change reads the cache, not the stale copy.
    this.registerEvent(this.app.metadataCache.on("changed", (f) => this.projects.forget(f.path)));
    this.registerEvent(this.app.metadataCache.on("changed", (f) => onVaultChange(f)));
    // Checkbox tasks in other notes (noteTasks.ts): a note written is read again, and a change to one
    // that held them, or that now has an open box, redraws the views.
    this.registerEvent(this.app.vault.on("modify", (f) => forgetNoteTasks(f.path)));
    this.registerEvent(this.app.metadataCache.on("changed", (f, _data, cache) => {
      if (this.isOurs(f.path)) return; // onVaultChange has it
      if (hadNoteTasks(f.path) || cache?.listItems?.some((li) => li.task === " ")) this.queueRefresh();
    }));
    // Edits made outside the Planner — a Base, the Properties panel, a sync — get the Planner's rules.
    this.registerEvent(this.app.metadataCache.on("changed", (f, _data, cache) => {
      if (this.isTaskFile(f.path)) void this.reconcileNote(f, (cache?.frontmatter ?? {}) as Record<string, unknown>);
    }));
    this.registerEvent(this.app.vault.on("rename", (f, old) => {
      const seen = this.seen.get(old);
      this.seen.delete(old);
      if (seen && this.isTaskFile(f.path)) this.seen.set(f.path, seen);
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => this.seen.delete(f.path)));
    // A task note open in the editor gets a button for its task window; any task note gets two
    // entries on its right-click menu — from the file list, a link, search, or a row in a Base.
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncHeaderActions()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncHeaderActions()));
    this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
      if (!(file instanceof TFile) || !this.isTaskFile(file.path) || !this.store.getByPath(file.path)) return;
      menu.addItem((i) => i.setTitle("Open task window").setIcon("list-checks").setSection("open").onClick(() => this.editPath(file.path)));
      menu.addItem((i) => i.setTitle("Focus timer").setIcon("timer").setSection("open").onClick(() => this.openFocus(file.path)));
    }));
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
      const fileAway = window.setTimeout(() => void this.fileAwayDoneTasks(), 4000);
      this.register(() => window.clearTimeout(fileAway));
      // Birthdays are read from the people notes' text, once, then kept up to date by the watcher.
      void this.birthdays.loadAll().then(() => this.refreshViews());
      // A clock left running when Obsidian closed is still running: pick it up.
      this.timer.reload();
      this.floating.update();
      // How every task note looks now, to tell later edits from what was already there.
      // A note the cache hasn't read yet is left unseen, so its first reading counts as a first sighting.
      for (const file of this.app.vault.getMarkdownFiles()) {
        const fm = this.isTaskFile(file.path) ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
        if (fm) this.seen.set(file.path, seenFrom(fm as Record<string, unknown>));
      }
      this.syncHeaderActions();
      // Property types for Bases, once (and again when this list grows).
      if (this.settings.propertyTypesVersion < PROPERTY_TYPES_VERSION) void this.applyPropertyTypes({ quiet: false, first: true });
    });
  }

  onunload(): void {
    // Leaves are cleaned up by Obsidian. The floating timer is ours, on the document itself. A
    // running clock is not stopped: it is on the task note, and carries on when the plugin loads.
    this.unloaded = true;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.reminders?.stop();
    this.floating?.destroy();
    CaptureModal.openFocus = null;
    CaptureModal.skip = null;
    CaptureModal.saveSettings = null;
    for (const [view, el] of this.headerActions) {
      el.remove();
      this.headerActions.delete(view);
    }
  }

  /** Task notes as last seen — what `reconcile` compares an edit against. */
  private seen = new Map<string, SeenTask>();
  /** How long a repeating task marked done elsewhere is left before its occurrence is ticked (ms). */
  occurrenceDelay = 2500;

  /** A task note changed: if it was edited outside the Planner, finish the edit by the Planner's rules. */
  private async reconcileNote(file: TFile, fm: Record<string, unknown>): Promise<void> {
    const now = seenFrom(fm);
    const before = this.seen.get(file.path);
    this.seen.set(file.path, now);
    const repair = reconcile(before, now, this.settings.statusFlags, todayISO());
    if (!repair) return;
    if (repair.kind === "occurrence") {
      // A repeating task marked done by hand: tick this occurrence, which moves it on. Not at once —
      // the same edit reaches every synced device, and only one of them should tick it. The device
      // it was made on usually wins the race; the others then find the task already moved on.
      await sleep(this.occurrenceDelay);
      if (this.unloaded) return;
      const task = this.store.getByPath(file.path);
      if (!task || task.status !== "done" || task.completed) return;
      const res = await this.store.complete({ ...task, status: "todo" });
      const after = this.store.getByPath(file.path);
      if (res.ok) new Notice(`“${task.title}” ticked for this time — it repeats, so it's back on ${after?.scheduled ?? "its next date"}.`);
      else {
        await this.app.fileManager.processFrontMatter(file, (f) => (f.status = "todo"));
        new Notice(`“${task.title}” can't be ticked yet — ${completionRefusal(res)}.`);
      }
      return;
    }
    let after: SeenTask = now;
    await this.app.fileManager.processFrontMatter(file, (f) => {
      if (repair.status !== undefined) f.status = repair.status;
      if (repair.flag === null) delete f.flag;
      if (repair.completed !== undefined) f.completed = repair.completed;
      f.modified = todayISO();
      after = seenFrom(f);
    });
    // Seen as repaired at once, rather than waiting on the cache to say so — so the next edit is
    // compared with this, whenever the cache catches up.
    this.seen.set(file.path, after);
  }

  /**
   * Give the Planner's properties (and the user's attributes) their types where Obsidian has none, so
   * Bases and the Properties panel read them right. `first` is the one-off run on loading this
   * version, which may also replace the yes/no `completed` type every Planner note contradicts.
   */
  async applyPropertyTypes(o: { quiet: boolean; first?: boolean; attributesOnly?: boolean }): Promise<void> {
    const mgr = (this.app as unknown as {
      metadataTypeManager?: { getAssignedWidget?(n: string): string | null; setType?(n: string, t: string): Promise<void> };
    }).metadataTypeManager;
    if (!mgr?.getAssignedWidget || !mgr.setType) {
      if (!o.quiet) new Notice("This version of Obsidian doesn't let plugins set property types — set them in the Properties view instead.");
      return;
    }
    const plan = planPropertyTypes((n) => mgr.getAssignedWidget!(n), this.settings.attributes);
    const keys = new Set(this.settings.attributes.map((a) => a.key));
    // Saving settings only adds types for attributes, and never replaces one.
    const changes = o.attributesOnly ? plan.changes.filter((c) => keys.has(c.name) && c.from === null) : plan.changes;
    for (const c of changes) await mgr.setType(c.name, c.to as PropertyType);
    if (o.first) {
      this.settings.propertyTypesVersion = PROPERTY_TYPES_VERSION;
      await this.saveData(this.settings);
    }
    if (o.quiet) return;
    const replaced = changes.filter((c) => c.from);
    const lines = [
      changes.length ? `Brewin Planner set types for ${changes.length} task propert${changes.length === 1 ? "y" : "ies"}, so Bases and the Properties panel read them right.` : "Task properties already have their types.",
      ...replaced.map((c) => `“${c.name}” was ${c.from}; the Planner writes a ${c.to} there, so it is now a ${c.to}.`),
      ...plan.conflicts.map((c) => `“${c.name}” is a ${c.assigned} in your vault; the Planner writes ${c.wanted} — left as you set it.`),
    ];
    if (!o.first || changes.length) {
      new Notice(
        createFragment((f) => lines.forEach((l, i) => (i && f.createEl("br"), f.appendText(l)))),
        12000
      );
    }
  }

  /**
   * A starter Base of the tasks, beside the task folders — views to change or copy in Bases. An
   * existing one is opened, never overwritten.
   */
  async createTasksBase(): Promise<void> {
    const s = this.settings;
    const parent = s.itemsFolder.includes("/") ? s.itemsFolder.slice(0, s.itemsFolder.lastIndexOf("/")) : "";
    const path = normalizePath(parent ? `${parent}/Tasks.base` : "Tasks.base");
    let file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) new Notice(`${path} is already there — opened it. Rename it to make a fresh one.`);
    else {
      file = await this.app.vault.create(path, tasksBaseYaml(s));
      new Notice(`Made ${path}: views of your tasks to change or copy in Bases.`);
    }
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  /**
   * Do something the user can take back. What `fn` writes through the stores is kept as one step, and
   * the message it returns is shown with an Undo button — or as a plain notice when nothing was
   * written (a refusal, say).
   */
  async act(fn: () => Promise<string | null | void>): Promise<void> {
    const { value, changes } = await journal.run(fn);
    const message = value || null;
    const entry = journal.keep(message ?? "Changed", changes);
    if (entry) this.offerUndo(entry);
    else if (message) new Notice(message);
  }

  /** The change's message, with Undo beside it for a few seconds. */
  private offerUndo(entry: UndoEntry): void {
    let notice: Notice | null = null;
    const frag = createFragment((f) => {
      const box = f.createDiv({ cls: "brewin-undo-toast" });
      box.createSpan({ cls: "brewin-undo-label", text: entry.label });
      const b = box.createEl("button", { cls: "brewin-undo-btn", text: "Undo" });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        notice?.hide();
        void this.undo(entry);
      });
    });
    notice = new Notice(frag, 8000);
  }

  /** Take back the last change made through the Planner — or `entry`, from its toast. */
  async undo(entry: UndoEntry | null = journal.latest()): Promise<void> {
    if (!entry) {
      new Notice("Nothing to undo.");
      return;
    }
    const { skipped } = await journal.undo(this.app, entry);
    for (const c of entry.changes) forgetNoteTasks(c.kind === "rename" ? c.from : c.path);
    const names = skipped.map((p) => p.split("/").pop()!.replace(/\.md$/, ""));
    new Notice(
      skipped.length
        ? `Undone, except ${[...new Set(names)].join(", ")} — changed again since, so left as it is now.`
        : `Undone: ${entry.label}`
    );
    this.refreshViews();
  }

  /** A project step's window. */
  openStep(step: ProjectTask, onChange: () => void = () => this.refreshViews()): void {
    new StepModal(this.app, step, {
      source: new ProjectTaskSource(this.app, this.settings),
      firstDayOfWeek: this.settings.firstDayOfWeek,
      act: (fn) => this.act(fn),
      onChange,
    }).open();
  }

  /** Checkbox tasks from the rest of the vault — see noteTasks.ts. */
  noteTasks(): Promise<ProjectTask[]> {
    return new NoteTaskSource(this.app, this.settings).list();
  }

  /** The checkbox task on a note's line — a project's step or a note task — as it now reads. */
  async findStep(path: string, line: number): Promise<ProjectTask | null> {
    const steps = [...(await new ProjectTaskSource(this.app, this.settings).getProjectTasks()), ...(await this.noteTasks())];
    return steps.find((s) => s.projectPath === path && s.line === line) ?? null;
  }

  /** The step on a note's line (from a calendar chip or a review row); the note itself when it's gone. */
  async openStepAt(path: string, line: number, onChange?: () => void): Promise<void> {
    const step = await this.findStep(path, line);
    if (step) return this.openStep(step, onChange);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file, { eState: { line } });
  }

  /** The editor's task notes each carry a button for their task window; other notes lose it. */
  private headerActions = new Map<MarkdownView, HTMLElement>();
  private syncHeaderActions(): void {
    const open = new Set<MarkdownView>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      open.add(view);
      const file = view.file;
      const want = !!file && this.isTaskFile(file.path);
      const have = this.headerActions.get(view);
      if (want && !have) {
        this.headerActions.set(view, view.addAction("list-checks", "Open task window", () => view.file && this.editPath(view.file.path)));
      } else if (!want && have) {
        have.remove();
        this.headerActions.delete(view);
      }
    }
    for (const [view, el] of this.headerActions) if (!open.has(view)) (el.remove(), this.headerActions.delete(view));
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
    // Checkbox tasks from the rest of the vault (day notes, dated or #task lines) go with the tasks.
    if (o.tasks ?? true) items.push(...noteTasksToItems(await this.noteTasks(), fromISO, toISO));
    // Other calendars, read-only, with the events.
    if (o.events ?? true) items.push(...this.ics.items(fromISO, toISO));
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
      // Task notes come in as `tasks`; checkbox tasks in other notes as items of their own.
      items: [...(await this.calendarItems(iso, iso, { tasks: false })), ...noteTasksToItems(await this.noteTasks(), iso, iso)],
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

  /** An event from another calendar, read-only: its details, and a copy into the Planner's own. */
  openExternal(item: CalendarItem): void {
    new ExternalEventModal(this.app, this, item).open();
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

  /** The Pomodoro phase last seen, so a change is told once. */
  private lastPhase: string | null = null;

  private pomodoroTick(): void {
    const pom = this.timer?.pomodoro();
    const run = this.timer?.running;
    if (!pom || !run) {
      this.lastPhase = null;
      return;
    }
    const ph = pomodoroPhase(this.timer.elapsed(), pom);
    const key = `${run.path}|${run.start}|${ph.kind}|${ph.round}`;
    if (this.lastPhase !== null && this.lastPhase !== key && this.lastPhase.startsWith(`${run.path}|${run.start}|`)) {
      this.reminders?.playChime();
      new Notice(ph.kind === "work" ? `🍅 Round ${ph.round} — back to it.` : `☕ ${ph.kind === "long" ? `A long break — ${pom.long} minutes` : `A break — ${pom.short} minutes`}. Round ${ph.round} done.`);
    }
    this.lastPhase = key;
  }

  /** Move a task's do-date: a one-off's own date, a repeating task's current occurrence only. */
  async postpone(task: Task, iso: string): Promise<string> {
    if (task.recurrence) {
      const occ = currentOccurrenceISO(task) ?? todayISO();
      await this.store.applyRecurringEdit(task, occ, "single", fieldsOf(task, iso));
      return `“${task.title}” → ${shortDate(iso)}, this time only`;
    }
    await this.store.setScheduled(task, iso);
    // The deadline stays where it is: a postponement says so rather than moving a commitment.
    return `“${task.title}” → ${shortDate(iso)}${task.due && task.due < iso ? ` — after its deadline, ${shortDate(task.due)}` : ""}`;
  }

  /** "Skip this time" for a repeating task: not done, not missed, on to its next date. */
  async skip(task: Task): Promise<string> {
    const next = await this.store.skipOccurrence(task);
    return next ? `Skipped “${task.title}” this time — next ${shortDate(next)}` : `Skipped “${task.title}” — that was its last time`;
  }

  /** Postpone and Skip on a task's menu — the dashboard's ⋯ and a calendar chip's right-click. */
  addPostponeItems(menu: Menu, task: Task, after: () => void): void {
    if (task.status === "done" || task.status === "someday") return;
    const run = async (fn: () => Promise<string>) => {
      await this.act(fn);
      after();
    };
    for (const c of postponeChoices(todayISO(), this.settings.firstDayOfWeek)) {
      menu.addItem((i) => i.setTitle(`Postpone to ${c.label} · ${shortDate(c.iso)}`).setIcon("calendar-clock").onClick(() => run(() => this.postpone(task, c.iso))));
    }
    menu.addItem((i) =>
      i.setTitle("Postpone to…").setIcon("calendar-search").onClick(async () => {
        const r = await pickDate(this.app, task.scheduled, this.settings.firstDayOfWeek, { selectedLabel: "Postpone to" });
        if (r) await run(() => this.postpone(task, r));
      })
    );
    if (task.recurrence) menu.addItem((i) => i.setTitle("Skip this time").setIcon("skip-forward").onClick(() => run(() => this.skip(task))));
  }

  // ── Goals and project templates ──────────────────────────────────────────────

  /** Goals with their projects — the 🎯 Goals view, and `api.goals()` for the review notes. */
  goals(): GoalsOverview {
    return goalsOverview(this.goalNotes(), this.goalProjects(), todayISO());
  }

  /** The goal notes: tagged #goal, in the goals folder. */
  private goalNotes(): GoalInfo[] {
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
    const out: GoalInfo[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(this.settings.goalsFolder + "/")) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
      if (!collectTags(fm, cache).some((t) => t.toLowerCase() === "goal")) continue;
      out.push({
        path: file.path,
        name: file.basename,
        status: text(fm.status).toLowerCase(),
        area: text(fm.area),
        period: text(fm.period),
        targetDate: coerceISO(fm.target_date),
        completed: coerceISO(fm.completed),
      });
    }
    return out;
  }

  /** The goal a project names in `goal:`, resolved — null for none, or a link to nothing. */
  goalOf(projectPath: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(projectPath);
    const goal = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter?.goal : null;
    const link = parentLinkpath(typeof goal === "string" ? goal : null);
    return link ? this.app.metadataCache.getFirstLinkpathDest(link, projectPath) : null;
  }

  /** Every project, with its goal and how far along it is: the steps in its note and its task notes. */
  private goalProjects(): GoalProject[] {
    const tasks = this.store.getTasks();
    return this.projects.list().map((info) => {
      const file = this.app.vault.getAbstractFileByPath(info.path);
      const boxes = (file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.listItems : null)?.filter((li) => li.task !== undefined) ?? [];
      const mine = tasks.filter((t) => t.projectPath === info.path);
      return {
        path: info.path,
        name: info.name,
        status: info.status,
        next: info.next,
        due: info.due,
        goalPath: this.goalOf(info.path)?.path ?? null,
        done: boxes.filter((li) => li.task !== " ").length + mine.filter((t) => t.status === "done").length,
        total: boxes.length + mine.length,
      };
    });
  }

  /** The project templates: notes in the templates folder with `planner_template: project`. */
  async projectTemplates(): Promise<ProjectTemplate[]> {
    const out: ProjectTemplate[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(this.settings.templatesFolder + "/")) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (String(fm?.planner_template ?? "").toLowerCase() !== "project") continue;
      const body = (await this.app.vault.cachedRead(file)).replace(/^---\n[\s\S]*?\n---\n?/, "");
      const t = parseProjectTemplate({ path: file.path, basename: file.basename, frontmatter: fm, body });
      if (t) out.push(t);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** "New project from template…": pick one, name the project, give it a deadline. */
  async newProjectFromTemplate(): Promise<void> {
    const templates = await this.projectTemplates();
    if (!templates.length) {
      new Notice(`No project templates in ${this.settings.templatesFolder} yet — a note with “planner_template: project” and steps such as “- [ ] Book the van [offset:: -14d]”.`, 10000);
      return;
    }
    const pick = (t: ProjectTemplate) =>
      new PromptModal(this.app, {
        title: `New project from “${t.name}”`,
        body: t.offsets ? `${t.steps} steps, ${t.offsets} of them dated from the ${t.from === "start" ? "day it starts" : "deadline"}.` : `${t.steps} steps.`,
        placeholder: "What the project is called",
        cta: t.from === "deadline" ? "Next: its deadline" : "Next",
        onSubmit: async (name) => {
          const deadline = await pickDate(this.app, null, this.settings.firstDayOfWeek, { selectedLabel: "Deadline" });
          if (deadline === undefined) return;
          await this.createProjectFromTemplate(t, name, deadline);
        },
      }).open();
    if (templates.length === 1) pick(templates[0]);
    else new ProjectTemplateSuggest(this.app, templates, pick).open();
  }

  /** The project note a template makes, opened. One step for Undo. */
  async createProjectFromTemplate(t: ProjectTemplate, name: string, deadline: string | null): Promise<void> {
    await this.act(async () => {
      const folder = this.settings.projectsFolder;
      const { text, dated } = projectNoteFromTemplate(t, { deadline, today: todayISO(), hub: folder.split("/").pop() ?? folder });
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      const base = sanitizeFilename(name) || "New project";
      let path = normalizePath(`${folder}/${base}.md`);
      for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${folder}/${base} ${n}.md`);
      const file = await createNote(this.app, path, text);
      void this.app.workspace.getLeaf(false).openFile(file);
      const left = t.offsets && !dated ? " — no deadline, so its steps have no dates" : dated ? `, ${dated} dated` : "";
      return `Started “${file.basename}” from ${t.name}: ${t.steps} step${t.steps === 1 ? "" : "s"}${left}`;
    });
  }

  /** A link from outside Obsidian — see uri.ts. */
  private async openLink(params: Record<string, string>): Promise<void> {
    const req = readUri(params);
    if (req.kind === "add") {
      if (req.window) return void new CaptureModal(this.app, this.store, this.settings, () => this.refreshViews()).withPreset({ title: req.text }).open();
      return this.act(async () => `Added: ${(await this.addFromText(req.text)).basename}`);
    }
    if (req.kind === "view") return this.openNamedView(req.view);
    if (req.kind === "unknown") return void new Notice(`Brewin Planner: ${req.reason}`);
    const path = this.findNote(req.note);
    if (!path || !this.store.getByPath(path)) return void new Notice(`Brewin Planner: no task note called “${req.note}”.`);
    if (req.kind === "edit") this.editPath(path);
    else this.openFocus(path);
  }

  /** A task from one line of words, read the way the capture box reads its title. */
  private async addFromText(text: string): Promise<TFile> {
    const p = parseCapture(text);
    return this.store.createTask({
      title: p.title || text.trim(),
      // A repeat needs a first day to count from.
      scheduled: p.date ?? (p.recurrence ? todayISO() : null),
      startTime: p.startTime,
      endTime: p.startTime ? p.endTime ?? addMinutesHM(p.startTime, this.settings.defaultTaskMinutes) : null,
      due: p.due,
      priority: p.priority ?? "normal",
      contexts: p.contexts,
      recurrence: p.recurrence,
      estimate: p.estimate,
    });
  }

  /** A dashboard view, the calendar, the time report, or the planning windows. */
  private async openNamedView(view: UriView): Promise<void> {
    if (view === "calendar") return this.activateCalendar();
    if (view === "time") return this.activateTime();
    if (view === "plan") return this.planDay();
    if (view === "shutdown") return this.shutDown();
    await this.activateView();
    for (const leaf of this.app.workspace.getLeavesOfType(BREWIN_VIEW_TYPE)) if (leaf.view instanceof DashboardView) leaf.view.showView(view);
  }

  /** A note a link names: its path, with or without `.md`, or a name Obsidian can resolve. */
  private findNote(name: string): string | null {
    const clean = normalizePath(name);
    for (const p of [clean, `${clean}.md`]) if (this.app.vault.getAbstractFileByPath(p) instanceof TFile) return p;
    return this.app.metadataCache.getFirstLinkpathDest(clean.replace(/\.md$/, ""), "")?.path ?? null;
  }

  /** A link to `file` as it would be written in a new task note (the user's link settings). */
  private linkFromTask(file: TFile): string {
    return this.app.fileManager.generateMarkdownLink(file, `${this.settings.itemsFolder}/${file.basename}.md`);
  }

  /**
   * "Make this line a Planner task": a task note from the line's words and dates, with a link back
   * to where it came from — and the line a link to it. One step for Undo: the note goes, the line returns.
   */
  private async lineToTask(ctx: MarkdownView | MarkdownFileInfo, file: TFile, line: number, raw: string, found: LineTask): Promise<void> {
    // What's on screen goes to disk first, so the line is rewritten where the note has it — and a
    // line that has changed since is left alone before anything is made.
    if (ctx instanceof MarkdownView) await ctx.save();
    if ((await this.app.vault.read(file)).split("\n")[line] !== raw) return void new Notice("That line has changed since — try again.");
    await this.act(async () => {
      const task = await this.store.createTask({
        title: plainText(found.words),
        scheduled: found.scheduled,
        due: found.due,
        priority: "normal",
        contexts: [],
        body: `From ${this.linkFromTask(file)}`,
      });
      let placed = false;
      await writeText(this.app, file, (text) => {
        const lines = text.split("\n");
        if (lines[line] !== raw) return text;
        lines[line] = found.lead + this.app.fileManager.generateMarkdownLink(task, file.path);
        placed = true;
        return lines.join("\n");
      });
      forgetNoteTasks(file.path);
      return placed ? `“${task.basename}” is a task now — the line links to it` : `“${task.basename}” is a task now — its line had changed, so it was left as it was`;
    });
  }

  /** "New task linked to this note": the task window, its notes starting with a link back here. */
  private newTaskFrom(file: TFile): void {
    const selected = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.getSelection().trim() ?? "";
    new CaptureModal(this.app, this.store, this.settings, () => this.refreshViews())
      .withPreset({ title: selected.includes("\n") ? "" : selected, notes: `From ${this.linkFromTask(file)}` })
      .open();
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
        await this.act(async () => {
          const n = await this.events.archivePastEvents(todayISO());
          return `Archived ${n} past event${n === 1 ? "" : "s"}`;
        });
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
      ...this.ics.items(today, today, { busyOnly: true }),
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

  /** What auto-scheduling did, in words. */
  autoScheduleMessage(res: { scheduled: number; unplaced: number }): string {
    if (!res.scheduled && !res.unplaced) return "No unscheduled tasks or no free time today.";
    return `Scheduled ${res.scheduled} task${res.scheduled === 1 ? "" : "s"}` + (res.unplaced ? ` · ${res.unplaced} didn't fit today` : "");
  }

  /** Open the create/edit window for the task note currently open. */
  editActive(): void {
    const file = this.app.workspace.getActiveFile();
    if (file) this.editPath(file.path);
  }

  /** A task's window — the same one the dashboard opens — for the note at `path`. */
  editPath(path: string): void {
    const task = this.store.getByPath(path);
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

  /** Plan my day: leftovers, the day's shape, what joins it, and its top three. */
  planDay(): void {
    new PlanDayModal(this.app, this).open();
  }

  /** Shut down: what got done, the top three's outcome, and an answer for what's still open. */
  shutDown(): void {
    new ShutdownModal(this.app, this).open();
  }

  /** The calendar on one day — its hour grid, with the "To plan" panel beside it. */
  async openCalendarDay(iso: string): Promise<void> {
    await this.activateCalendar();
    for (const leaf of this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)) {
      if (leaf.view instanceof CalendarView) leaf.view.showDay(iso);
    }
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
    if (this.refreshTimer !== null || this.unloaded) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.backlog.writeOwn(this.store.getTasks(), todayISO());
      void this.fileAwayDoneTasks();
      this.refreshViews();
    }, 300);
  }

  async loadSettings(): Promise<void> {
    // A copy of the defaults: merged as they are, a setting the saved data lacked would be the default's
    // own array, and pushing to it (a category, a fired reminder) changed the defaults themselves.
    // (A JSON copy, not structuredClone, which older iPhones' WebKit lacks.)
    this.settings = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as BrewinSettings, await this.loadData());
    // Folders as Obsidian spells paths — data synced from a Windows machine, or typed with a slash at
    // the end, otherwise matches no note at all.
    for (const key of FOLDER_KEYS) {
      const v = this.settings[key];
      this.settings[key] = (typeof v === "string" && cleanFolder(v)) || DEFAULT_SETTINGS[key];
    }
    // 1.67: the goal notes moved; an old install still pointed at where they used to be.
    if (this.settings.goalsFolder === "00_Systems/Calendar/Goals") this.settings.goalsFolder = DEFAULT_SETTINGS.goalsFolder;
    // Folders whose checkboxes are never tasks: a list of folders, cleaned the same way.
    const exclude = this.settings.noteTaskExclude as unknown;
    this.settings.noteTaskExclude = Array.isArray(exclude) ? exclude.flatMap((f) => (typeof f === "string" && cleanFolder(f) ? [cleanFolder(f)] : [])) : [...DEFAULT_SETTINGS.noteTaskExclude];
    for (const key of ["noteTasksDayNotes", "noteTasksDated"] as const) if (typeof this.settings[key] !== "boolean") this.settings[key] = DEFAULT_SETTINGS[key];
    // Other calendars: names, colours and switches only — their addresses live on each device.
    const cals = this.settings.icsCalendars as unknown;
    this.settings.icsCalendars = (Array.isArray(cals) ? cals : []).flatMap((raw): IcsCalendar[] => {
      const c = raw as Partial<IcsCalendar> | null;
      if (!c || typeof c.id !== "string") return [];
      const color = typeof c.color === "string" && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "#0ea5e9";
      return [{ id: c.id, name: String(c.name || NEW_CALENDAR_NAME), color, busy: c.busy !== false, show: c.show !== false }];
    });
    this.settings.statusFlags = sanitizeFlags(this.settings.statusFlags);
    this.settings.attributes = sanitizeAttributes(this.settings.attributes);
    // 1.60 keeps every view's list-or-board choice in one place; Week's and Projects' came first.
    this.settings.layouts = { ...(this.settings.layouts ?? {}) };
    this.settings.layouts.week ??= this.settings.weekLayout;
    this.settings.layouts.projects ??= this.settings.projectsLayout;
    this.settings.boardBy = { ...(this.settings.boardBy ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Statuses, attributes and folders shape how notes are read as tasks.
    this.store?.invalidate();
    // A new attribute gets its property type straight away (only where Obsidian has none).
    if (this.settings.attributes.length) void this.applyPropertyTypes({ quiet: true, attributesOnly: true });
  }
}

/** Which project template to start from. */
class ProjectTemplateSuggest extends FuzzySuggestModal<ProjectTemplate> {
  constructor(app: App, private templates: ProjectTemplate[], private choose: (t: ProjectTemplate) => void) {
    super(app);
    this.setPlaceholder("Which project template?");
  }
  getItems(): ProjectTemplate[] {
    return this.templates;
  }
  getItemText(t: ProjectTemplate): string {
    return `${t.name} — ${t.steps} step${t.steps === 1 ? "" : "s"}${t.offsets ? `, ${t.offsets} dated from the ${t.from}` : ""}`;
  }
  onChooseItem(t: ProjectTemplate): void {
    this.choose(t);
  }
}
