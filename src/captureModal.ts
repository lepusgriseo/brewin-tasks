import { App, Menu, Modal, Notice, Setting, TFile } from "obsidian";
import { pickDate } from "./datePicker";
import { addDays, addMinutesHM, formatHM, formatISO, minutesOfDay, todayISO, todayUTC } from "./dates";
import { Priority, Status, Task, TaskSlot } from "./types";
import { BUILTIN_STATUSES, flagRefusal, flagText, StatusFlag } from "./statusFlags";
import { AttrValue, linkName, parseAttrInput, readAttr, TaskAttribute } from "./attributes";
import { AttributeModal } from "./attributeModal";
import { TripSuggestModal } from "./tripSuggestModal";
import { TaskStore } from "./taskStore";
import { BrewinSettings } from "./settings";
import { RECUR_PRESETS } from "./recurrencePresets";
import { setCount, setUntil, stripEnd } from "./rrule";
import { formatSlot, parseSlot, parseSlots, slotTitle } from "./slots";
import { readRepeatEnd, spanOf } from "./views";
import { buildContextIndex, parseContexts, toggleContext } from "./contexts";
import { formatEstimate, parseEstimate } from "./estimate";
import { PlannerTemplate, resolveTask } from "./plannerTemplate";
import { TemplateStore } from "./templateStore";
import { templateNoteFromTask } from "./plannerTemplate";
import { PromptModal } from "./promptModal";
import { parseCapture } from "./nlp";
import { previewTimes, parseRemindField, parseRemindStart } from "./reminders";
import { TaskSuggestModal } from "./taskSuggestModal";
import { DeleteTaskModal } from "./deleteTaskModal";
import { buildIndex, childrenOf, validParentCandidates } from "./hierarchy";
import { validDependencyCandidates } from "./dependencies";
import { RecurrenceScopeModal } from "./recurrenceScopeModal";
import { toWikilink } from "./task";
import { ProjectTaskSource } from "./projectTasks";
import { ProjectSuggestModal } from "./projectSuggestModal";
import { addChecklistItem, checklistItems, setChecklistItem } from "./checklist";
import { isSubmitKey } from "./a11y";

/** Create-or-edit a task: title + scheduled/due via date-picker + priority + context + repeat. */
export class CaptureModal extends Modal {
  /** Whether "More options" was last left open — remembered for the session. */
  private static moreOpen = false;
  /** Opens a task's focus window — set by the plugin, which owns the timer. */
  static openFocus: ((path: string) => void) | null = null;
  /** "Skip this time" for a repeating task, with Undo — set by the plugin. */
  static skip: ((task: Task) => Promise<void>) | null = null;
  /** Saves settings (a new attribute, a new choice) and redraws the Planner — set by the plugin. */
  static saveSettings: (() => Promise<void>) | null = null;
  /** The user's own attributes on this task: current values, and which ones were changed here. */
  private attrValues: Record<string, AttrValue | null> = {};
  private attrTouched = new Set<string>();
  /** The attributes this task's note has (and any added here) — the only ones the window shows. */
  private attrShown = new Set<string>();
  private title = "";
  private scheduled: string | null = null;
  private due: string | null = null;
  /** Effort estimate in minutes. */
  private estimate: number | null = null;
  /** True while the modal is redrawing itself, to stop blur handlers re-entering. */
  private rerendering = false;
  /** The template library, when one was handed in — drives the picker at the top. */
  private templateLib: TemplateStore | null = null;
  /** The template this task is being created from, if any. */
  private template: PlannerTemplate | null = null;
  /** Reminder override mode for this item. */
  private remindMode: "default" | "custom" | "off" = "default";
  private remindLead = 10;
  private remindStart = true;
  /** Inclusive last day of a multi-day task. */
  private endDate: string | null = null;
  /** How the repeat ends: never, on a date, or after N occurrences. */
  private repeatEnd: "never" | "on" | "after" = "never";
  private repeatUntil: string | null = null;
  private repeatCount = 10;
  /** Whether this task occupies a time block rather than the all-day row. */
  private timed = false;
  private startTime = "09:00";
  private endTime = "10:00";
  private priority: Priority = "normal";
  private contexts: string[] = [];
  private notes = "";
  /** True once the user has typed in the notes box (guards the async body load). */
  private notesDirty = false;
  /** The checklist block was asked for, though the notes have no boxes yet. */
  private checklistAsked = false;
  /** Snapshots used to leave the file untouched when nothing actually changed. */
  private originalTitle = "";
  private originalBody = "";
  private recurrence = "";
  /** What a repeat's next date counts from (`recurrence_from`). */
  private recurrenceFrom: "schedule" | "completion" = "schedule";
  private status: Status = "todo";
  /** One of the user's status flags, chosen in the Status dropdown — it sets `status` too. */
  private flag: StatusFlag | null = null;
  private existing?: Task;
  /** Parent wikilink (e.g. `[[Ship v2]]`), or null for a top-level task. */
  private parent: string | null = null;
  private parentTitle: string | null = null;
  /** Project wikilink (e.g. `[[Smart home]]`), or null when the task belongs to no project. */
  private project: string | null = null;
  private projectTitle: string | null = null;
  /** Subtask titles queued for creation on save. */
  private newSubtasks: string[] = [];
  /** Fixed times this task repeats at within a day. */
  private times: TaskSlot[] = [];
  /** Tasks this one depends on — blocks completion only. Kept as path+link pairs so a
   *  dependency can be removed by path without re-deriving its wikilink from the store. */
  private dependsOn: { path: string; link: string }[] = [];
  /** For a recurring task: which occurrence was actually clicked — the scope prompt on save
   *  needs this, not the series' own anchor date. */
  private occurrenceISO?: string;

  constructor(
    app: App,
    private store: TaskStore,
    private settings: BrewinSettings,
    private onCreated: () => void,
    existing?: Task,
    /** Invoked once this window closes — used to hop back to a parent task. */
    private returnTo?: () => void,
    /** Prefills a brand-new task's schedule — ignored when editing an existing one. */
    preset?: { scheduled: string; startTime?: string; endTime?: string },
    occurrenceISO?: string
  ) {
    super(app);
    if (existing) {
      this.occurrenceISO = existing.recurrence
        ? occurrenceISO ?? (existing.recurrenceAnchor === "due" ? existing.due : existing.scheduled) ?? undefined
        : undefined;
      this.existing = existing;
      this.title = existing.title;
      this.originalTitle = existing.title;
      this.scheduled = existing.scheduled;
      this.due = existing.due;
      this.timed = !!existing.startTime;
      if (existing.startTime) this.startTime = existing.startTime;
      if (existing.endTime) this.endTime = existing.endTime;
      this.priority = existing.priority;
      this.contexts = [...existing.contexts];
      this.recurrence = existing.recurrence ?? "";
      this.recurrenceFrom = existing.recurrenceFrom ?? "schedule";
      this.estimate = existing.estimate ?? null;
      const parsedRemind = parseRemindField(existing.remind);
      this.remindMode = parsedRemind.off ? "off" : parsedRemind.minutes != null ? "custom" : "default";
      this.remindLead = parsedRemind.minutes ?? this.settings.reminderLeadMinutes;
      this.remindStart = parseRemindStart(existing.remindStart) ?? this.settings.reminderAtStart;
      this.endDate = existing.endDate ?? null;
      const end = readRepeatEnd(existing.recurrence);
      this.repeatEnd = end.kind;
      this.repeatUntil = end.until;
      this.repeatCount = end.count ?? 10;
      this.times = [...(existing.times ?? [])];
      this.status = existing.status;
      this.flag = existing.flag ?? null;
      this.attrValues = { ...(existing.attrs ?? {}) };
      this.attrShown = new Set(existing.attrKeys ?? Object.keys(existing.attrs ?? {}));
      this.parent = existing.parent;
      this.project = existing.project ?? null;
      this.projectTitle = existing.projectPath ? existing.projectPath.split("/").pop()?.replace(/\.md$/, "") ?? null : null;
      if (existing.parentPath) {
        this.parentTitle = this.store.getByPath(existing.parentPath)?.title ?? null;
      }
      this.dependsOn = (existing.dependsOnPaths ?? []).map((path) => ({
        path,
        link: toWikilink(path.split("/").pop()?.replace(/\.md$/, "") ?? path),
      }));
    } else if (preset) {
      this.scheduled = preset.scheduled;
      if (preset.startTime) {
        this.timed = true;
        this.startTime = preset.startTime;
        this.endTime = preset.endTime ?? addMinutesHM(preset.startTime, this.settings.defaultTaskMinutes);
      }
    }
  }

  onOpen(): void {
    this.modalEl.addClass("brewin-capture-modal");
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.existing ? "Edit task" : "New task" });
    this.renderTemplatePicker(contentEl);

    // Title
    const titleInput = contentEl.createEl("input", {
      type: "text",
      cls: "brewin-capture-title",
      // The title understands dates, times, repeats and sigils — the placeholder says so.
      placeholder: this.existing ? "What needs doing?" : "e.g. Call bank tomorrow 2pm @home !high",
    });
    titleInput.value = this.title;
    titleInput.setAttr("aria-label", "Task title");
    titleInput.addEventListener("keydown", (e) => {
      if (!isSubmitKey(e)) return; // not while an IME is still choosing the word
      applyNL(true); // fold the sentence into fields before it's written
      if (this.title.trim()) this.save();
    });
    // ── Natural language ──
    // The title box doubles as a command line: "Bins out every monday at 7pm @home ~10m".
    // Nothing is applied silently — the preview below states exactly what was understood,
    // and the fields it fills stay editable, so a wrong guess is visible and correctable.
    // What the title box understood is said as it is typed, not only shown.
    const nlHint = contentEl.createDiv({ cls: "brewin-nl-hint", attr: { "aria-live": "polite" } });
    const applyNL = (commit: boolean) => {
      // Emptying contentEl during a rerender fires blur on the old input; without this the
      // rerender would re-enter applyNL and loop.
      if (this.rerendering) return;
      const parsed = parseCapture(titleInput.value);
      if (!parsed.matched.length) {
        nlHint.empty();
        this.title = titleInput.value;
        return;
      }
      nlHint.empty();
      nlHint.createSpan({ cls: "brewin-nl-arrow", text: "→" });
      nlHint.createSpan({ cls: "brewin-nl-title", text: parsed.title || "(no title)" });
      for (const m of parsed.matched) nlHint.createSpan({ cls: "brewin-nl-tag", text: m.label });

      if (!commit) return;
      // Applied on blur / save, not on every keystroke — rewriting the box mid-sentence
      // would fight the typist.
      this.title = parsed.title;
      titleInput.value = parsed.title;
      if (parsed.date) this.scheduled = parsed.date;
      if (parsed.due) this.due = parsed.due;
      if (parsed.startTime) {
        this.timed = true;
        this.startTime = parsed.startTime;
        this.endTime = parsed.endTime ?? addMinutesHM(parsed.startTime, this.settings.defaultTaskMinutes);
      }
      if (parsed.recurrence) {
        this.recurrence = parsed.recurrence;
        this.recurrenceFrom = parsed.recurrenceFrom ?? "schedule";
      }
      if (parsed.priority) this.priority = parsed.priority;
      if (parsed.estimate != null) this.estimate = parsed.estimate;
      if (parsed.contexts.length) {
        this.contexts = [...new Set([...this.contexts, ...parsed.contexts])];
      }
      nlHint.empty();
      this.rerender();
    };

    titleInput.addEventListener("input", () => {
      this.title = titleInput.value;
      applyNL(false);
    });
    titleInput.addEventListener("blur", () => applyNL(true));
    // Words given from outside (a link, a selection) say what was understood in them straight away.
    if (!this.existing && this.title) applyNL(false);
    window.setTimeout(() => titleInput.focus(), 0);

    // Date chips
    const dateRow = contentEl.createDiv({ cls: "brewin-capture-dates" });
    const schedBtn = dateRow.createEl("button", { cls: "brewin-chip" });
    const endBtn = dateRow.createEl("button", { cls: "brewin-chip" });
    const dueBtn = dateRow.createEl("button", { cls: "brewin-chip" });
    const renderDates = () => {
      schedBtn.setText(this.scheduled ? `📅 ${this.scheduled}` : "📅 Schedule");
      // The end date is meaningless without a start, so it stays disabled until there is one.
      endBtn.setText(this.endDate ? `→ ${this.endDate}` : "→ Ends");
      endBtn.toggleClass("brewin-chip-disabled", !this.scheduled);
      dueBtn.setText(this.due ? `🚩 ${this.due}` : "🚩 Due");
      schedBtn.toggleClass("brewin-chip-set", !!this.scheduled);
      endBtn.toggleClass("brewin-chip-set", !!this.endDate);
      dueBtn.toggleClass("brewin-chip-set", !!this.due);
      const span = spanOf(this.scheduled, this.endDate);
      spanNote.setText(span > 1 ? `Runs ${span} days, ${this.scheduled} → ${this.endDate} inclusive.` : "");
    };
    const spanNote = contentEl.createDiv({ cls: "brewin-modal-note brewin-span-note" });
    renderDates();
    endBtn.addEventListener("click", async () => {
      if (!this.scheduled) {
        new Notice("Give the task a start date first.");
        return;
      }
      const r = await pickDate(this.app, this.endDate ?? this.scheduled, this.settings.firstDayOfWeek, {
        selectedLabel: "Ends",
        relatedISO: this.scheduled,
        relatedLabel: "Starts",
      });
      if (r !== undefined) {
        // A backwards range is a slip, not a zero-day task — refuse it rather than storing it.
        if (r && r < this.scheduled) {
          new Notice("The end date can't be before the start.");
        } else {
          this.endDate = r && r > this.scheduled ? r : null;
        }
      }
      renderDates();
    });
    schedBtn.addEventListener("click", async () => {
      const r = await pickDate(this.app, this.scheduled, this.settings.firstDayOfWeek, {
        selectedLabel: "Scheduled",
        relatedISO: this.due,
        relatedLabel: "Due",
      });
      if (r !== undefined) {
        this.scheduled = r;
        // Moving the start past the end would leave a backwards span behind.
        if (this.endDate && (!r || this.endDate <= r)) this.endDate = null;
      }
      renderDates();
    });
    dueBtn.addEventListener("click", async () => {
      const r = await pickDate(this.app, this.due, this.settings.firstDayOfWeek, {
        selectedLabel: "Due",
        relatedISO: this.scheduled,
        relatedLabel: "Scheduled",
      });
      if (r !== undefined) this.due = r;
      renderDates();
    });

    // Quick schedule shortcuts
    const quick = contentEl.createDiv({ cls: "brewin-capture-quick" });
    const today = todayUTC();
    const q = (label: string, d: Date | null) =>
      quick.createEl("button", { text: label, cls: "brewin-chip-mini" }).addEventListener("click", () => {
        this.scheduled = d ? formatISO(d) : null;
        renderDates();
      });
    q("Today", today);
    q("Tomorrow", addDays(today, 1));
    q("Next week", addDays(today, 7));
    q("Unplanned", null);

    // ── Time block (optional) — turns the task into a block on the calendar ──
    const timeWrap = contentEl.createDiv();
    const renderTimes = () => timeWrap.toggleClass("brewin-hidden", !this.timed);
    new Setting(contentEl)
      .setName("Set a time")
      .setDesc("Give it a slot on the calendar instead of the all-day row.")
      .addToggle((t) =>
        t.setValue(this.timed).onChange((v) => {
          this.timed = v;
          if (v && !this.scheduled) {
            // A time block needs a day — default to today.
            this.scheduled = todayISO();
            renderDates();
          }
          renderTimes();
        })
      );
    const times = timeWrap.createDiv({ cls: "brewin-time-row" });
    const startIn = times.createEl("input", { type: "time", attr: { "aria-label": "Starts at" } });
    startIn.value = this.startTime;
    startIn.addEventListener("input", () => (this.startTime = startIn.value));
    times.createSpan({ text: " → ", attr: { "aria-hidden": "true" } });
    const endIn = times.createEl("input", { type: "time", attr: { "aria-label": "Ends at" } });
    endIn.value = this.endTime;
    endIn.addEventListener("input", () => (this.endTime = endIn.value));
    renderTimes();

    // Priority
    new Setting(contentEl).setName("Priority").addDropdown((d) =>
      d
        .addOption("low", "Low")
        .addOption("normal", "Normal")
        .addOption("high", "High")
        .setValue(this.priority)
        .onChange((v) => (this.priority = v as Priority))
    );

    // Status (edit mode only): the four built in, then the user's own flags from settings.
    if (this.existing) {
      const recurrence = this.existing.recurrence;
      const flags = this.settings.statusFlags.filter((f) => !flagRefusal({ recurrence, flag: null }, f));
      new Setting(contentEl).setName("Status").addDropdown((d) => {
        d.addOption("todo", "To do")
          .addOption("hold", "On hold")
          .addOption("someday", "Someday — no date, no nagging")
          .addOption("done", "Done");
        for (const f of flags) d.addOption(`flag:${f.id}`, `${flagText(f)} — ${BUILTIN_STATUSES.find((b) => b.id === f.base)?.label.toLowerCase()}`);
        d.setValue(this.flag ? `flag:${this.flag.id}` : this.status).onChange((v) => {
          this.flag = flags.find((f) => `flag:${f.id}` === v) ?? null;
          this.status = this.flag ? this.flag.base : (v as Status);
        });
      });
    }

    // Attributes of the user's own — every one they have made, and "＋ Add attribute…" for another.
    this.renderAttrs(contentEl.createDiv({ cls: "brewin-attrs" }));


    const advA = contentEl.childElementCount;
    // ── Reminder ──
    // `remind:` and `remind_start:` were readable only by hand-editing frontmatter until now.
    // The preview line states the actual clock times, so the setting isn't abstract.
    const remindSetting = new Setting(contentEl)
      .setName("Reminder")
      .setDesc("Uses the global setting unless you override it here.");
    const remindWrap = remindSetting.controlEl.createDiv({ cls: "brewin-remind-row" });
    const remindMode = remindWrap.createEl("select");
    remindMode.createEl("option", { text: "Default", value: "default" });
    remindMode.createEl("option", { text: "Custom", value: "custom" });
    remindMode.createEl("option", { text: "Off", value: "off" });
    const remindLead = remindWrap.createEl("input", { type: "number", cls: "brewin-remind-lead" });
    remindLead.min = "0";
    remindLead.title = "Minutes of warning";
    remindWrap.createSpan({ cls: "brewin-remind-unit", text: "min before" });
    const startLabel = remindWrap.createEl("label", { cls: "brewin-remind-start" });
    const startBox = startLabel.createEl("input", { type: "checkbox" });
    startLabel.createSpan({ text: "also at the start" });
    const remindPreview = contentEl.createDiv({ cls: "brewin-modal-note brewin-remind-preview" });

    const renderRemind = () => {
      const off = this.remindMode === "off";
      const custom = this.remindMode === "custom";
      remindMode.value = this.remindMode;
      remindLead.toggleClass("brewin-hidden", !custom);
      startLabel.toggleClass("brewin-hidden", !custom);
      remindWrap.querySelector<HTMLElement>(".brewin-remind-unit")?.toggleClass("brewin-hidden", !custom);
      remindLead.value = String(this.remindLead);
      startBox.checked = this.remindStart;

      const at = minutesOfDay(this.timed ? this.startTime : null);
      if (off) {
        remindPreview.setText("No reminders for this one.");
        return;
      }
      if (at == null) {
        remindPreview.setText("Give it a time and the reminder times will show here.");
        return;
      }
      const times = previewTimes(
        at,
        custom ? this.remindLead : null,
        custom ? this.remindStart : null,
        false,
        this.settings.reminderLeadMinutes,
        this.settings.reminderAtStart
      );
      remindPreview.setText(
        times.length
          ? "Reminds at " + times.map((x) => formatHM(x.minutes)).join(" and ")
          : "No reminders \u2014 warning is 0 and 'at the start' is off."
      );
    };
    remindMode.addEventListener("change", () => {
      this.remindMode = remindMode.value as "default" | "custom" | "off";
      renderRemind();
    });
    remindLead.addEventListener("input", () => {
      const n = Number(remindLead.value);
      this.remindLead = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
      renderRemind();
    });
    startBox.addEventListener("change", () => {
      this.remindStart = startBox.checked;
      renderRemind();
    });
    renderRemind();

    // ── Estimate ──
    new Setting(contentEl)
      .setName("Estimate")
      .setDesc("How long you think it'll take. Today compares the day's estimates against its free time.")
      .addText((t) => {
        t.setPlaceholder("30m · 1h · 1h30");
        if (this.estimate) t.setValue(formatEstimate(this.estimate));
        t.onChange((v) => {
          this.estimate = v.trim() ? parseEstimate(v) : null;
        });
        t.inputEl.addEventListener("blur", () => {
          // Show it back in the canonical form so "90" reads as "1h 30m".
          t.setValue(formatEstimate(this.estimate));
        });
      });

    // ── Context ──
    // Free text drifts: this vault already holds `obsidian` and `Obsidian` as separate
    // values. Typing either now stores the spelling the vault actually uses most, and the
    // chips make picking an existing one easier than retyping it.
    const ctxIndex = buildContextIndex(
      this.store.getTasks().flatMap((t) => t.contexts),
      this.settings.contexts
    );
    this.contexts = parseContexts(this.contexts.join(", "), ctxIndex);

    let ctxInput: HTMLInputElement | null = null;
    let renderChips = () => {};

    const advAEnd = contentEl.childElementCount;
    new Setting(contentEl).setName("Context").addText((t) => {
      ctxInput = t.inputEl;
      t.setPlaceholder(ctxIndex.suggestions.slice(0, 3).join(", ") || "home, work");
      if (this.contexts.length) t.setValue(this.contexts.join(", "));

      // Native autocomplete over every known context.
      const listId = "brewin-ctx-" + Math.random().toString(36).slice(2, 8);
      const datalist = contentEl.createEl("datalist");
      datalist.id = listId;
      ctxIndex.suggestions.forEach((c) => datalist.createEl("option", { value: c }));
      t.inputEl.setAttr("list", listId);

      t.onChange((v) => {
        // Parse loosely while typing — snapping mid-word would fight the user.
        this.contexts = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        renderChips();
      });
      // Canonicalise once the field is left, so "Obsidian" settles to "obsidian".
      t.inputEl.addEventListener("blur", () => {
        this.contexts = parseContexts(this.contexts.join(", "), ctxIndex);
        t.setValue(this.contexts.join(", "));
        renderChips();
      });
    });

    const chips = contentEl.createDiv({ cls: "brewin-ctx-chips" });
    // Your most-used contexts first, ten of them; the rest a tap away. Nineteen chips took about a
    // third of a phone screen before Notes. Any context already on the task always shows.
    let showAllContexts = false;
    renderChips = () => {
      chips.empty();
      const active = new Set(this.contexts.map((c) => c.toLowerCase()));
      const all = ctxIndex.suggestions;
      const shown = showAllContexts ? all : all.filter((c, i) => i < 10 || active.has(c.toLowerCase()));
      for (const c of shown) {
        const on = active.has(c.toLowerCase());
        const chip = chips.createEl("button", {
          cls: "brewin-chip-mini" + (on ? " brewin-chip-set" : ""),
          text: c,
        });
        const uses = ctxIndex.counts.get(c) ?? 0;
        chip.setAttr("aria-label", uses ? `${c} — used ${uses} time${uses === 1 ? "" : "s"}` : `${c} — unused`);
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          this.contexts = toggleContext(this.contexts, c, ctxIndex);
          if (ctxInput) ctxInput.value = this.contexts.join(", ");
          renderChips();
        });
      }
      const hidden = all.length - shown.length;
      if (hidden > 0) {
        const more = chips.createEl("button", { cls: "brewin-chip-mini brewin-chip-more", text: `+${hidden}` });
        more.setAttr("aria-label", `Show ${hidden} more context${hidden === 1 ? "" : "s"}`);
        more.addEventListener("click", (e) => {
          e.preventDefault();
          showAllContexts = true;
          renderChips();
        });
      }
    };
    renderChips();

    // Repeat
    const advB = contentEl.childElementCount;
    new Setting(contentEl)
      .setName("Repeat")
      .setDesc("Recurring tasks re-arm on completion.")
      .addDropdown((d) => {
        RECUR_PRESETS.forEach((p) => d.addOption(p.value, p.label));
        d.setValue(this.recurrence).onChange((v) => {
          this.recurrence = v;
          renderRepeatEnd();
        });
      });
    // What the next date counts from: the schedule, or the day it was last done.
    const fromSetting = new Setting(contentEl)
      .setName("Counted from")
      .setDesc("“When it's done”: every 3 days after you last did it, however late that was.")
      .addDropdown((d) => {
        d.addOption("schedule", "Its schedule");
        d.addOption("completion", "When it's done");
        d.setValue(this.recurrenceFrom).onChange((v) => (this.recurrenceFrom = v === "completion" ? "completion" : "schedule"));
      });

    // ── When the repeat stops ──
    // Without this the only way to end a series was to delete the note, which also threw
    // away its history.
    const endSetting = new Setting(contentEl).setName("Ends").setDesc("When the repeat stops.");
    const endWrap = endSetting.controlEl.createDiv({ cls: "brewin-repeat-end" });
    const endSel = endWrap.createEl("select");
    endSel.createEl("option", { text: "Never", value: "never" });
    endSel.createEl("option", { text: "On a date", value: "on" });
    endSel.createEl("option", { text: "After N times", value: "after" });
    const untilBtn = endWrap.createEl("button", { cls: "brewin-chip" });
    const countInput = endWrap.createEl("input", { type: "number", cls: "brewin-repeat-count" });
    countInput.min = "1";

    const renderRepeatEnd = () => {
      // An end, and what the dates count from, only mean something for a series.
      endSetting.settingEl.toggleClass("brewin-hidden", !this.recurrence);
      fromSetting.settingEl.toggleClass("brewin-hidden", !this.recurrence);
      endSel.value = this.repeatEnd;
      untilBtn.toggleClass("brewin-hidden", this.repeatEnd !== "on");
      countInput.toggleClass("brewin-hidden", this.repeatEnd !== "after");
      untilBtn.setText(this.repeatUntil ? `📅 ${this.repeatUntil}` : "📅 Pick a date");
      untilBtn.toggleClass("brewin-chip-set", !!this.repeatUntil);
      countInput.value = String(this.repeatCount);
    };
    endSel.addEventListener("change", () => {
      this.repeatEnd = endSel.value as "never" | "on" | "after";
      renderRepeatEnd();
    });
    untilBtn.addEventListener("click", async () => {
      const r = await pickDate(this.app, this.repeatUntil, this.settings.firstDayOfWeek, {
        selectedLabel: "Repeat ends",
        relatedISO: this.scheduled,
        relatedLabel: "Starts",
      });
      if (r !== undefined) this.repeatUntil = r;
      renderRepeatEnd();
    });
    countInput.addEventListener("input", () => {
      const n = Number(countInput.value);
      this.repeatCount = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    });
    renderRepeatEnd();

    // ── Times of day ──
    // Several fixed times within one day ("litter tray: morning, afternoon, evening").
    // The day only closes once the LAST slot is ticked; then the task rolls to tomorrow.
    new Setting(contentEl)
      .setName("Times of day")
      .setDesc("Repeat at fixed times each day. The day is done when the last one is ticked.");

    const slotList = contentEl.createDiv({ cls: "brewin-slot-list" });
    const renderSlots = () => {
      slotList.empty();
      if (!this.times.length) {
        slotList.createDiv({ cls: "brewin-slot-empty", text: "No fixed times — an ordinary task." });
      }
      this.times.forEach((slot, i) => {
        const row = slotList.createDiv({ cls: "brewin-slot-item" });
        row.createSpan({ text: slotTitle(slot) });
        const del = row.createEl("button", { text: "✕" });
        del.setAttr("aria-label", `Remove ${slotTitle(slot)}`);
        del.addEventListener("click", () => {
          this.times.splice(i, 1);
          renderSlots();
        });
      });
    };
    renderSlots();

    const slotInput = contentEl.createEl("input", {
      cls: "brewin-slot-input",
      placeholder: "08:00 Morning — press Enter to add…",
      attr: { "aria-label": "Add a time of day, like 08:00 Morning" },
    });
    const addSlot = () => {
      const parsed = parseSlot(slotInput.value);
      if (!parsed) {
        if (slotInput.value.trim()) new Notice("Use HH:MM, optionally followed by a name.");
        return;
      }
      if (this.times.some((s) => s.time === parsed.time)) {
        new Notice(`There's already a slot at ${parsed.time}.`);
        slotInput.value = "";
        return;
      }
      // Re-parse the whole list so it stays sorted and normalised exactly as stored.
      this.times = parseSlots([...this.times, parsed].map(formatSlot));
      slotInput.value = "";
      renderSlots();
    };
    slotInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (!isSubmitKey(e)) return;
      e.preventDefault();
      addSlot();
    });

    // ── Project ──
    // For a task NOTE that belongs to a project; the project's own checkbox lines stay in its note.
    const projectSetting = new Setting(contentEl).setName("Project");
    const projectBtn = projectSetting.controlEl.createEl("button", { cls: "brewin-chip" });
    const renderProject = () => {
      projectBtn.setText(this.projectTitle ? `⚡ ${this.projectTitle}` : "No project");
      projectBtn.toggleClass("brewin-chip-set", !!this.project);
    };
    renderProject();
    projectBtn.addEventListener("click", () => {
      const projects = new ProjectTaskSource(this.app, this.settings).listProjects(true);
      new ProjectSuggestModal(this.app, projects, (picked) => {
        this.project = toWikilink(picked.name);
        this.projectTitle = picked.name;
        renderProject();
      }).open();
    });
    projectSetting.addExtraButton((b) =>
      b.setIcon("x").setTooltip("No project").onClick(() => {
        this.project = null;
        this.projectTitle = null;
        renderProject();
      })
    );

    // ── Parent task ──
    const parentSetting = new Setting(contentEl).setName("Parent task");
    const parentBtn = parentSetting.controlEl.createEl("button", { cls: "brewin-chip" });
    const renderParent = () => {
      parentBtn.setText(this.parentTitle ? `↳ ${this.parentTitle}` : "No parent");
      parentBtn.toggleClass("brewin-chip-set", !!this.parent);
    };
    renderParent();
    parentBtn.addEventListener("click", () => {
      const all = this.store.getTasks().filter((t) => t.status !== "done");
      const index = buildIndex(this.store.getTasks());
      // Exclude self + descendants so a cycle can't be picked.
      const candidates = validParentCandidates(index, this.existing ?? null, all);
      new TaskSuggestModal(this.app, candidates, (picked) => {
        this.parent = toWikilink(picked.path.split("/").pop()?.replace(/\.md$/, "") ?? picked.title);
        this.parentTitle = picked.title;
        renderParent();
      }).open();
    });
    parentSetting.addExtraButton((b) =>
      b.setIcon("x").setTooltip("Clear parent").onClick(() => {
        this.parent = null;
        this.parentTitle = null;
        renderParent();
      })
    );

    // ── Depends on ──
    // Blocks completion only — confirmed with the user, no effect on dates or scheduling.
    new Setting(contentEl).setName("Depends on").setDesc("Can't be marked done until these are.");
    const depsWrap = contentEl.createDiv({ cls: "brewin-ctx-chips" });
    const renderDeps = () => {
      depsWrap.empty();
      for (const dep of this.dependsOn) {
        const title = this.store.getByPath(dep.path)?.title ?? dep.path;
        const chip = depsWrap.createEl("button", { cls: "brewin-chip-mini brewin-chip-set", text: `⛓ ${title} ✕` });
        chip.setAttr("aria-label", `Remove dependency on ${title}`);
        chip.addEventListener("click", () => {
          this.dependsOn = this.dependsOn.filter((d) => d.path !== dep.path);
          renderDeps();
        });
      }
      const add = depsWrap.createEl("button", { cls: "brewin-chip-mini", text: "+ Add dependency" });
      add.addEventListener("click", () => {
        const all = this.store.getTasks().filter((t) => t.status !== "done");
        // Reflects dependencies added/removed THIS session, not just what was loaded at open —
        // otherwise adding two dependencies in a row could miss a cycle between them.
        const draft = this.existing ? { ...this.existing, dependsOnPaths: this.dependsOn.map((d) => d.path) } : null;
        const candidates = validDependencyCandidates(all, draft);
        new TaskSuggestModal(this.app, candidates, (picked) => {
          this.dependsOn.push({
            path: picked.path,
            link: toWikilink(picked.path.split("/").pop()?.replace(/\.md$/, "") ?? picked.title),
          });
          renderDeps();
        }, "Depends on…").open();
      });
    };
    renderDeps();

    // ── Subtasks ──
    contentEl.createEl("div", { cls: "brewin-subtasks-label", text: "Subtasks" });
    const existingKids = this.existing ? childrenOf(buildIndex(this.store.getTasks()), this.existing) : [];
    if (existingKids.length) {
      const list = contentEl.createDiv({ cls: "brewin-subtask-list" });
      for (const k of existingKids) {
        const row = list.createDiv({
          cls: "brewin-subtask-item brewin-subtask-open" + (k.status === "done" ? " done" : ""),
        });
        row.createSpan({ text: (k.status === "done" ? "✓ " : "☐ ") + k.title });
        row.createSpan({ cls: "brewin-subtask-chevron", text: "›" });
        row.setAttr("aria-label", "Edit this subtask");
        row.addEventListener("click", () => this.editSubtask(k));
      }
    }
    const pending = contentEl.createDiv({ cls: "brewin-subtask-list" });
    const renderPending = () => {
      pending.empty();
      this.newSubtasks.forEach((t, i) => {
        const row = pending.createDiv({ cls: "brewin-subtask-item brewin-subtask-new" });
        row.createSpan({ text: "☐ " + t });
        const del = row.createEl("button", { cls: "brewin-icon-btn", text: "✕" });
        del.addEventListener("click", () => {
          this.newSubtasks.splice(i, 1);
          renderPending();
        });
      });
    };
    const subInput = contentEl.createEl("input", {
      type: "text",
      cls: "brewin-subtask-input",
      placeholder: "Add a subtask, press Enter…",
      attr: { "aria-label": "Add a subtask" },
    });
    subInput.addEventListener("keydown", (e) => {
      if (!isSubmitKey(e)) return;
      e.preventDefault();
      e.stopPropagation(); // don't trigger the modal's save-on-Enter
      const v = subInput.value.trim();
      if (!v) return;
      this.newSubtasks.push(v);
      subInput.value = "";
      renderPending();
    });
    renderPending();

    const advBEnd = contentEl.childElementCount;

    // ── Checklist ──
    // The boxes in the notes, shown as boxes. Ticking or adding one changes the notes box below,
    // which stays the one source and is written with Save.
    const checklist = contentEl.createDiv({ cls: "brewin-checklist" });
    // Notes — the note body (loaded asynchronously when editing)
    const notes = contentEl.createEl("textarea", {
      cls: "brewin-capture-notes",
      placeholder: "Notes (optional)…",
      attr: { "aria-label": "Notes" },
    });
    notes.value = this.notes;
    const setNotes = (text: string) => {
      this.notes = text;
      this.notesDirty = true;
      notes.value = text;
      renderChecklist();
    };
    const renderChecklist = (focusInput = false) => {
      checklist.empty();
      const items = checklistItems(this.notes);
      if (!items.length && !this.checklistAsked) {
        checklist.createEl("button", { cls: "brewin-chip-mini", text: "☑ Add a checklist" }).addEventListener("click", () => {
          this.checklistAsked = true;
          renderChecklist(true);
        });
        return;
      }
      const done = items.filter((i) => i.done).length;
      checklist.createDiv({ cls: "brewin-subtasks-label", text: items.length ? `Checklist · ${done}/${items.length}` : "Checklist" });
      for (const item of items) {
        const row = checklist.createEl("label", { cls: "brewin-checklist-item" + (item.done ? " done" : "") });
        const box = row.createEl("input", { type: "checkbox" });
        box.checked = item.done;
        box.addEventListener("change", () => {
          const next = setChecklistItem(this.notes, item, box.checked);
          if (next !== null) setNotes(next);
        });
        row.createSpan({ text: item.text });
      }
      const input = checklist.createEl("input", {
        type: "text",
        cls: "brewin-subtask-input",
        placeholder: "Add an item, press Enter…",
        attr: { "aria-label": "Add a checklist item" },
      });
      input.addEventListener("keydown", (e) => {
        if (!isSubmitKey(e)) return;
        e.preventDefault();
        e.stopPropagation(); // don't trigger the modal's save-on-Enter
        if (!input.value.trim()) return;
        setNotes(addChecklistItem(this.notes, input.value));
        checklist.querySelector<HTMLInputElement>("input[type=text]")?.focus();
      });
      if (focusInput) input.focus();
    };
    renderChecklist();
    notes.addEventListener("input", () => {
      this.notes = notes.value;
      this.notesDirty = true;
      renderChecklist();
    });
    if (this.existing) {
      void this.store.getBody(this.existing).then((body) => {
        // Don't clobber anything typed while the read was in flight.
        if (this.notesDirty) return;
        this.notes = body;
        this.originalBody = body;
        notes.value = body;
        renderChecklist();
      });
    }

    // ── More options ──
    // The form ran to ~2,000px on a phone with Save at the very bottom, while estimate, reminder,
    // parent and dependencies were each used on a handful of tasks. They fold away here, and open
    // by themselves whenever the task actually uses one.
    const advanced = [
      ...Array.from(contentEl.children).slice(advA, advAEnd),
      ...Array.from(contentEl.children).slice(advB, advBEnd),
    ];
    const uses =
      this.remindMode !== "default" ||
      this.estimate != null ||
      !!this.recurrence ||
      this.times.length > 0 ||
      !!this.parent ||
      !!this.project ||
      this.dependsOn.length > 0 ||
      this.newSubtasks.length > 0 ||
      existingKids.length > 0;
    const moreToggle = contentEl.createEl("button", { cls: "brewin-more-toggle" });
    const more = contentEl.createDiv({ cls: "brewin-more" });
    advanced.forEach((el) => more.appendChild(el));
    const open = uses || CaptureModal.moreOpen;
    const paint = (on: boolean) => {
      more.toggleClass("brewin-collapsed", !on);
      moreToggle.setText(on ? "Fewer options ▴" : "More options ▾ — repeat, reminder, estimate, project, parent, subtasks");
    };
    paint(open);
    moreToggle.addEventListener("click", () => {
      const on = more.hasClass("brewin-collapsed");
      CaptureModal.moreOpen = on;
      paint(on);
    });

    // Buttons
    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    if (this.existing) {
      const del = btns.createEl("button", { text: "🗑", cls: "brewin-delete-btn" });
      del.setAttr("aria-label", "Delete task");
      del.addEventListener("click", () => this.deleteTask());
    }
    // An existing task's focus window, on top of this one: closing it comes back here.
    const existing = this.existing;
    if (existing && CaptureModal.openFocus) {
      const focus = btns.createEl("button", { text: "⏱ Focus timer", cls: "brewin-capture-focus" });
      focus.addEventListener("click", () => CaptureModal.openFocus?.(existing.path));
    }
    // A repeating task's current time let go — not done, not missed — and on to its next date.
    if (existing?.recurrence && existing.status !== "done" && CaptureModal.skip) {
      const skip = btns.createEl("button", { text: "⏭ Skip this time" });
      skip.setAttr("aria-label", "Skip this time — on to its next date, not counted as missed");
      skip.addEventListener("click", () => {
        this.close();
        void CaptureModal.skip?.(existing);
      });
    }
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    if (this.existing) {
      btns.createEl("button", { text: "Open note" }).addEventListener("click", () => this.openNote());
    }
    if (this.templateLib) {
      const asTpl = btns.createEl("button", { text: "Save as template" });
      asTpl.setAttr("aria-label", "Make a reusable template from these settings");
      asTpl.addEventListener("click", () => this.saveAsTemplate());
    }
    const saveBtn = btns.createEl("button", { text: this.existing ? "Save" : "Add task", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());

    contentEl.createEl("div", {
      cls: "brewin-capture-hint",
      text: this.existing ? "Edit any field, then Save" : "Enter to add · ⌘/Ctrl+Enter also works",
    });
  }

  /** The `remind:` / `remind_start:` pair this control represents. */
  /**
   * Start a NEW task inside a project and/or with contexts already on it — what the dashboard
   * does when you press ＋ while looking at one project or one context — or with its title and
   * notes written (an editor command, a link from outside Obsidian). Ignored when editing.
   */
  withPreset(p: { project?: { link: string; name: string } | null; contexts?: string[]; title?: string; notes?: string }): this {
    if (this.existing) return this;
    if (p.title) this.title = p.title;
    if (p.notes) this.notes = p.notes;
    if (p.project) {
      this.project = p.project.link;
      this.projectTitle = p.project.name;
    }
    if (p.contexts?.length) this.contexts = [...new Set([...this.contexts, ...p.contexts])];
    return this;
  }

  /** Offer the template library here. Chainable, so the constructor's call sites are untouched. */
  withTemplateLibrary(store: TemplateStore): this {
    this.templateLib = store;
    return this;
  }

  /**
   * Prefill from a library template. Ignored when editing an existing task.
   *
   * Only keys the template sets are touched. Note that a task template with no date leaves the
   * task unscheduled on purpose — see `resolveTask` — because silently scheduling work for today
   * puts things in front of you that you never asked for.
   */
  applyTemplate(t: PlannerTemplate | null, override?: { startTime?: string }): this {
    if (this.existing || !t || t.kind !== "task") return this;
    this.template = t;
    const r = resolveTask(t, { date: this.scheduled ?? todayISO(), defaultMinutes: this.settings.defaultTaskMinutes, startTime: override?.startTime });
    if (r.title) this.title = r.title;
    if (r.scheduled) this.scheduled = r.scheduled;
    if (r.due) this.due = r.due;
    if (r.endDate) this.endDate = r.endDate;
    if (r.startTime) {
      this.timed = true;
      this.startTime = r.startTime;
      this.endTime = r.endTime ?? addMinutesHM(r.startTime, this.settings.defaultTaskMinutes);
    }
    if (r.priority) this.priority = r.priority;
    if (r.contexts?.length) this.contexts = [...r.contexts];
    if (r.estimate != null) this.estimate = r.estimate;
    if (r.times?.length) this.times = [...r.times];
    if (r.parent) this.parent = r.parent;
    if (r.recurrence) {
      this.recurrence = stripEnd(r.recurrence);
    }
    if (r.remind) {
      const pr = parseRemindField(r.remind);
      this.remindMode = pr.off ? "off" : pr.minutes != null ? "custom" : "default";
      if (pr.minutes != null) this.remindLead = pr.minutes;
    }
    if (r.remindStart !== undefined) this.remindStart = r.remindStart;

    // The body is not in the metadata cache, so it arrives a tick later — the same pattern the
    // edit path already uses. Never overwrite something the user has typed.
    if (this.templateLib) {
      void this.templateLib.bodyOf(t).then((body) => {
        if (body && !this.notesDirty && !this.notes.trim()) {
          this.notes = body;
          this.rerender();
        }
      });
    }
    return this;
  }

  /** The picker, shown only for a new task and only when the library has task templates. */
  private renderTemplatePicker(parent: HTMLElement): void {
    const library = this.templateLib?.list("task") ?? [];
    if (this.existing || library.length === 0) return;
    new Setting(parent)
      .setName("From template")
      .setDesc("Prefills the fields below. Choosing one does not undo edits you have already made.")
      .addDropdown((d) => {
        d.addOption("", "— none —");
        library.forEach((tpl) => d.addOption(tpl.name, tpl.name));
        d.setValue(this.template?.name ?? "").onChange((name) => {
          if (!name) {
            this.template = null;
            return;
          }
          this.applyTemplate(library.find((tpl) => tpl.name === name) ?? null);
          this.rerender();
        });
      });
  }

  /**
   * Turn what is on screen into a reusable template — the times picked with the control already in
   * front of you rather than typed as YAML. The notes box becomes the template's body, so a
   * checklist carries over. No date is saved.
   */
  private saveAsTemplate(): void {
    const lib = this.templateLib;
    if (!lib) return;
    new PromptModal(this.app, {
      title: "Save as template",
      body: "The times and settings above are kept, and the notes become the template's body. The date is not kept — a task made from this template starts unscheduled unless the template says otherwise.",
      placeholder: "Prep work bag, Weekly review…",
      initial: this.title.trim(),
      cta: "Save template",
      onSubmit: async (name) => {
        const r = this.remindFields();
        const text = templateNoteFromTask(name, {
          title: this.title.trim() || name,
          priority: this.priority,
          contexts: this.contexts,
          estimate: this.estimate,
          startTime: this.timed ? this.startTime : null,
          endTime: this.timed ? this.endTime : null,
          recurrence: this.recurrence || null,
          remind: r.remind,
          remindStart: r.remindStart,
          times: this.times,
          body: this.notes,
        });
        await lib.save(name, text);
        new Notice(`Template saved: ${name}. It needs a reload to get its own command.`);
        this.rerender();
      },
    }).open();
  }

  private remindFields(): { remind: string | null; remindStart: boolean | null } {
    if (this.remindMode === "off") return { remind: "none", remindStart: null };
    if (this.remindMode === "custom") {
      return { remind: `${this.remindLead}m`, remindStart: this.remindStart };
    }
    return { remind: null, remindStart: null }; // default → store nothing
  }

  private async save(): Promise<void> {
    const title = this.title.trim();
    if (!title) {
      new Notice("Task needs a title");
      return;
    }
    // A recurring task needs an anchor date; default to today if none was picked.
    const scheduled = this.recurrence && !this.scheduled ? todayISO() : this.scheduled;
    // Combine the preset with the chosen ending. `stripEnd` first, so switching from
    // "on a date" back to "never" actually clears the old UNTIL rather than layering.
    let recurrence = this.recurrence || null;
    if (recurrence) {
      const base = stripEnd(recurrence);
      if (this.repeatEnd === "on" && this.repeatUntil) recurrence = setUntil(base, this.repeatUntil);
      else if (this.repeatEnd === "after") recurrence = setCount(base, this.repeatCount);
      else recurrence = base;
    }
    const dependsOn = this.dependsOn.map((d) => d.link);

    if (this.existing) {
      // Honour the hierarchy invariant when the Status dropdown is set to Done.
      if (this.status === "done" && this.existing.status !== "done") {
        const check = this.store.checkComplete(this.existing);
        if (!check.ok) {
          const reasons = [
            check.open ? `${check.open} subtask${check.open === 1 ? "" : "s"} still open` : null,
            check.blocked ? `waiting on ${check.blocked} other task${check.blocked === 1 ? "" : "s"}` : null,
          ]
            .filter((r): r is string => !!r)
            .join(" and ");
          new Notice(`Can't mark "${title}" done — ${reasons}.`);
          return;
        }
      }

      if (this.existing.recurrence) {
        const existingTask = this.existing;
        const occ = this.occurrenceISO ?? existingTask.scheduled ?? existingTask.due ?? todayISO();
        const fields = {
          title,
          scheduled,
          startTime: this.timed ? this.startTime : null,
          endTime: this.timed ? this.endTime : null,
          due: this.due,
          priority: this.priority,
          contexts: this.contexts,
          parent: this.parent,
          project: this.project,
          recurrence,
          recurrenceAnchor: "scheduled" as const,
          recurrenceFrom: this.recurrenceFrom,
          endDate: this.endDate,
          estimate: this.estimate,
          ...this.remindFields(),
          times: this.times,
          dependsOn,
        };
        new RecurrenceScopeModal(
          this.app,
          async (scope) => {
            if (!scope) return; // cancelled — leave the task modal open
            if (scope === "all") {
              // The only scope that stays on the SAME note — rename/body/subtasks still apply.
              const titleChanged = title !== this.originalTitle;
              let target = existingTask;
              if (titleChanged) {
                const newPath = await this.store.rename(target, title);
                if (newPath) target = { ...target, path: newPath, title };
              }
              const movedPath = await this.store.applyRecurringEdit(target, occ, "all", fields);
              if (movedPath !== target.path) target = { ...target, path: movedPath };
              await this.saveAttrs(target.path);
              const bodyChanged = this.notes.trim() !== this.originalBody.trim();
              if (titleChanged || bodyChanged) {
                await this.store.setBody(target, this.notes, titleChanged ? title : undefined);
              }
              for (const sub of this.newSubtasks) await this.store.addSubtask(target, sub);
              new Notice(`Updated: ${title} — every occurrence.`);
            } else {
              await this.store.applyRecurringEdit(existingTask, occ, scope, fields);
              new Notice(
                scope === "single"
                  ? `"${title}" updated — this occurrence only (${occ}).`
                  : `"${title}" and later occurrences updated.`
              );
            }
            this.onCreated();
          },
          {
            title: "Edit recurring task",
            prompt: `"${existingTask.title}" repeats. Apply this change to…`,
            labels: {
              single: `This occurrence only (${occ})`,
              following: "This and all following occurrences",
              all: "Every occurrence — the whole series",
            },
          }
        ).open();
        this.close();
        return;
      }

      // Renaming happens first: the file IS the title, and Obsidian repoints inbound
      // links (subtasks' `parent:`) as part of the rename.
      const titleChanged = title !== this.originalTitle;
      let target = this.existing;
      if (titleChanged) {
        const newPath = await this.store.rename(target, title);
        if (newPath) target = { ...target, path: newPath, title };
      }

      // updateFields may move the note (e.g. Items → Routines when a repeat is added),
      // so pick up the new path before writing the body or adding subtasks.
      const movedPath = await this.store.updateFields(target, {
        scheduled,
        startTime: this.timed ? this.startTime : null,
        endTime: this.timed ? this.endTime : null,
        due: this.due,
        priority: this.priority,
        status: this.status,
        flag: this.flag,
        contexts: this.contexts,
        parent: this.parent,
        project: this.project,
        recurrence,
        recurrenceAnchor: "scheduled",
        recurrenceFrom: this.recurrenceFrom,
        endDate: this.endDate,
        estimate: this.estimate,
        ...this.remindFields(),
        times: this.times,
        dependsOn,
      });
      if (movedPath !== target.path) target = { ...target, path: movedPath };
      await this.saveAttrs(target.path);

      // Only touch the file body when something actually changed — opening a task and
      // saving it unchanged must not rewrite the note.
      const bodyChanged = this.notes.trim() !== this.originalBody.trim();
      if (titleChanged || bodyChanged) {
        await this.store.setBody(target, this.notes, titleChanged ? title : undefined);
      }
      for (const sub of this.newSubtasks) await this.store.addSubtask(target, sub);
      const extra = this.newSubtasks.length ? ` (+${this.newSubtasks.length} subtask${this.newSubtasks.length === 1 ? "" : "s"})` : "";
      new Notice(`Updated: ${title}${extra}`);
    } else {
      const fields = {
        title,
        scheduled,
        startTime: this.timed ? this.startTime : null,
        endTime: this.timed ? this.endTime : null,
        due: this.due,
        priority: this.priority,
        contexts: this.contexts,
        body: this.notes.trim() || undefined,
        recurrence,
        recurrenceAnchor: "scheduled" as const,
        recurrenceFrom: this.recurrenceFrom,
        parent: this.parent,
        project: this.project,
        endDate: this.endDate,
        estimate: this.estimate,
        ...this.remindFields(),
        times: this.times,
        dependsOn,
      };
      if (this.newSubtasks.length) {
        const file = await this.store.createWithSubtasks(fields, this.newSubtasks);
        await this.saveAttrs(file.path);
        new Notice(`Added: ${title} + ${this.newSubtasks.length} subtask${this.newSubtasks.length === 1 ? "" : "s"}`);
      } else {
        const file = await this.store.createTask(fields);
        await this.saveAttrs(file.path);
        new Notice(`Added: ${title}`);
      }
    }
    this.onCreated();
    this.close();
  }

  /**
   * Write the attributes changed in this window — only those, so nothing else is rewritten. One added
   * here but left empty is still written (empty), so the note has it; one taken off is removed.
   */
  private async saveAttrs(path: string): Promise<void> {
    const changes: Record<string, AttrValue | null> = {};
    for (const key of this.attrTouched) changes[key] = this.attrShown.has(key) ? this.attrValues[key] ?? "" : null;
    await this.store.setAttrs(path, changes);
  }

  /** "Your attributes": a row for each one this task's note has, and "＋ Add attribute…" for others. */
  private renderAttrs(host: HTMLElement): void {
    host.empty();
    const attrs = this.settings.attributes;
    const shown = attrs.filter((a) => this.attrShown.has(a.key));
    if (shown.length) host.createDiv({ cls: "brewin-attrs-head", text: "Your attributes" });
    for (const a of shown) this.attrRow(host, a);
    const add = host.createEl("button", { cls: "brewin-attrs-add", text: "＋ Add attribute…" });
    add.addEventListener("click", (e) => {
      const others = attrs.filter((a) => !this.attrShown.has(a.key));
      // Nothing to choose from yet: straight to making one.
      if (!others.length) return this.newAttribute(host);
      const menu = new Menu();
      for (const a of others) {
        menu.addItem((i) =>
          i.setTitle(`${a.icon} ${a.label}`).onClick(() => {
            this.attrShown.add(a.key);
            this.attrTouched.add(a.key);
            this.renderAttrs(host);
          })
        );
      }
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("New attribute…").setIcon("plus").onClick(() => this.newAttribute(host)));
      menu.showAtMouseEvent(e);
    });
  }

  /** Make an attribute — checked against the notes' properties first — and put it on this task. */
  private newAttribute(host: HTMLElement): void {
    new AttributeModal(this.app, this.settings, async (attr) => {
      this.settings.attributes.push(attr);
      await CaptureModal.saveSettings?.();
      this.attrShown.add(attr.key);
      this.attrTouched.add(attr.key);
      // A property this note already had shows its value at once.
      const fm = this.existing ? (this.app.metadataCache.getFileCache(this.app.vault.getAbstractFileByPath(this.existing.path) as TFile)?.frontmatter as Record<string, unknown> | undefined) : undefined;
      const v = fm ? readAttr(attr, fm[attr.key]) : null;
      if (v !== null) this.attrValues[attr.key] = v;
      new Notice(`“${attr.label}” added — every task's window now offers it.`);
      this.renderAttrs(host);
    }).open();
  }

  private attrRow(host: HTMLElement, a: TaskAttribute): void {
    const row = new Setting(host).setName(`${a.icon} ${a.label}`);
    row.settingEl.addClass("brewin-attr-row");
    // Take it off this task: the property is removed from the note on save.
    const off = row.nameEl.createSpan({ cls: "brewin-attr-off clickable-icon", text: "✕" });
    off.setAttr("aria-label", `Take ${a.label} off this task`);
    off.addEventListener("click", () => {
      this.attrShown.delete(a.key);
      this.attrTouched.add(a.key);
      delete this.attrValues[a.key];
      this.renderAttrs(host);
    });
    const cur = this.attrValues[a.key] ?? null;
    const set = (v: AttrValue | null) => {
      this.attrValues[a.key] = v;
      this.attrTouched.add(a.key);
    };
    switch (a.kind) {
      case "bool":
        row.addToggle((t) => t.setValue(cur === true).onChange((v) => set(v ? true : null)));
        break;
      case "choice":
        row.addDropdown((d) => {
          const opts = a.options ?? [];
          d.addOption("", "—");
          for (const o of opts) d.addOption(o, o);
          if (cur !== null && !opts.includes(String(cur))) d.addOption(String(cur), String(cur));
          d.addOption("\u0000new", "＋ New choice…");
          d.setValue(cur === null ? "" : String(cur)).onChange((v) => {
            if (v !== "\u0000new") return set(v || null);
            d.setValue(cur === null ? "" : String(cur));
            new PromptModal(this.app, {
              title: `A new choice for ${a.label}`,
              placeholder: "very high",
              cta: "Add",
              onSubmit: async (text) => {
                const choice = text.trim();
                if (!choice) return;
                if (!(a.options ?? []).includes(choice)) a.options = [...(a.options ?? []), choice];
                await CaptureModal.saveSettings?.();
                set(choice);
                this.renderAttrs(host);
              },
            }).open();
          });
        });
        break;
      case "date":
        row.addText((t) => {
          t.inputEl.type = "date";
          t.setValue(cur === null ? "" : String(cur)).onChange((v) => set(v || null));
        });
        break;
      case "number":
        row.setDesc(a.unit ? `In ${a.unit}` : "");
        row.addText((t) => {
          t.inputEl.inputMode = "decimal";
          t.setPlaceholder(a.unit ?? "").setValue(cur === null ? "" : String(cur)).onChange((v) => set(parseAttrInput(a, v)));
        });
        break;
      case "link":
        row.setDesc(cur === null ? "None" : linkName(String(cur)));
        row.addButton((b) =>
          b.setButtonText(cur === null ? "Choose…" : "Change…").onClick(() => {
            const notes = this.app.vault.getMarkdownFiles().sort((x, y) => x.basename.localeCompare(y.basename));
            new TripSuggestModal(this.app, notes, (file) => {
              set(`[[${file.basename}]]`);
              this.renderAttrs(host);
            }, `${a.label}: choose a note…`).open();
          })
        );
        break;
      default:
        row.addText((t) => t.setValue(cur === null ? "" : String(cur)).onChange((v) => set(v.trim() || null)));
    }
  }

  /**
   * Drill into a subtask: close this window, open the child's, and come straight back
   * here (with fresh data) when the child window closes.
   */
  private editSubtask(child: Task): void {
    const parentPath = this.existing?.path;
    // We're navigating deeper on purpose, so don't fire our own return-hop on close;
    // hand it to the child instead so the whole chain (grandparent → parent → child)
    // unwinds one level at a time.
    const outerReturn = this.returnTo;
    this.returnTo = undefined;
    this.close();

    const reopenParent = () => {
      const fresh = parentPath ? this.store.getByPath(parentPath) : null;
      if (fresh) new CaptureModal(this.app, this.store, this.settings, this.onCreated, fresh, outerReturn).open();
      else outerReturn?.(); // parent gone (renamed/deleted) — fall back up the chain
    };
    const freshChild = this.store.getByPath(child.path) ?? child;
    new CaptureModal(this.app, this.store, this.settings, this.onCreated, freshChild, reopenParent).open();
  }

  /** Delete this task from the edit window (with the same explicit subtask choice). */
  private deleteTask(): void {
    const task = this.existing;
    if (!task) return;
    const kids = childrenOf(buildIndex(this.store.getTasks()), task);
    // Don't hop back to a parent window after deleting.
    this.returnTo = undefined;
    this.close();
    new DeleteTaskModal(this.app, task.title, kids.length, async (choice) => {
      if (!choice) return;
      const n = await this.store.deleteTask(task, choice === "with-subtasks");
      new Notice(`Deleted ${n} task${n === 1 ? "" : "s"}.`);
      this.onCreated();
    }).open();
  }

  private openNote(): void {
    if (!this.existing) return;
    const f = this.app.vault.getAbstractFileByPath(this.existing.path);
    if (f instanceof TFile) this.app.workspace.getLeaf(false).openFile(f);
    this.close();
  }

  /** Redraw the whole body after a parse has changed several fields at once. */
  private rerender(): void {
    this.rerendering = true;
    this.contentEl.empty();
    this.onOpen();
    this.rerendering = false;
  }

  onClose(): void {
    this.contentEl.empty();
    // Hop back to whatever opened this window (e.g. the parent task).
    const back = this.returnTo;
    if (back) {
      this.returnTo = undefined; // fire once
      window.setTimeout(back, 0); // let this modal finish tearing down first
    }
  }
}
