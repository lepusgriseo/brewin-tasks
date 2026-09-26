import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { pickDate } from "./datePicker";
import { EventStore } from "./eventStore";
import { BrewinSettings } from "./settings";
import { RECUR_PRESETS } from "./recurrencePresets";
import { RecurrenceScopeModal } from "./recurrenceScopeModal";
import { ConfirmModal } from "./confirmModal";
import { addMinutesHM, formatHM, minutesOfDay, shiftISO } from "./dates";
import { parseCapture } from "./nlp";
import { parseRemindField, parseRemindStart, previewTimes } from "./reminders";
import { buildRRule, CustomFreq, CustomRecurrence, defaultCustomRecurrence, MonthlyMode, parseCustomRecurrence } from "./recurrenceBuilder";
import { setCount, setUntil, stripEnd } from "./rrule";
import { readRepeatEnd } from "./views";
import { EventItem } from "./types";
import { TripSuggestModal } from "./tripSuggestModal";
import { TripCreateModal } from "./tripCreateModal";
import { toWikilink } from "./task";

const CUSTOM = "__custom__";
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FREQ_UNIT: Record<CustomFreq, [string, string]> = {
  DAILY: ["day", "days"],
  WEEKLY: ["week", "weeks"],
  MONTHLY: ["month", "months"],
  YEARLY: ["year", "years"],
};

/** Create-or-edit an event. Uses native <input type="time"> for mobile-friendly time entry. */
export class EventModal extends Modal {
  private title = "";
  /** True while redrawing, so blur handlers don't re-enter. */
  private rerendering = false;
  /** Reminder override for this event. */
  private remindMode: "default" | "custom" | "off" = "default";
  private remindLead = 10;
  private remindStart = true;
  private date: string;
  /** User-facing inclusive last day for all-day multi-day events (null = single day). */
  private endInclusive: string | null = null;
  /** For TIMED events: the day the end time falls on, when it isn't the start day. */
  private timedEndDate: string | null = null;
  private allDay = true;
  private startTime = "09:00";
  private endTime = "10:00";
  private category = "General";
  private recurrence = "";
  /** Non-null while "Custom…" is the active Repeat choice — the source of truth `recurrence`
   *  is (re)built from, via `buildRRule`. Null when a canned preset (or no repeat) is chosen. */
  private custom: CustomRecurrence | null = null;
  /** How the repeat ends: never, on a date, or after N occurrences. Applies to any repeat,
   *  preset or custom, the same way it already does for tasks. */
  private repeatEnd: "never" | "on" | "after" = "never";
  private repeatUntil: string | null = null;
  private repeatCount = 10;
  /** Set once in onOpen(); the Repeat section rebuilds itself into this on every change. */
  private repeatWrapEl!: HTMLElement;
  private existing?: EventItem;
  /** For recurring edits: the specific occurrence date that was clicked. */
  private occurrenceISO?: string;
  /** Raw wikilink to a linked trip note. */
  private trip: string | null = null;
  /** Trip's resolved vault path, for the "open note" click. */
  private tripPath: string | null = null;
  /** Trip's display title (its basename). */
  private tripTitle: string | null = null;
  /** Free-text "where" — an address, venue name, or room. */
  private location: string | null = null;

  constructor(
    app: App,
    private store: EventStore,
    private settings: BrewinSettings,
    private onCreated: () => void,
    presetDateOrExisting?: string | EventItem,
    occurrenceISO?: string,
    presetStartTime?: string
  ) {
    super(app);
    if (presetDateOrExisting && typeof presetDateOrExisting === "object") {
      this.existing = presetDateOrExisting;
      const e = presetDateOrExisting;
      this.occurrenceISO = e.recurrence ? occurrenceISO ?? e.date : undefined;
      this.title = e.title;
      // For a recurring event, edit the clicked occurrence's date; else the event's own date.
      this.date = this.occurrenceISO ?? e.date;
      this.timedEndDate = !e.allDay && e.endDate && e.endDate > e.date ? e.endDate : null;
      this.allDay = e.allDay;
      this.startTime = e.startTime ?? "09:00";
      this.endTime = e.endTime ?? "10:00";
      this.category = e.category;
      const end = readRepeatEnd(e.recurrence ?? null);
      this.repeatEnd = end.kind;
      this.repeatUntil = end.until;
      this.repeatCount = end.count ?? 10;
      // `this.recurrence` is kept as the bare pattern from here on — no UNTIL/COUNT — so the
      // Repeat dropdown can compare it against RECUR_PRESETS directly; the end condition is
      // folded back in only at save time (repeatEnd/repeatUntil/repeatCount, above).
      this.recurrence = e.recurrence ? stripEnd(e.recurrence) : "";
      if (this.recurrence && !RECUR_PRESETS.some((p) => p.value === this.recurrence)) {
        this.custom = parseCustomRecurrence(this.recurrence, this.date) ?? defaultCustomRecurrence(this.date, "WEEKLY");
      }
      const pr = parseRemindField(e.remind);
      this.remindMode = pr.off ? "off" : pr.minutes != null ? "custom" : "default";
      this.remindLead = pr.minutes ?? settings.reminderLeadMinutes;
      this.remindStart = parseRemindStart(e.remindStart) ?? settings.reminderAtStart;
      this.trip = e.trip;
      this.tripPath = e.tripPath;
      this.location = e.location;
      if (e.tripPath) {
        const f = this.app.vault.getAbstractFileByPath(e.tripPath);
        this.tripTitle = f instanceof TFile ? f.basename : null;
      }
      // Stored all-day endDate is exclusive (day after the last covered day) → show inclusive.
      if (e.allDay && e.endDate) {
        const span = shiftISO(e.endDate, -1);
        const inc = span && span > e.date ? shiftISO(this.date, (this.parseGap(e.date, span))) : null;
        this.endInclusive = inc && inc > this.date ? inc : null;
      }
    } else {
      this.date = presetDateOrExisting ?? new Date().toISOString().slice(0, 10);
      if (presetStartTime) {
        this.allDay = false;
        this.startTime = presetStartTime;
        this.endTime = addMinutesHM(presetStartTime, 60);
      }
    }
  }

  private parseGap(a: string, b: string): number {
    // whole days b − a, using UTC to avoid DST drift
    return Math.round((Date.parse(b + "T00:00Z") - Date.parse(a + "T00:00Z")) / 86400000);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.existing ? "Edit event" : "New event" });

    const titleInput = contentEl.createEl("input", { type: "text", cls: "brewin-capture-title", placeholder: "Event title" });
    titleInput.value = this.title;

    // Same one-line parser as task capture: "Dentist 12 aug at 2pm for 45m".
    // The preview shows what was understood; fields stay editable afterwards.
    const nlHint = contentEl.createDiv({ cls: "brewin-nl-hint" });
    const applyNL = (commit: boolean) => {
      if (this.rerendering) return;
      const parsed = parseCapture(titleInput.value);
      // A repeat typed here is handled by the Repeat control, not the parser.
      const useful = parsed.matched.filter((m) => !m.label.startsWith("repeats"));
      if (!useful.length) {
        nlHint.empty();
        this.title = titleInput.value;
        return;
      }
      nlHint.empty();
      nlHint.createSpan({ cls: "brewin-nl-arrow", text: "→" });
      nlHint.createSpan({ cls: "brewin-nl-title", text: parsed.title || "(no title)" });
      for (const m of useful) nlHint.createSpan({ cls: "brewin-nl-tag", text: m.label });

      if (!commit) return;
      this.title = parsed.title;
      titleInput.value = parsed.title;
      if (parsed.date) this.date = parsed.date;
      if (parsed.startTime) {
        this.allDay = false;
        this.startTime = parsed.startTime;
        this.endTime = parsed.endTime ?? addMinutesHM(parsed.startTime, 60);
      }
      if (parsed.recurrence && !this.recurrence) this.recurrence = parsed.recurrence;
      nlHint.empty();
      this.rerender();
    };

    titleInput.addEventListener("input", () => {
      this.title = titleInput.value;
      applyNL(false);
    });
    titleInput.addEventListener("blur", () => applyNL(true));
    window.setTimeout(() => titleInput.focus(), 0);

    if (this.existing?.recurrence) {
      contentEl.createDiv({ cls: "brewin-capture-hint", text: "🔁 Recurring event — on save you'll choose: this event, this & following, or all." });
    }

    // Date
    const dateRow = contentEl.createDiv({ cls: "brewin-capture-dates" });
    const dateBtn = dateRow.createEl("button", { cls: "brewin-chip brewin-chip-set" });
    const render = () => dateBtn.setText(`📅 ${this.date}`);
    render();
    dateBtn.addEventListener("click", async () => {
      const r = await pickDate(this.app, this.date, this.settings.firstDayOfWeek, {
        selectedLabel: "Starts",
        relatedISO: this.endInclusive,
        relatedLabel: "Ends",
      });
      if (r) {
        this.date = r;
        render();
      }
    });

    // All-day toggle (shows/hides the time inputs vs the multi-day end-date control)
    let updateConditional = () => {};
    new Setting(contentEl).setName("All day").addToggle((t) =>
      t.setValue(this.allDay).onChange((v) => {
        this.allDay = v;
        updateConditional();
      })
    );

    // Time inputs (timed events), plus an optional end DAY so a block can cross midnight.
    const timeWrap = contentEl.createDiv();
    const times = timeWrap.createDiv({ cls: "brewin-time-row" });
    const start = times.createEl("input", { type: "time" });
    start.value = this.startTime;
    start.addEventListener("input", () => (this.startTime = start.value));
    times.createSpan({ text: " → " });
    const end = times.createEl("input", { type: "time" });
    end.value = this.endTime;
    end.addEventListener("input", () => (this.endTime = end.value));

    const endsOnBtn = times.createEl("button", { cls: "brewin-chip brewin-chip-mini" });
    endsOnBtn.setAttr("aria-label", "The day this event ends on");
    endsOnBtn.addEventListener("click", async () => {
      const r = await pickDate(this.app, this.timedEndDate ?? this.date, this.settings.firstDayOfWeek, {
        selectedLabel: "Ends",
        relatedISO: this.date,
        relatedLabel: "Starts",
      });
      if (r === undefined) return; // cancelled
      if (!r || r === this.date) this.timedEndDate = null; // same day
      else if (r < this.date) new Notice("An event can't end before it starts.");
      else this.timedEndDate = r;
      updateConditional();
    });

    // End date (all-day multi-day). User picks the inclusive last day.
    const endWrap = contentEl.createDiv({ cls: "brewin-capture-dates" });
    const endBtn = endWrap.createEl("button", { cls: "brewin-chip" });
    endBtn.addEventListener("click", async () => {
      const r = await pickDate(this.app, this.endInclusive ?? this.date, this.settings.firstDayOfWeek, {
        selectedLabel: "Ends",
        relatedISO: this.date,
        relatedLabel: "Starts",
      });
      if (r === undefined) return; // cancelled
      if (!r) this.endInclusive = null; // cleared
      else if (r <= this.date) new Notice("End date must be after the start date.");
      else this.endInclusive = r;
      updateConditional();
    });

    updateConditional = () => {
      timeWrap.toggleClass("brewin-hidden", this.allDay);
      endWrap.toggleClass("brewin-hidden", !this.allDay);
      endBtn.setText(this.endInclusive ? `📅 Ends ${this.endInclusive}` : "📅 End date (optional)");
      endBtn.toggleClass("brewin-chip-set", !!this.endInclusive);
      endsOnBtn.setText(this.timedEndDate ? `📅 ${this.timedEndDate}` : "📅 same day");
      endsOnBtn.toggleClass("brewin-chip-set", !!this.timedEndDate);
    };
    updateConditional();

    new Setting(contentEl).setName("Category").addDropdown((d) => {
      const names = this.settings.categories.map((c) => c.name);
      if (this.category && !names.includes(this.category)) d.addOption(this.category, this.category);
      names.forEach((c) => d.addOption(c, c));
      d.setValue(this.category || names[0] || "General").onChange((v) => (this.category = v));
    });

    // ── Trip ──
    const tripSetting = new Setting(contentEl).setName("Trip").setDesc("Link this event to a trip note.");
    const tripWrap = tripSetting.controlEl.createDiv({ cls: "brewin-remind-row" });
    const tripCrumb = tripWrap.createSpan({ cls: "brewin-parent-crumb" });
    const tripPickBtn = tripWrap.createEl("button", { cls: "brewin-chip-mini" });
    const renderTrip = () => {
      tripCrumb.setText(this.tripTitle ? `✈ ${this.tripTitle}` : "No trip linked");
      tripCrumb.toggleClass("brewin-hidden", !this.tripPath);
      tripPickBtn.setText(this.tripTitle ? "Change trip…" : "Link trip…");
    };
    tripCrumb.addEventListener("click", () => {
      if (!this.tripPath) return;
      const f = this.app.vault.getAbstractFileByPath(this.tripPath);
      if (f instanceof TFile) this.app.workspace.getLeaf(false).openFile(f);
      this.close();
    });
    tripPickBtn.addEventListener("click", () => {
      const trips = this.app.vault
        .getMarkdownFiles()
        .filter((f) => f.path.startsWith(this.settings.tripsFolder + "/") && /^\d{4}-\d{2}-\d{2}/.test(f.basename));
      new TripSuggestModal(this.app, trips, (picked) => {
        this.trip = toWikilink(picked.basename);
        this.tripPath = picked.path;
        this.tripTitle = picked.basename;
        renderTrip();
      }).open();
    });
    const tripNewBtn = tripWrap.createEl("button", { cls: "brewin-chip-mini", text: "＋ New trip…" });
    tripNewBtn.addEventListener("click", () => {
      new TripCreateModal(this.app, this.settings, this.date, (file) => {
        this.trip = toWikilink(file.basename);
        this.tripPath = file.path;
        this.tripTitle = file.basename;
        renderTrip();
      }).open();
    });
    tripSetting.addExtraButton((b) =>
      b.setIcon("x").setTooltip("Clear trip link").onClick(() => {
        this.trip = null;
        this.tripPath = null;
        this.tripTitle = null;
        renderTrip();
      })
    );
    renderTrip();

    // ── Location ──
    new Setting(contentEl)
      .setName("Location")
      .setDesc("Where this is — an address, venue, or room.")
      .addText((t) =>
        t
          .setPlaceholder("e.g. 12 High Street, or Room 4")
          .setValue(this.location ?? "")
          .onChange((v) => (this.location = v.trim() || null))
      );

    this.repeatWrapEl = contentEl.createDiv();
    this.renderRepeat();

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

      const at = minutesOfDay(this.allDay ? null : this.startTime);
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


    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    if (this.existing) {
      const del = btns.createEl("button", { text: "🗑", cls: "brewin-delete-btn" });
      del.setAttr("aria-label", "Delete event");
      del.addEventListener("click", () => this.deleteEvent());
    }
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    if (this.existing) {
      btns.createEl("button", { text: "Open note" }).addEventListener("click", () => this.openNote());
    }
    btns.createEl("button", { text: this.existing ? "Save" : "Add event", cls: "mod-cta" }).addEventListener("click", () => this.save());
  }

  /**
   * The whole Repeat area: the preset/Custom… dropdown, the custom builder when active, and
   * the Ends control when anything at all is repeating. Rebuilds itself wholesale on any
   * STRUCTURAL change (preset↔custom, frequency, monthly mode) — this subtree is small and
   * cheap to redraw, so that's simpler than patching each piece in place. Non-structural edits
   * (an interval number, a weekday chip) update `this.recurrence` directly without a rebuild,
   * so typing in a number field doesn't fight the caret — same split CaptureModal already uses
   * for its own "Ends" count input.
   */
  private renderRepeat(): void {
    const wrap = this.repeatWrapEl;
    wrap.empty();

    const isPreset = !this.recurrence || RECUR_PRESETS.some((p) => p.value === this.recurrence);
    if (!isPreset && !this.custom) {
      this.custom = parseCustomRecurrence(this.recurrence, this.date) ?? defaultCustomRecurrence(this.date, "WEEKLY");
    }
    const dropdownValue = isPreset ? this.recurrence : CUSTOM;

    new Setting(wrap).setName("Repeat").addDropdown((d) => {
      RECUR_PRESETS.forEach((p) => d.addOption(p.value, p.label));
      d.addOption(CUSTOM, "Custom…");
      d.setValue(dropdownValue).onChange((v) => {
        if (v === CUSTOM) {
          this.custom = this.custom ?? defaultCustomRecurrence(this.date, "WEEKLY");
          this.recurrence = buildRRule(this.custom);
        } else {
          this.custom = null;
          this.recurrence = v;
        }
        this.renderRepeat();
      });
    });

    if (dropdownValue === CUSTOM && this.custom) this.renderRepeatCustom(wrap, this.custom);
    if (this.recurrence) this.renderRepeatEnds(wrap);
  }

  /** "Every [N] [days/weeks/months/years]" plus whatever `c.freq` needs beyond that. */
  private renderRepeatCustom(wrap: HTMLElement, c: CustomRecurrence): void {
    const box = wrap.createDiv({ cls: "brewin-recur-custom" });

    const freqRow = box.createDiv({ cls: "brewin-recur-row" });
    freqRow.createSpan({ text: "Every" });
    const intervalIn = freqRow.createEl("input", { type: "number", cls: "brewin-recur-interval" });
    intervalIn.min = "1";
    intervalIn.value = String(c.interval);
    const freqSel = freqRow.createEl("select");
    (Object.keys(FREQ_UNIT) as CustomFreq[]).forEach((f) =>
      freqSel.createEl("option", { text: FREQ_UNIT[f][c.interval === 1 ? 0 : 1], value: f })
    );
    freqSel.value = c.freq;
    intervalIn.addEventListener("input", () => {
      const n = Number(intervalIn.value);
      c.interval = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
      this.recurrence = buildRRule(c);
      // "1 week" vs "2 weeks" — relabel in place rather than rebuilding the section.
      Array.from(freqSel.options).forEach((opt) => {
        opt.text = FREQ_UNIT[opt.value as CustomFreq][c.interval === 1 ? 0 : 1];
      });
    });
    freqSel.addEventListener("change", () => {
      c.freq = freqSel.value as CustomFreq;
      this.recurrence = buildRRule(c);
      this.renderRepeat(); // the controls below depend on freq — a real structural change
    });

    if (c.freq === "WEEKLY") {
      const days = box.createDiv({ cls: "brewin-recur-weekdays" });
      // Starts from the vault's own first-day-of-week, same convention as the date picker.
      const order = [...Array(7).keys()].map((i) => (this.settings.firstDayOfWeek + i) % 7);
      for (const wd of order) {
        const btn = days.createEl("button", {
          text: WEEKDAY_LABELS[wd],
          cls: "brewin-chip brewin-chip-mini" + (c.byday.includes(wd) ? " brewin-chip-set" : ""),
        });
        btn.addEventListener("click", () => {
          c.byday = c.byday.includes(wd) ? c.byday.filter((d) => d !== wd) : [...c.byday, wd];
          btn.toggleClass("brewin-chip-set", c.byday.includes(wd));
          this.recurrence = buildRRule(c);
        });
      }
    } else if (c.freq === "MONTHLY") {
      const modeRow = box.createDiv({ cls: "brewin-recur-row" });
      const modeSel = modeRow.createEl("select");
      modeSel.createEl("option", { text: "On day", value: "day" });
      modeSel.createEl("option", { text: "On the", value: "weekday" });
      modeSel.value = c.monthlyMode;
      modeSel.addEventListener("change", () => {
        c.monthlyMode = modeSel.value as MonthlyMode;
        this.recurrence = buildRRule(c);
        this.renderRepeat(); // day-number vs ordinal+weekday — structural
      });

      if (c.monthlyMode === "day") {
        const dayIn = modeRow.createEl("input", { type: "number", cls: "brewin-recur-interval" });
        dayIn.min = "1";
        dayIn.max = "31";
        dayIn.disabled = c.monthDay === -1;
        dayIn.value = c.monthDay === -1 ? "" : String(c.monthDay);
        dayIn.addEventListener("input", () => {
          const n = Number(dayIn.value);
          c.monthDay = Number.isFinite(n) && n >= 1 && n <= 31 ? Math.floor(n) : 1;
          this.recurrence = buildRRule(c);
        });
        const lastLabel = modeRow.createEl("label", { cls: "brewin-recur-last" });
        const lastBox = lastLabel.createEl("input", { type: "checkbox" });
        lastBox.checked = c.monthDay === -1;
        lastLabel.createSpan({ text: "Last day" });
        lastBox.addEventListener("change", () => {
          c.monthDay = lastBox.checked ? -1 : Number(dayIn.value) || 1;
          dayIn.disabled = lastBox.checked;
          dayIn.value = lastBox.checked ? "" : String(c.monthDay);
          this.recurrence = buildRRule(c);
        });
      } else {
        const ordSel = modeRow.createEl("select");
        ([[1, "first"], [2, "second"], [3, "third"], [4, "fourth"], [-1, "last"]] as [number, string][]).forEach(
          ([v, label]) => ordSel.createEl("option", { text: label, value: String(v) })
        );
        ordSel.value = String(c.monthWeekOrdinal);
        ordSel.addEventListener("change", () => {
          c.monthWeekOrdinal = Number(ordSel.value);
          this.recurrence = buildRRule(c);
        });
        const wdSel = modeRow.createEl("select");
        WEEKDAY_LABELS.forEach((label, i) => wdSel.createEl("option", { text: label, value: String(i) }));
        wdSel.value = String(c.monthWeekday);
        wdSel.addEventListener("change", () => {
          c.monthWeekday = Number(wdSel.value);
          this.recurrence = buildRRule(c);
        });
      }
    }
  }

  /** When the repeat stops — never / on a date / after N times. Same shape as CaptureModal's,
   *  new here: events previously had no way to end a series short of deleting the note. */
  private renderRepeatEnds(wrap: HTMLElement): void {
    const endSetting = new Setting(wrap).setName("Ends").setDesc("When the repeat stops.");
    const endWrap = endSetting.controlEl.createDiv({ cls: "brewin-repeat-end" });
    const endSel = endWrap.createEl("select");
    endSel.createEl("option", { text: "Never", value: "never" });
    endSel.createEl("option", { text: "On a date", value: "on" });
    endSel.createEl("option", { text: "After N times", value: "after" });
    const untilBtn = endWrap.createEl("button", { cls: "brewin-chip" });
    const countInput = endWrap.createEl("input", { type: "number", cls: "brewin-repeat-count" });
    countInput.min = "1";

    const refresh = () => {
      endSel.value = this.repeatEnd;
      untilBtn.toggleClass("brewin-hidden", this.repeatEnd !== "on");
      countInput.toggleClass("brewin-hidden", this.repeatEnd !== "after");
      untilBtn.setText(this.repeatUntil ? `📅 ${this.repeatUntil}` : "📅 Pick a date");
      untilBtn.toggleClass("brewin-chip-set", !!this.repeatUntil);
      countInput.value = String(this.repeatCount);
    };
    endSel.addEventListener("change", () => {
      this.repeatEnd = endSel.value as "never" | "on" | "after";
      refresh();
    });
    untilBtn.addEventListener("click", async () => {
      const r = await pickDate(this.app, this.repeatUntil, this.settings.firstDayOfWeek, {
        selectedLabel: "Repeat ends",
        relatedISO: this.date,
        relatedLabel: "Starts",
      });
      if (r !== undefined) this.repeatUntil = r;
      refresh();
    });
    countInput.addEventListener("input", () => {
      const n = Number(countInput.value);
      this.repeatCount = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    });
    refresh();
  }

  /** Delete this event — recurring ones ask which occurrences to remove. */
  private deleteEvent(): void {
    const ev = this.existing;
    if (!ev) return;
    const occ = this.occurrenceISO ?? ev.date;
    this.close();

    const done = (msg: string) => {
      new Notice(msg);
      this.onCreated();
    };

    if (ev.recurrence) {
      new RecurrenceScopeModal(
        this.app,
        async (scope) => {
          if (!scope) return;
          await this.store.deleteOccurrence(ev, occ, scope);
          done(
            scope === "single"
              ? `Removed the ${occ} occurrence of "${ev.title}".`
              : scope === "following"
                ? `"${ev.title}" now ends before ${occ}.`
                : `Deleted "${ev.title}" and all its occurrences.`
          );
        },
        {
          title: "Delete recurring event",
          prompt: "Which occurrences should be deleted?",
          labels: {
            single: `This occurrence only (${occ})`,
            following: "This and all following occurrences",
            all: "Every occurrence — delete the event",
          },
          danger: true,
        }
      ).open();
      return;
    }

    new ConfirmModal(this.app, {
      title: "Delete event",
      body: `"${ev.title}" will be moved to your vault's trash — recoverable via Obsidian's "Deleted files" setting.`,
      cta: "Delete",
      onConfirm: async () => {
        await this.store.deleteEvent(ev);
        done(`Deleted "${ev.title}".`);
      },
    }).open();
  }

  private async save(): Promise<void> {
    const title = this.title.trim();
    if (!title) {
      new Notice("Event needs a title");
      return;
    }
    // All-day multi-day stores the EXCLUSIVE end (inclusive last day + 1); a timed event
    // stores the day its end time falls on, so it can legitimately cross midnight.
    const endDate = this.allDay
      ? this.endInclusive
        ? shiftISO(this.endInclusive, 1)
        : null
      : this.timedEndDate;

    // A same-day block must not end before it starts (crossing midnight needs an end date).
    if (!this.allDay && !endDate && this.endTime <= this.startTime) {
      new Notice("End time is before the start — set the end date to the next day if it runs overnight.");
      return;
    }

    // Fold the end condition into the pattern. `stripEnd` first, so switching back to "Never"
    // actually clears a previous UNTIL/COUNT rather than leaving it underneath.
    let recurrence = this.recurrence || null;
    if (recurrence) {
      const base = stripEnd(recurrence);
      if (this.repeatEnd === "on" && this.repeatUntil) recurrence = setUntil(base, this.repeatUntil);
      else if (this.repeatEnd === "after") recurrence = setCount(base, this.repeatCount);
      else recurrence = base;
    }
    const fields = {
      title,
      date: this.date,
      endDate,
      allDay: this.allDay,
      startTime: this.allDay ? null : this.startTime,
      endTime: this.allDay ? null : this.endTime,
      category: this.category,
      ...this.remindFields(),
      recurrence,
      trip: this.trip,
      location: this.location,
    };
    if (this.existing?.recurrence) {
      // Ask how to apply the change across the series.
      const existing = this.existing;
      const occ = this.occurrenceISO ?? existing.date;
      new RecurrenceScopeModal(this.app, async (scope) => {
        if (!scope) return; // cancelled — leave the event modal open
        await this.store.applyRecurringEdit(existing, occ, scope, fields);
        new Notice(`Event updated: ${title}`);
        this.onCreated();
        this.close();
      }).open();
      return;
    }
    if (this.existing) {
      await this.store.update(this.existing, fields);
      new Notice(`Event updated: ${title}`);
    } else {
      await this.store.createEvent(fields);
      new Notice(`Event added: ${title}`);
    }
    this.onCreated();
    this.close();
  }

  private openNote(): void {
    if (!this.existing) return;
    const f = this.app.vault.getAbstractFileByPath(this.existing.path);
    if (f instanceof TFile) this.app.workspace.getLeaf(false).openFile(f);
    this.close();
  }

  /** Redraw the body after a parse changed several fields at once. */
  private rerender(): void {
    this.rerendering = true;
    this.contentEl.empty();
    this.onOpen();
    this.rerendering = false;
  }

  /** The `remind:` / `remind_start:` pair this control represents. */
  private remindFields(): { remind: string | null; remindStart: boolean | null } {
    if (this.remindMode === "off") return { remind: "none", remindStart: null };
    if (this.remindMode === "custom") return { remind: `${this.remindLead}m`, remindStart: this.remindStart };
    return { remind: null, remindStart: null }; // default → store nothing
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
