import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { CalView } from "./calendar";
import type { SavedFilter } from "./dashMenu";
import { BUILTIN_STATUSES, FLAG_SUGGESTIONS, flagText, moveFlag, StatusFlag, uniqueFlagId } from "./statusFlags";
import { ConfirmModal } from "./confirmModal";
import { PromptModal } from "./promptModal";
import type { Status } from "./types";
import { ATTR_KINDS, TaskAttribute } from "./attributes";
import { AttributeModal } from "./attributeModal";
import type BrewinTasksPlugin from "./main";

export interface Category {
  name: string;
  color: string; // hex
}

export interface BrewinSettings {
  itemsFolder: string;
  routinesFolder: string;
  doneFolder: string;
  projectsFolder: string;
  eventsFolder: string;
  eventsArchiveFolder: string;
  /** Scanned by the event modal's "Link trip…" picker. */
  tripsFolder: string;
  /** Where the task/event template library lives — one note per template. */
  templatesFolder: string;
  /** Show the "this month" task panel to the right of the Month calendar view. */
  showMonthTasks: boolean;
  /** Whether that month-tasks panel is expanded (persisted, like the other panels).
   *  Collapsed it's a thin strip — its fixed width makes the Month grid unusable on a phone. */
  monthTasksOpen: boolean;
  /** Show the "this week" task panel beside the Week calendar view — the loose bucket for
   *  tasks to do sometime this week, draggable onto a day or time slot. */
  showWeekTasks: boolean;
  /** Whether that week-tasks panel is expanded (persisted). */
  weekTasksOpen: boolean;
  hubNote: string;
  contexts: string[];
  categories: Category[];
  showProjectTasks: boolean;
  showCompleted: boolean;
  showTasksOnCalendar: boolean;
  showEventsOnCalendar: boolean;
  showProjectTasksOnCalendar: boolean;
  /** Event categories currently hidden on the calendar (toggled from the legend). */
  hiddenCategories: string[];
  /** Show the time-by-category panel in the calendar view. */
  showTimePanel: boolean;
  /** Whether that panel is expanded (persisted so it stays how you left it). */
  timePanelOpen: boolean;
  /** 0 = Sunday, 1 = Monday. */
  firstDayOfWeek: number;
  /** Which view the calendar pane opens on (month/week/day always reset to this — nothing persists it). */
  defaultCalendarView: CalView;
  /** Default block length (minutes) when a task is dropped onto a time slot. */
  defaultTaskMinutes: number;
  /** "Auto-schedule today" only ever searches within this window — never into the past. */
  autoScheduleStart: string; // "HH:MM"
  autoScheduleEnd: string; // "HH:MM"
  /** Week/Day grid resolution: one row per 60, 30 or 15 minutes. */
  timeSlotMinutes: 60 | 30 | 15;
  /** Hours a day you consider trackable — the denominator for unallocated time. */
  trackedDayHours: number;
  /** Include an "unallocated" slice in the time breakdown. */
  showUnallocated: boolean;
  /** Whether the ALL DAY band in Week/Day view is expanded (it eats phone screen). */
  allDayOpen: boolean;
  /** Block length on the hour grid for one time-slot of a multi-slot task. */
  slotBlockMinutes: number;
  /** Week view layout: a single list, or a column per day. */
  weekLayout: "list" | "board";
  /** Projects view layout: a single list, or a column per project. */
  projectsLayout: "list" | "board";
  /** Press-and-hold duration (ms) before an item becomes draggable. */
  dragHoldMs: number;

  // ── Reminders (foreground only — nothing fires while Obsidian is closed) ──
  remindersEnabled: boolean;
  /** Minutes of warning before a timed item. */
  reminderLeadMinutes: number;
  /** Also fire as the item begins. */
  reminderAtStart: boolean;
  /** How late a reminder may be and still fire, so a restart isn't an alarm storm. */
  reminderGraceMinutes: number;
  reminderSound: boolean;
  reminderVibrate: boolean;
  /** Desktop only: also raise a real OS notification, which reaches you when unfocused. */
  reminderSystemNotification: boolean;
  /** "HH:MM" morning summary of what's due; blank turns it off. */
  reminderDigestTime: string;
  /** Internal: ids already fired, pruned to today. */
  remindersFired: string[];

  // ── Cross-plugin backlog ───────────────────────────────────────────────────
  /** Where the shared backlog notes (this plugin's own + the sibling Brewin plugins') live. */
  accountabilityFolder: string;
  /** Fold Brewin Habits' and Brewin Fitness's backlog into the morning digest, not just tasks. */
  digestIncludeCrossPlugin: boolean;
  /** A fresh dashboard leaf opens on Attention instead of Today when there's backlog. Only
   *  checked once per leaf open — never yanks you off a tab you're already on. */
  dashboardDefaultToAttentionWhenBehind: boolean;

  // ── 1.51: phone-first review ────────────────────────────────────────────────
  /** Draw Brewin Fitness's active plan on the calendar and in Today. */
  trainingOnCalendar: boolean;
  /** When each of a day's sessions starts, in order — "06:15, 20:00" is morning then evening. */
  trainingTimes: string;
  /** How long a session block is drawn. */
  trainingMinutes: number;
  /** File done tasks into the Done folder this many days after completion; 0 turns it off. */
  autoArchiveDoneDays: number;
  /** Desktop only: dashboard and time report in the right sidebar. Phones always use the main area. */
  dashboardInSidebar: boolean;

  // ── 1.52: the dashboard's menu pane ─────────────────────────────────────────
  /** Wide screens: the menu folded to a rail of icons. A phone always uses the drawer instead. */
  menuCollapsed: boolean;
  /** The views in the menu, top to bottom. Empty means the default order. */
  menuOrder: string[];
  /** Menu entries the user has hidden, by key (`view:all`, `section:links`, `project:<path>`…). */
  menuHidden: string[];
  /** Menu sections folded shut, by id. */
  menuFolded: string[];
  /** Named dashboard states, in the order they were saved. */
  savedFilters: SavedFilter[];

  // ── 1.57: the user's own statuses ──────────────────────────────────────────
  /** Status flags, in menu order. Each stands for a built-in status — see `statusFlags.ts`. */
  statusFlags: StatusFlag[];

  // ── 1.58: the focus timer ───────────────────────────────────────────────────
  /** Each focus session also becomes a calendar event. */
  timerToCalendar: boolean;
  /** The event category (a subfolder of the events folder) focus sessions are filed under. */
  timerCategory: string;
  /** Closing a focus window while its clock runs asks first. */
  timerConfirmLeave: boolean;
  /** While a clock runs and its window is shut, a small timer floats over the workspace. */
  timerFloating: boolean;

  // ── 1.59: attributes of the user's own ─────────────────────────────────────
  /** Made from the task window; one frontmatter property each — see `attributes.ts`. */
  attributes: TaskAttribute[];

  // ── 1.60: a board for every view ────────────────────────────────────────────
  /** List or board, per view (`today`, `week`, `inbox`, `attention`, `all`, `projects`). */
  layouts: Record<string, "list" | "board">;
  /** What a view's board columns are (`BoardField`), per view. */
  boardBy: Record<string, string>;
  /** Today's ✅ Completed section is open. */
  todayDoneOpen: boolean;

  // ── 1.53: birthdays, from the people notes ─────────────────────────────────
  /** Where the people notes are; each one's `DOB::` line is its birthday. */
  peopleFolder: string;
  /** Draw birthdays on the calendar. */
  birthdaysOnCalendar: boolean;
  /** Name birthdays in the morning digest. */
  birthdayReminders: boolean;
  /** Days of warning before a birthday, as well as on the day itself; 0 is on the day only. */
  birthdayRemindDays: number;
}

export const DEFAULT_SETTINGS: BrewinSettings = {
  itemsFolder: "00_Systems/Tasks/Items",
  routinesFolder: "00_Systems/Tasks/Routines",
  doneFolder: "00_Systems/Tasks/Items/Done",
  projectsFolder: "03_Projects",
  eventsFolder: "00_Systems/Calendar/Events",
  eventsArchiveFolder: "00_Systems/Calendar/Events/Archived",
  tripsFolder: "04_Areas/Leisure/Trips",
  templatesFolder: "_Template/Planner",
  showMonthTasks: true,
  monthTasksOpen: true,
  showWeekTasks: true,
  weekTasksOpen: true,
  hubNote: "Brewin Tasks",
  contexts: ["home", "work", "shopping", "errand", "journal"],
  categories: [
    { name: "General", color: "#6b7280" },
    { name: "Personal", color: "#22c55e" }, // green
    { name: "Professional", color: "#3b82f6" }, // blue
    { name: "Social", color: "#ec4899" }, // pink
    { name: "Projects", color: "#f59e0b" }, // amber
    { name: "Archived", color: "#94a3b8" }, // grey — past events kept visible
  ],
  showProjectTasks: true,
  showCompleted: false,
  showTasksOnCalendar: true,
  showEventsOnCalendar: true,
  showProjectTasksOnCalendar: true,
  hiddenCategories: [],
  showTimePanel: true,
  timePanelOpen: true,
  firstDayOfWeek: 1,
  defaultCalendarView: "month",
  defaultTaskMinutes: 60,
  autoScheduleStart: "09:00",
  autoScheduleEnd: "18:00",
  timeSlotMinutes: 60,
  trackedDayHours: 16, // waking hours, so "unallocated" isn't dominated by sleep
  showUnallocated: true,
  allDayOpen: true,
  slotBlockMinutes: 15,
  weekLayout: "list",
  projectsLayout: "list",
  dragHoldMs: 450,
  trainingOnCalendar: true,
  trainingTimes: "06:15, 20:00",
  trainingMinutes: 45,
  autoArchiveDoneDays: 7,
  dashboardInSidebar: false,
  menuCollapsed: false,
  menuOrder: [],
  menuHidden: [],
  menuFolded: [],
  savedFilters: [],
  statusFlags: [],
  timerToCalendar: true,
  timerCategory: "Focus",
  timerConfirmLeave: true,
  timerFloating: true,
  attributes: [],
  layouts: {},
  boardBy: {},
  todayDoneOpen: false,
  peopleFolder: "04_Areas/People",
  birthdaysOnCalendar: true,
  birthdayReminders: true,
  birthdayRemindDays: 7,
  remindersEnabled: true,
  reminderLeadMinutes: 10,
  reminderAtStart: true,
  reminderGraceMinutes: 15,
  reminderSound: true,
  reminderVibrate: true,
  reminderSystemNotification: true,
  reminderDigestTime: "08:00",
  remindersFired: [],
  accountabilityFolder: "00_Systems/Accountability",
  digestIncludeCrossPlugin: true,
  dashboardDefaultToAttentionWhenBehind: true,
};

/** The category label used for the leftover slice in the time breakdown. */
export const UNALLOCATED = "Unallocated";

/** Pixel height of one hour at each grid resolution — finer slots get a taller hour. */
export const HOUR_PX_BY_SLOT: Record<number, number> = { 60: 44, 30: 72, 15: 120 };

/** The category name used to colour project tasks surfaced on the calendar. */
export const PROJECTS_CATEGORY = "Projects";

/** The category applied to archived events (kept visible, greyed). */
export const ARCHIVED_CATEGORY = "Archived";

/** Look up an event category's colour, defaulting to a neutral grey. */
export function categoryColor(settings: BrewinSettings, name: string): string {
  const c = settings.categories.find((x) => x.name.toLowerCase() === (name || "").toLowerCase());
  return c?.color ?? "#6b7280";
}

export class BrewinSettingTab extends PluginSettingTab {
  plugin: BrewinTasksPlugin;

  constructor(app: App, plugin: BrewinTasksPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Brewin Planner" });

    const folder = (name: string, desc: string, key: keyof BrewinSettings) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t
            .setValue(String(this.plugin.settings[key]))
            .onChange(async (v) => {
              (this.plugin.settings[key] as unknown as string) = v.trim();
              await this.plugin.saveSettings();
            })
        );

    folder("One-off tasks folder", "Where new task notes are created.", "itemsFolder");
    folder("Recurring tasks folder", "Where recurring task notes live.", "routinesFolder");
    folder("Done folder", "Where 'Archive done' moves completed one-offs.", "doneFolder");
    folder("Projects folder", "Scanned for #project notes to surface their tasks.", "projectsFolder");
    folder("Events folder", "Where calendar event notes live.", "eventsFolder");
    folder("Events archive folder", "Where 'Archive past events' moves past events. Keep it inside the Events folder to keep them visible on the calendar (greyed).", "eventsArchiveFolder");
    folder("Trips folder", "Scanned by the event modal's 'Link trip…' picker.", "tripsFolder");
    folder(
      "Templates folder",
      "The library of task and event templates — one note each, carrying `planner_template: event` or `: task`. Adding a note adds a template; a per-template command appears after a reload.",
      "templatesFolder"
    );

    new Setting(containerEl)
      .setName("Contexts")
      .setDesc("Comma-separated context tags offered on capture.")
      .addText((t) =>
        t.setValue(this.plugin.settings.contexts.join(", ")).onChange(async (v) => {
          this.plugin.settings.contexts = v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show project tasks")
      .setDesc("Surface open checkboxes from #project notes in the dashboard.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showProjectTasks).onChange(async (v) => {
          this.plugin.settings.showProjectTasks = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Show completed")
      .setDesc("Show a collapsible 'Done today' list in the dashboard.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showCompleted).onChange(async (v) => {
          this.plugin.settings.showCompleted = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Calendar layers")
      .setDesc("Tip: you can also toggle these — and individual event categories — by clicking the legend on the calendar.");

    new Setting(containerEl)
      .setName("Show tasks on calendar")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showTasksOnCalendar).onChange(async (v) => {
          this.plugin.settings.showTasksOnCalendar = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Show events on calendar")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showEventsOnCalendar).onChange(async (v) => {
          this.plugin.settings.showEventsOnCalendar = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Show 'this month' task panel")
      .setDesc("A panel beside the Month view for tasks to do sometime this month rather than on one day. Press-and-hold a row to drag it onto a day, or drag a task off the calendar onto the panel.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showMonthTasks).onChange(async (v) => {
          this.plugin.settings.showMonthTasks = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Show 'this week' task panel")
      .setDesc("A panel beside the Week view for tasks to do sometime this week. Press-and-hold a row to drag it onto a day or time slot, or drag a task off the calendar onto the panel.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showWeekTasks).onChange(async (v) => {
          this.plugin.settings.showWeekTasks = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Show time-by-category panel")
      .setDesc("A breakdown of tracked hours for the calendar range you're viewing.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showTimePanel).onChange(async (v) => {
          this.plugin.settings.showTimePanel = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Show project tasks on calendar")
      .setDesc("Overlay dated #project tasks (coloured as the Projects category); click one to open the project.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showProjectTasksOnCalendar).onChange(async (v) => {
          this.plugin.settings.showProjectTasksOnCalendar = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Show unallocated time")
      .setDesc("Include the time not covered by any event in the breakdown.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showUnallocated).onChange(async (v) => {
          this.plugin.settings.showUnallocated = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    containerEl.createEl("h3", { text: "Dashboard menu" });
    new Setting(containerEl)
      .setName("Fold the menu to icons")
      .setDesc("Wide screens only — the « at the foot of the menu does the same. A phone always opens it from ☰.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.menuCollapsed).onChange(async (v) => {
          this.plugin.settings.menuCollapsed = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );
    new Setting(containerEl)
      .setName("Reset the menu")
      .setDesc("Put the views back in their default order and show every hidden entry again. Saved filters are kept.")
      .addButton((b) =>
        b.setButtonText("Reset").onClick(async () => {
          this.plugin.settings.menuOrder = [];
          this.plugin.settings.menuHidden = [];
          this.plugin.settings.menuFolded = [];
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    this.displayStatusFlags(containerEl);
    this.displayTimer(containerEl);
    this.displayAttributes(containerEl);

    containerEl.createEl("h3", { text: "Birthdays" });
    new Setting(containerEl)
      .setName("People folder")
      .setDesc("Each note here is a person; the date in its DOB:: line is their birthday. Add Birthday:: hidden to a note to leave someone out.")
      .addText((t) =>
        t.setValue(this.plugin.settings.peopleFolder).onChange(async (v) => {
          this.plugin.settings.peopleFolder = v.trim().replace(/\/$/, "");
          await this.plugin.saveSettings();
          await this.plugin.birthdays.loadAll();
          this.plugin.refreshViews();
        })
      );
    new Setting(containerEl)
      .setName("Show birthdays on the calendar")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.birthdaysOnCalendar).onChange(async (v) => {
          this.plugin.settings.birthdaysOnCalendar = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );
    new Setting(containerEl)
      .setName("Birthdays in the morning digest")
      .setDesc("On the day, and a warning ahead of it. With the digest off, they get a notification of their own at 09:00.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.birthdayReminders).onChange(async (v) => {
          this.plugin.settings.birthdayReminders = v;
          this.plugin.reminders?.markStale();
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Days of warning")
      .setDesc("How many days before a birthday to mention it, to get a card or present in time. 0 is on the day only.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.birthdayRemindDays)).onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.birthdayRemindDays = Number.isFinite(n) && n >= 0 && n <= 60 ? Math.round(n) : 7;
          this.plugin.reminders?.markStale();
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Training (Brewin Fitness)" });
    new Setting(containerEl)
      .setName("Show the Fitness plan")
      .setDesc("Draw each day's sessions from Brewin Fitness's active plan on the calendar and in Today. Needs Brewin Fitness enabled.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.trainingOnCalendar).onChange(async (v) => {
          this.plugin.settings.trainingOnCalendar = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );
    new Setting(containerEl)
      .setName("Session times")
      .setDesc("When a day's sessions start, in order: morning first. A day with more sessions than times spaces the extras an hour apart.")
      .addText((tx) =>
        tx.setPlaceholder("06:15, 20:00").setValue(this.plugin.settings.trainingTimes).onChange(async (v) => {
          this.plugin.settings.trainingTimes = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );
    new Setting(containerEl)
      .setName("Session length (minutes)")
      .addText((tx) =>
        tx.setValue(String(this.plugin.settings.trainingMinutes)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 10 && n <= 300) {
            this.plugin.settings.trainingMinutes = Math.round(n);
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          }
        })
      );

    containerEl.createEl("h3", { text: "Housekeeping" });
    new Setting(containerEl)
      .setName("File done tasks after (days)")
      .setDesc("Completed tasks move to the Done folder this many days after they were ticked, so the Items folder holds only live work. 0 turns it off.")
      .addText((tx) =>
        tx.setValue(String(this.plugin.settings.autoArchiveDoneDays)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0 && n <= 365) {
            this.plugin.settings.autoArchiveDoneDays = Math.round(n);
            await this.plugin.saveSettings();
          }
        })
      );
    new Setting(containerEl)
      .setName("Dashboard in the right sidebar (desktop)")
      .setDesc("Phones always open the dashboard and time report in the main area.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.dashboardInSidebar).onChange(async (v) => {
          this.plugin.settings.dashboardInSidebar = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Reminders" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Foreground only: reminders fire while Obsidian is open. Nothing fires when the app is " +
        "closed, or backgrounded on Android — plugins get no background execution.",
    });

    new Setting(containerEl)
      .setName("Enable reminders")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.remindersEnabled).onChange(async (v) => {
          this.plugin.settings.remindersEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Remind me before")
      .setDesc("Minutes of warning. Override per item with `remind: 30m`, or silence one with `remind: none`.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.reminderLeadMinutes)).onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.reminderLeadMinutes = Number.isFinite(n) && n >= 0 && n <= 720 ? Math.round(n) : 10;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Also remind at the start")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.reminderAtStart).onChange(async (v) => {
          this.plugin.settings.reminderAtStart = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Ignore reminders older than")
      .setDesc("Minutes. Stops a launch after lunch replaying the whole morning.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.reminderGraceMinutes)).onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.reminderGraceMinutes = Number.isFinite(n) && n >= 0 ? Math.round(n) : 15;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Morning summary at")
      .setDesc("HH:MM digest of what's due today. Leave blank to turn it off.")
      .addText((t) =>
        t.setPlaceholder("08:00").setValue(this.plugin.settings.reminderDigestTime).onChange(async (v) => {
          const s = v.trim();
          this.plugin.settings.reminderDigestTime = s === "" || /^\d{1,2}:\d{2}$/.test(s) ? s : "08:00";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Play a sound")
      .setDesc("A short chime. Audio needs one tap anywhere in the app per session before it can play.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.reminderSound).onChange(async (v) => {
          this.plugin.settings.reminderSound = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Cross-plugin backlog" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "The morning digest and the Attention tab can also report what Brewin Habits and Brewin " +
        "Fitness say you're behind on, read from their shared backlog notes.",
    });

    new Setting(containerEl)
      .setName("Accountability folder")
      .setDesc("Where the shared backlog notes (this plugin's own + the sibling plugins') live.")
      .addText((t) =>
        t.setValue(this.plugin.settings.accountabilityFolder).onChange(async (v) => {
          this.plugin.settings.accountabilityFolder = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Digest includes habits & fitness")
      .setDesc("Turn off to go back to a tasks-only morning digest.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.digestIncludeCrossPlugin).onChange(async (v) => {
          this.plugin.settings.digestIncludeCrossPlugin = v;
          this.plugin.reminders?.markStale();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Default to Attention when behind")
      .setDesc("A freshly opened dashboard opens on the Attention tab instead of Today when there's backlog.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.dashboardDefaultToAttentionWhenBehind).onChange(async (v) => {
          this.plugin.settings.dashboardDefaultToAttentionWhenBehind = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Vibrate")
      .setDesc("Android, where the device supports it.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.reminderVibrate).onChange(async (v) => {
          this.plugin.settings.reminderVibrate = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Desktop system notification")
      .setDesc("Also raise an OS notification, so it reaches you when Obsidian isn't the focused window.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.reminderSystemNotification).onChange(async (v) => {
          this.plugin.settings.reminderSystemNotification = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Test a reminder")
      .setDesc("Fires one right now — the quickest way to check sound and permissions.")
      .addButton((b) => b.setButtonText("Test").onClick(() => this.plugin.reminders.testFire()));

    new Setting(containerEl)
      .setName("Hold to drag")
      .setDesc(
        "Milliseconds to press and hold before an item can be dragged. A plain tap always " +
          "opens the item instead. Lower is quicker; higher is harder to trigger by accident."
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.dragHoldMs)).onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.dragHoldMs = Number.isFinite(n) && n >= 100 && n <= 2000 ? Math.round(n) : 450;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Trackable hours per day")
      .setDesc("Your waking day — what unallocated time is measured against. Use 24 to count the whole day.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.trackedDayHours)).onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.trackedDayHours = Number.isFinite(n) && n > 0 && n <= 24 ? n : 16;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );


    new Setting(containerEl)
      .setName("Default task block length")
      .setDesc("Minutes given to a task dragged onto a calendar time slot.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.defaultTaskMinutes)).onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.defaultTaskMinutes = Number.isFinite(n) && n > 0 ? Math.round(n) : 60;
          await this.plugin.saveSettings();
        })
      );

    const timeOfDay = (name: string, desc: string, key: "autoScheduleStart" | "autoScheduleEnd", dflt: string) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setPlaceholder(dflt).setValue(this.plugin.settings[key]).onChange(async (v) => {
            const s = v.trim();
            this.plugin.settings[key] = /^\d{1,2}:\d{2}$/.test(s) ? s : dflt;
            await this.plugin.saveSettings();
          })
        );
    timeOfDay("Auto-schedule window start", "\"Auto-schedule today\" never places anything before this time.", "autoScheduleStart", "09:00");
    timeOfDay("Auto-schedule window end", "...or after this time.", "autoScheduleEnd", "18:00");

    new Setting(containerEl)
      .setName("Default calendar view")
      .setDesc("Which view the calendar pane opens on — it doesn't remember whatever you last left it on.")
      .addDropdown((d) =>
        d
          .addOption("month", "Month")
          .addOption("week", "Week")
          .addOption("day", "Day")
          .setValue(this.plugin.settings.defaultCalendarView)
          .onChange(async (v) => {
            this.plugin.settings.defaultCalendarView = v as CalView;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("First day of week")
      .setDesc("Used by the date picker.")
      .addDropdown((d) =>
        d
          .addOption("1", "Monday")
          .addOption("0", "Sunday")
          .setValue(String(this.plugin.settings.firstDayOfWeek))
          .onChange(async (v) => {
            this.plugin.settings.firstDayOfWeek = Number(v);
            await this.plugin.saveSettings();
          })
      );

    // ── Event categories (name + colour, add / remove) ──
    containerEl.createEl("h3", { text: "Event categories" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Colours events on the calendar. Add as many as you like — they appear in the event window's Category dropdown.",
    });

    this.plugin.settings.categories.forEach((cat, idx) => {
      const s = new Setting(containerEl);
      s.addText((t) =>
        t.setPlaceholder("Category name").setValue(cat.name).onChange(async (v) => {
          cat.name = v.trim();
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );
      s.addColorPicker((c) =>
        c.setValue(cat.color).onChange(async (v) => {
          cat.color = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );
      s.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("Remove category")
          .onClick(async () => {
            this.plugin.settings.categories.splice(idx, 1);
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
            this.display();
          })
      );
    });

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("＋ Add category")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.categories.push({ name: "New category", color: "#9c6ade" });
          await this.plugin.saveSettings();
          this.display();
        })
    );
  }

  // ── Statuses: the four built in, and the user's own flags ──────────────────────────────

  private displayStatusFlags(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    containerEl.createEl("h3", { text: "Statuses" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Four statuses are built in. Add your own when they aren't enough: each one acts as one of the four, so it is " +
        "listed and counted exactly like it, but shows its own icon and name on the task, in the ⋯ menu and the edit " +
        "window, and in the dashboard menu's Statuses section. Notes keep the built-in status in “status:” and yours in “flag:”.",
    });
    const builtIn = containerEl.createEl("ul", { cls: "setting-item-description brewin-status-builtins" });
    for (const b of BUILTIN_STATUSES) builtIn.createEl("li", { text: `${b.icon} ${b.label} — ${b.meaning}` });

    const tasks = this.plugin.store.getTasks();
    const save = async () => {
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
    };
    const baseLabel = (b: Status) => BUILTIN_STATUSES.find((x) => x.id === b)?.label ?? b;
    const plural = (n: number) => `${n} task${n === 1 ? "" : "s"}`;

    settings.statusFlags.forEach((flag, idx) => {
      const using = tasks.filter((t) => t.flag?.id === flag.id);
      const row = new Setting(containerEl).setName(flagText(flag)).setDesc(`Saved as flag: ${flag.id} · ${using.length ? plural(using.length) : "no tasks yet"}`);
      row.settingEl.addClass("brewin-flag-setting");
      row.addText((t) => {
        t.inputEl.addClass("brewin-flag-icon");
        t.inputEl.setAttr("aria-label", "Icon");
        t.setPlaceholder("🏷").setValue(flag.icon).onChange(async (v) => {
          flag.icon = v.trim() || "🏷";
          row.setName(flagText(flag));
          await save();
        });
      });
      row.addText((t) => {
        t.inputEl.setAttr("aria-label", "Name");
        t.setPlaceholder("Name").setValue(flag.label).onChange(async (v) => {
          flag.label = v.trim() || flag.id;
          row.setName(flagText(flag));
          await save();
        });
      });
      row.addDropdown((d) => {
        for (const b of BUILTIN_STATUSES) d.addOption(b.id, `acts as ${b.label}`);
        d.setValue(flag.base).onChange((v) => {
          const base = v as Status;
          const move = async () => {
            flag.base = base;
            await this.plugin.saveSettings();
            // Its tasks follow it to the new status — that is what changing it means.
            let refused = 0;
            for (const t of using) {
              if (await this.plugin.store.setFlag({ ...t, flag: null }, flag)) {
                refused++;
                await this.plugin.store.clearFlag(t);
              }
            }
            if (refused) new Notice(`${plural(refused)} couldn't become ${baseLabel(base)} (repeating, or with open subtasks) and lost the ${flag.label} status.`);
            this.plugin.refreshViews();
            this.display();
          };
          if (!using.length) return void move();
          new ConfirmModal(this.app, {
            title: `${flagText(flag)} acts as ${baseLabel(base)}?`,
            body: `${plural(using.length)} ${using.length === 1 ? "is" : "are"} ${flag.label} now. ${using.length === 1 ? "It" : "They"} will become ${baseLabel(base)} too.`,
            cta: "Change it",
            onConfirm: () => void move(),
          }).open();
          d.setValue(flag.base); // until confirmed
        });
      });
      row.addExtraButton((b) =>
        b.setIcon("arrow-up").setTooltip("Move up").setDisabled(idx === 0).onClick(async () => {
          settings.statusFlags = moveFlag(settings.statusFlags, flag.id, -1);
          await save();
          this.display();
        })
      );
      row.addExtraButton((b) =>
        b.setIcon("arrow-down").setTooltip("Move down").setDisabled(idx === settings.statusFlags.length - 1).onClick(async () => {
          settings.statusFlags = moveFlag(settings.statusFlags, flag.id, 1);
          await save();
          this.display();
        })
      );
      row.addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Remove this status").onClick(() => {
          const remove = async () => {
            for (const t of using) await this.plugin.store.clearFlag(t);
            settings.statusFlags = settings.statusFlags.filter((f) => f.id !== flag.id);
            settings.savedFilters = settings.savedFilters.map((f) => (f.flag === flag.id ? { ...f, flag: null } : f));
            settings.menuHidden = settings.menuHidden.filter((k) => k !== `flag:${flag.id}`);
            await save();
            this.display();
          };
          if (!using.length) return void remove();
          new ConfirmModal(this.app, {
            title: `Remove ${flagText(flag)}?`,
            body: `${plural(using.length)} ${using.length === 1 ? "has" : "have"} it. ${using.length === 1 ? "It stays" : "They stay"} ${baseLabel(flag.base)}, without the ${flag.label} label.`,
            cta: "Remove",
            onConfirm: () => void remove(),
          }).open();
        })
      );
    });

    const add = (flag: StatusFlag) => {
      settings.statusFlags = [...settings.statusFlags, flag];
      void save().then(() => this.display());
    };
    new Setting(containerEl)
      .setName("Add a status")
      .setDesc("Its name is fixed into your notes as `flag:` when you add it; renaming it later keeps every task.")
      .addButton((b) =>
        b
          .setButtonText("＋ Add a status")
          .setCta()
          .onClick(() =>
            new PromptModal(this.app, {
              title: "New status",
              body: "What is it called? You can pick its icon and what it acts as next.",
              placeholder: "In review",
              cta: "Add",
              onSubmit: (name) => {
                const label = name.trim();
                if (label) add({ id: uniqueFlagId(label, settings.statusFlags), label, icon: "🏷", base: "todo" });
              },
            }).open()
          )
      );
    const ideas = FLAG_SUGGESTIONS.filter((f) => !settings.statusFlags.some((x) => x.id === f.id));
    if (ideas.length) {
      const row = new Setting(containerEl).setName("Or start from one of these").setDesc(ideas.map((f) => `${flagText(f)} acts as ${baseLabel(f.base)}`).join(" · "));
      for (const f of ideas) row.addButton((b) => b.setButtonText(`＋ ${flagText(f)}`).onClick(() => add({ ...f })));
    }
  }

  // ── The focus timer ──────────────────────────────────────────────────────────

  private displayTimer(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
    };
    containerEl.createEl("h3", { text: "Focus timer" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "⏱ on a task opens its focus window: a clock you start, pause and finish, the time logged against the " +
        "estimate, and every session. Sessions are saved on the task note (time_log, time_spent).",
    });
    new Setting(containerEl)
      .setName("Ask before leaving a running timer")
      .setDesc("Closing the focus window while its clock runs asks whether to stay. Leaving never stops the clock.")
      .addToggle((t) => t.setValue(s.timerConfirmLeave).onChange(async (v) => { s.timerConfirmLeave = v; await save(); }));
    new Setting(containerEl)
      .setName("Floating timer")
      .setDesc("While a clock runs and its window is shut, a small timer stays on screen, over any note. Tap it to go back.")
      .addToggle((t) => t.setValue(s.timerFloating).onChange(async (v) => { s.timerFloating = v; await save(); this.plugin.floating?.update(); }));
    new Setting(containerEl)
      .setName("Add sessions to the calendar")
      .setDesc("Each session also becomes an event, so the Calendar shows when you worked and the Time report counts it.")
      .addToggle((t) => t.setValue(s.timerToCalendar).onChange(async (v) => { s.timerToCalendar = v; await save(); }));
    new Setting(containerEl)
      .setName("Calendar category")
      .setDesc("The event category sessions are filed under — its own folder of the events folder, and its own colour.")
      .addText((t) =>
        t.setPlaceholder("Focus").setValue(s.timerCategory).onChange(async (v) => {
          s.timerCategory = v.trim() || "Focus";
          await save();
        })
      );
  }

  // ── Attributes of the user's own ─────────────────────────────────────────────

  private displayAttributes(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
    };
    containerEl.createEl("h3", { text: "Attributes" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Your own fields on tasks — a cost, a client, a room. Make one with “＋ Add attribute…” in any task's window or " +
        "here; each is a property on the task's note, filled in from the task window, shown on rows if you like, listed " +
        "in the dashboard menu to filter by (drop a task on a value to set it), a way to group All, and found by search.",
    });
    const tasks = this.plugin.store.getTasks();
    settings.attributes.forEach((attr, idx) => {
      const using = tasks.filter((t) => t.attrs?.[attr.key] !== undefined).length;
      const kind = ATTR_KINDS.find((k) => k.kind === attr.kind)!;
      const row = new Setting(containerEl)
        .setName(`${attr.icon} ${attr.label}`)
        .setDesc(`${kind.label} · saved as ${attr.key}: · ${using ? `${using} task${using === 1 ? "" : "s"}` : "no tasks yet"}`);
      row.settingEl.addClass("brewin-flag-setting");
      row.addText((t) => {
        t.inputEl.addClass("brewin-flag-icon");
        t.inputEl.setAttr("aria-label", "Icon");
        t.setValue(attr.icon).onChange(async (v) => {
          attr.icon = v.trim() || kind.icon;
          row.setName(`${attr.icon} ${attr.label}`);
          await save();
        });
      });
      row.addText((t) => {
        t.inputEl.setAttr("aria-label", "Name");
        t.setValue(attr.label).onChange(async (v) => {
          attr.label = v.trim() || attr.key;
          row.setName(`${attr.icon} ${attr.label}`);
          await save();
        });
      });
      if (attr.kind === "number")
        row.addText((t) => {
          t.inputEl.addClass("brewin-flag-icon");
          t.inputEl.setAttr("aria-label", "Unit");
          t.setPlaceholder("unit").setValue(attr.unit ?? "").onChange(async (v) => {
            attr.unit = v.trim() || undefined;
            await save();
          });
        });
      if (attr.kind === "choice")
        row.addText((t) => {
          t.inputEl.setAttr("aria-label", "Choices, separated by commas");
          t.setPlaceholder("choices, comma separated").setValue((attr.options ?? []).join(", ")).onChange(async (v) => {
            attr.options = [...new Set(v.split(",").map((o) => o.trim()).filter(Boolean))];
            await save();
          });
        });
      row.addToggle((t) => {
        t.setTooltip("Show on task rows");
        t.setValue(attr.onRow).onChange(async (v) => {
          attr.onRow = v;
          await save();
        });
      });
      row.addExtraButton((b) =>
        b.setIcon("arrow-up").setTooltip("Move up").setDisabled(idx === 0).onClick(async () => {
          const list = settings.attributes;
          [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
          await save();
          this.display();
        })
      );
      row.addExtraButton((b) =>
        b.setIcon("arrow-down").setTooltip("Move down").setDisabled(idx === settings.attributes.length - 1).onClick(async () => {
          const list = settings.attributes;
          [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
          await save();
          this.display();
        })
      );
      row.addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Remove this attribute").onClick(() => {
          const remove = async () => {
            settings.attributes = settings.attributes.filter((a) => a.key !== attr.key);
            settings.savedFilters = settings.savedFilters.map((f) => (f.attr?.key === attr.key ? { ...f, attr: null } : f));
            settings.menuHidden = settings.menuHidden.filter((k) => !k.startsWith(`attrval:${attr.key}=`) && k !== `section:attr:${attr.key}`);
            await save();
            this.display();
          };
          if (!using) return void remove();
          new ConfirmModal(this.app, {
            title: `Remove ${attr.icon} ${attr.label}?`,
            body: `${using} task${using === 1 ? " has" : "s have"} a value. The values stay in the notes, as the property “${attr.key}”, but the Planner stops showing and offering it. Adding an attribute with the same name later brings them back.`,
            cta: "Remove",
            onConfirm: () => void remove(),
          }).open();
        })
      );
    });
    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("＋ Add attribute")
        .setCta()
        .onClick(() =>
          new AttributeModal(this.app, settings.attributes, async (attr) => {
            settings.attributes.push(attr);
            await save();
            this.display();
          }).open()
        )
    );
  }
}
