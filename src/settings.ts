import { App, PluginSettingTab, Setting } from "obsidian";
import type { CalView } from "./calendar";
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
}

export const DEFAULT_SETTINGS: BrewinSettings = {
  itemsFolder: "00_Systems/Tasks/Items",
  routinesFolder: "00_Systems/Tasks/Routines",
  doneFolder: "00_Systems/Tasks/Items/Done",
  projectsFolder: "03_Projects",
  eventsFolder: "00_Systems/Calendar/Events",
  eventsArchiveFolder: "00_Systems/Calendar/Events/Archived",
  tripsFolder: "04_Areas/Leisure/Trips",
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
}
