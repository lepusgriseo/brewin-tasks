import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { pickDate } from "./datePicker";
import { addDays, addMinutesHM, formatHM, formatISO, minutesOfDay, todayISO, todayUTC } from "./dates";
import { Priority, Status, Task, TaskSlot } from "./types";
import { TaskStore } from "./taskStore";
import { BrewinSettings } from "./settings";
import { RECUR_PRESETS } from "./recurrencePresets";
import { setCount, setUntil, stripEnd } from "./rrule";
import { formatSlot, parseSlot, parseSlots, slotTitle } from "./slots";
import { readRepeatEnd, spanOf } from "./views";
import { buildContextIndex, parseContexts, toggleContext } from "./contexts";
import { formatEstimate, parseEstimate } from "./estimate";
import { parseCapture } from "./nlp";
import { previewTimes, parseRemindField, parseRemindStart } from "./reminders";
import { TaskSuggestModal } from "./taskSuggestModal";
import { DeleteTaskModal } from "./deleteTaskModal";
import { buildIndex, childrenOf, validParentCandidates } from "./hierarchy";
import { validDependencyCandidates } from "./dependencies";
import { RecurrenceScopeModal } from "./recurrenceScopeModal";
import { toWikilink } from "./task";

/** Create-or-edit a task: title + scheduled/due via date-picker + priority + context + repeat. */
export class CaptureModal extends Modal {
  private title = "";
  private scheduled: string | null = null;
  private due: string | null = null;
  /** Effort estimate in minutes. */
  private estimate: number | null = null;
  /** True while the modal is redrawing itself, to stop blur handlers re-entering. */
  private rerendering = false;
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
  /** Snapshots used to leave the file untouched when nothing actually changed. */
  private originalTitle = "";
  private originalBody = "";
  private recurrence = "";
  private status: Status = "todo";
  private existing?: Task;
  /** Parent wikilink (e.g. `[[Ship v2]]`), or null for a top-level task. */
  private parent: string | null = null;
  private parentTitle: string | null = null;
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
    preset?: { scheduled: string; startTime?: string },
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
      this.parent = existing.parent;
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
        this.endTime = addMinutesHM(preset.startTime, this.settings.defaultTaskMinutes);
      }
    }
  }

  onOpen(): void {
    this.modalEl.addClass("brewin-capture-modal");
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.existing ? "Edit task" : "New task" });

    // Title
    const titleInput = contentEl.createEl("input", {
      type: "text",
      cls: "brewin-capture-title",
      placeholder: "What needs doing?",
    });
    titleInput.value = this.title;
    titleInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      applyNL(true); // fold the sentence into fields before it's written
      if (this.title.trim()) this.save();
    });
    // ── Natural language ──
    // The title box doubles as a command line: "Bins out every monday at 7pm @home ~10m".
    // Nothing is applied silently — the preview below states exactly what was understood,
    // and the fields it fills stay editable, so a wrong guess is visible and correctable.
    const nlHint = contentEl.createDiv({ cls: "brewin-nl-hint" });
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
      if (parsed.recurrence) this.recurrence = parsed.recurrence;
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
    const startIn = times.createEl("input", { type: "time" });
    startIn.value = this.startTime;
    startIn.addEventListener("input", () => (this.startTime = startIn.value));
    times.createSpan({ text: " → " });
    const endIn = times.createEl("input", { type: "time" });
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

    // Status (edit mode only)
    if (this.existing) {
      new Setting(contentEl).setName("Status").addDropdown((d) =>
        d
          .addOption("todo", "To do")
          .addOption("hold", "On hold")
          .addOption("done", "Done")
          .setValue(this.status)
          .onChange((v) => (this.status = v as Status))
      );
    }


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
    renderChips = () => {
      chips.empty();
      const active = new Set(this.contexts.map((c) => c.toLowerCase()));
      for (const c of ctxIndex.suggestions) {
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
    };
    renderChips();

    // Repeat
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
      // An end only means something for a series.
      endSetting.settingEl.toggleClass("brewin-hidden", !this.recurrence);
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
      if (e.key !== "Enter") return;
      e.preventDefault();
      addSlot();
    });

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
    });
    subInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation(); // don't trigger the modal's save-on-Enter
      const v = subInput.value.trim();
      if (!v) return;
      this.newSubtasks.push(v);
      subInput.value = "";
      renderPending();
    });
    renderPending();

    // Notes — the note body (loaded asynchronously when editing)
    const notes = contentEl.createEl("textarea", {
      cls: "brewin-capture-notes",
      placeholder: "Notes (optional)…",
    });
    notes.addEventListener("input", () => {
      this.notes = notes.value;
      this.notesDirty = true;
    });
    if (this.existing) {
      void this.store.getBody(this.existing).then((body) => {
        // Don't clobber anything typed while the read was in flight.
        if (this.notesDirty) return;
        this.notes = body;
        this.originalBody = body;
        notes.value = body;
      });
    }

    // Buttons
    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    if (this.existing) {
      const del = btns.createEl("button", { text: "🗑", cls: "brewin-delete-btn" });
      del.setAttr("aria-label", "Delete task");
      del.addEventListener("click", () => this.deleteTask());
    }
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    if (this.existing) {
      btns.createEl("button", { text: "Open note" }).addEventListener("click", () => this.openNote());
    }
    const saveBtn = btns.createEl("button", { text: this.existing ? "Save" : "Add task", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => this.save());

    contentEl.createEl("div", {
      cls: "brewin-capture-hint",
      text: this.existing ? "Edit any field, then Save" : "Enter to add · ⌘/Ctrl+Enter also works",
    });
  }

  /** The `remind:` / `remind_start:` pair this control represents. */
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
          recurrence,
          recurrenceAnchor: "scheduled" as const,
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
        contexts: this.contexts,
        parent: this.parent,
        recurrence,
        recurrenceAnchor: "scheduled",
        endDate: this.endDate,
        estimate: this.estimate,
        ...this.remindFields(),
        times: this.times,
        dependsOn,
      });
      if (movedPath !== target.path) target = { ...target, path: movedPath };

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
        parent: this.parent,
        endDate: this.endDate,
        estimate: this.estimate,
        ...this.remindFields(),
        times: this.times,
        dependsOn,
      };
      if (this.newSubtasks.length) {
        await this.store.createWithSubtasks(fields, this.newSubtasks);
        new Notice(`Added: ${title} + ${this.newSubtasks.length} subtask${this.newSubtasks.length === 1 ? "" : "s"}`);
      } else {
        await this.store.createTask(fields);
        new Notice(`Added: ${title}`);
      }
    }
    this.onCreated();
    this.close();
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
