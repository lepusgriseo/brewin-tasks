import { App, normalizePath, TFile, TFolder } from "obsidian";
import { BrewinSettings } from "./settings";
import { convertEndDate, eventFromFrontmatter, eventLastCoveredISO, eventNotePath, tripLinkpath } from "./event";
import { addMinutesHM, dayDelta, durationMinutes, shiftISO, todayISO } from "./dates";
import { setUntil, stripEnd } from "./rrule";
import { EventItem } from "./types";

/** What a calendar drop meant. The three targets are not interchangeable. */
export type DropIntent =
  | { kind: "time"; start: string }
  | { kind: "allDay" }
  | { kind: "date" };

export interface NewEventFields {
  title: string;
  date: string;
  endDate: string | null;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
  category: string;
  recurrence?: string | null;
  /** Reminder override: "30m" custom lead, "none" to silence. */
  remind?: string | null;
  /** At-the-time reminder override; null defers to the global setting. */
  remindStart?: boolean | null;
  /** Wikilink to a linked trip note, e.g. `[[2026-08-31 - 09-24 London]]`. */
  trip?: string | null;
  /** Free-text "where" — an address, venue name, or room. Not a wikilink/note. */
  location?: string | null;
}

export class EventStore {
  constructor(private app: App, private settings: BrewinSettings) {}

  /** All event notes: markdown under the events folder carrying a `date` frontmatter field. */
  getEvents(): EventItem[] {
    const folder = this.settings.eventsFolder;
    const out: EventItem[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!(file.path.startsWith(folder + "/") || file.path === folder)) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      if (!fm || fm.date == null) continue;
      const ev = eventFromFrontmatter(fm, file.path, file.basename, folder, this.settings.eventsArchiveFolder);
      ev.tripPath = this.resolveTripPath(ev.trip, file.path);
      out.push(ev);
    }
    return out;
  }

  /** Resolve a stored `trip:` wikilink to a vault path — mirrors TaskStore.resolveParentPath. */
  private resolveTripPath(trip: string | null, sourcePath: string): string | null {
    const linkpath = tripLinkpath(trip);
    if (!linkpath) return null;
    const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    return dest ? dest.path : null;
  }

  private async ensureFolder(path: string): Promise<void> {
    const norm = normalizePath(path);
    if (this.app.vault.getAbstractFileByPath(norm) instanceof TFolder) return;
    if (this.app.vault.getAbstractFileByPath(norm)) return;
    try {
      await this.app.vault.createFolder(norm);
    } catch {
      /* ignore */
    }
  }

  private uniquePath(folder: string, title: string, date: string): string {
    const safe = title.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Event";
    let p = normalizePath(`${folder}/${date} ${safe}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(p)) p = normalizePath(`${folder}/${date} ${safe} ${n++}.md`);
    return p;
  }

  async createEvent(f: NewEventFields): Promise<TFile> {
    // Same path rule as editing, so create and edit can never disagree about where an
    // event of a given category belongs.
    const desired = normalizePath(eventNotePath(this.settings.eventsFolder, f.category, f.date, f.title));
    const folder = desired.slice(0, desired.lastIndexOf("/"));
    await this.ensureFolder(folder);
    const path = this.avoidCollision(desired);
    const lines = [
      "---",
      `title: ${f.title}`,
      `allDay: ${f.allDay}`,
      `date: ${f.date}`,
    ];
    if (f.endDate) lines.push(`endDate: ${f.endDate}`);
    if (!f.allDay) {
      lines.push(`startTime: ${f.startTime ?? ""}`, `endTime: ${f.endTime ?? ""}`);
    }
    if (f.recurrence) lines.push(`recurrence: "${f.recurrence}"`);
    if (f.remind) lines.push(`remind: ${f.remind}`);
    if (f.remindStart != null) lines.push(`remind_start: ${f.remindStart}`);
    if (f.trip) lines.push(`trip: "${f.trip}"`);
    if (f.location) lines.push(`location: "${f.location.replace(/"/g, '\\"')}"`);
    // Left empty for the Properties panel: link the people who were there, e.g. [[Zoe Brewin]].
    lines.push("with: ", "completed: null", `modified: ${todayISO()}`, "---", "", `# ${f.title}`, "");
    return this.app.vault.create(path, lines.join("\n"));
  }

  getByPath(path: string): EventItem | null {
    return this.getEvents().find((e) => e.path === path) ?? null;
  }

  async setRecurrence(ev: EventItem, rrule: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(ev.path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.recurrence = rrule;
      fm.modified = todayISO();
    });
  }

  /** Add a recurrence exception (skip this occurrence date). */
  async addExdate(ev: EventItem, iso: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(ev.path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const cur: string[] = Array.isArray(fm.recurrence_exdates) ? fm.recurrence_exdates.map(String) : [];
      if (!cur.includes(iso)) cur.push(iso);
      fm.recurrence_exdates = cur.sort();
      fm.modified = todayISO();
    });
  }

  /**
   * Apply an edit to a recurring series at the clicked occurrence.
   *  - "all": edit the whole series (a moved day shifts the whole pattern).
   *  - "single": skip this occurrence in the series + create a standalone edited event.
   *  - "following": end the series the day before this occurrence + start a new edited series here.
   */
  async applyRecurringEdit(
    original: EventItem,
    occurrenceISO: string,
    scope: "single" | "following" | "all",
    f: NewEventFields
  ): Promise<void> {
    if (scope === "all") {
      const delta = dayDelta(occurrenceISO, f.date);
      const newDate = shiftISO(original.date, delta) ?? original.date;
      await this.update(original, { ...f, date: newDate, recurrence: f.recurrence ?? original.recurrence });
      return;
    }
    if (scope === "single") {
      await this.addExdate(original, occurrenceISO);
      await this.createEvent({ ...f, recurrence: null });
      return;
    }
    // following — "this and all later" starting from the FIRST occurrence is just "all".
    // Splitting there would end the original series before its own start date, leaving a
    // note behind that can never fire. (Deletion already collapses this case; so does this.)
    if (occurrenceISO <= original.date) {
      const delta = dayDelta(occurrenceISO, f.date);
      const newDate = shiftISO(original.date, delta) ?? original.date;
      await this.update(original, { ...f, date: newDate, recurrence: f.recurrence ?? original.recurrence });
      return;
    }
    const untilISO = shiftISO(occurrenceISO, -1) ?? occurrenceISO;
    await this.setRecurrence(original, setUntil(original.recurrence ?? "", untilISO));
    await this.createEvent({ ...f, recurrence: stripEnd(f.recurrence || original.recurrence || "") });
  }

  /**
   * Edit an event. Because an event's **category is its folder** and its filename encodes
   * the date and title, changing any of those has to move/rename the note — not just
   * rewrite frontmatter. Returns the (possibly new) path.
   */
  async update(ev: EventItem, f: NewEventFields): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(ev.path);
    if (!(file instanceof TFile)) return ev.path;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.title = f.title;
      fm.allDay = f.allDay;
      fm.date = f.date;
      if (f.endDate) fm.endDate = f.endDate;
      else delete fm.endDate;
      if (!f.allDay) {
        fm.startTime = f.startTime ?? "";
        fm.endTime = f.endTime ?? "";
      } else {
        delete fm.startTime;
        delete fm.endTime;
      }
      if (f.recurrence) fm.recurrence = f.recurrence;
      else delete fm.recurrence;
      if (f.remind) fm.remind = f.remind;
      else delete fm.remind;
      if (f.remindStart != null) fm.remind_start = f.remindStart;
      else delete fm.remind_start;
      if (f.trip) fm.trip = f.trip;
      else delete fm.trip;
      if (f.location) fm.location = f.location;
      else delete fm.location;
      fm.modified = todayISO();
    });

    return this.relocate(ev, f);
  }

  /**
   * Put the note where its category/date/title say it belongs, creating the category
   * folder if it doesn't exist yet. Archived events stay inside the archive.
   */
  private async relocate(ev: EventItem, f: NewEventFields): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(ev.path);
    if (!(file instanceof TFile)) return ev.path;

    const root = ev.archived ? this.settings.eventsArchiveFolder : this.settings.eventsFolder;
    const desired = normalizePath(eventNotePath(root, f.category, f.date, f.title));
    if (desired === ev.path) return ev.path; // already in the right place

    const dir = desired.slice(0, desired.lastIndexOf("/"));
    await this.ensureFolder(dir); // the category folder may not exist yet
    const dest = this.avoidCollision(desired);
    try {
      await this.app.fileManager.renameFile(file, dest);
      return dest;
    } catch {
      return ev.path; // couldn't move — the frontmatter edit still stands
    }
  }

  /**
   * Move an event to a new date, optionally to a new start time (duration preserved).
   * Used by calendar drag-and-drop. Shifts endDate by the same day-delta.
   */
  /**
   * Move an event, being explicit about what the drop MEANT.
   *
   * The three drop targets are genuinely different and were previously conflated:
   *   `time`   — the hour grid: give it this start time (becomes timed).
   *   `allDay` — the ALL DAY band: it is now an all-day event; the times must go.
   *   `date`   — a month cell: change the day only, keeping whatever it already was.
   *
   * Dropping a timed event on the ALL DAY band used to fall through the old
   * `if (newStart)` branch and rewrite nothing but the date, so the event stayed timed
   * while the UI claimed it had moved.
   */
  async reschedule(ev: EventItem, newDate: string, intent: DropIntent): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(ev.path);
    if (!(file instanceof TFile)) return;
    const oldStart = ev.date;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.date = newDate;

      // Carry any multi-day span along with the move first, in its ORIGINAL convention.
      let carriedEnd: string | null = null;
      if (ev.endDate) carriedEnd = shiftISO(ev.endDate, dayDelta(oldStart, newDate));

      if (intent.kind === "time") {
        const dur = durationMinutes(ev.startTime, ev.endTime);
        fm.allDay = false;
        fm.startTime = intent.start;
        fm.endTime = addMinutesHM(intent.start, dur);
        // Was all-day (exclusive end) and is now timed (inclusive) — adjust if it spanned days.
        if (ev.allDay) carriedEnd = convertEndDate(newDate, carriedEnd, false);
      } else if (intent.kind === "allDay") {
        fm.allDay = true;
        delete fm.startTime;
        delete fm.endTime;
        if (!ev.allDay) carriedEnd = convertEndDate(newDate, carriedEnd, true);
      }

      if (carriedEnd) fm.endDate = carriedEnd;
      else delete fm.endDate;

      fm.modified = todayISO();
    });
  }

  async toggleComplete(ev: EventItem): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(ev.path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.completed = ev.completed ? null : todayISO();
      fm.modified = todayISO();
    });
  }

  /**
   * Delete the event note. Uses `trashFile`, so it honours the vault's "Deleted files"
   * setting (system trash / .trash) rather than hard-deleting.
   */
  async deleteEvent(ev: EventItem): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(ev.path);
    if (file instanceof TFile) await this.app.fileManager.trashFile(file);
  }

  /**
   * Delete part or all of a recurring event:
   *  - "single"    → skip just this occurrence (an EXDATE); the series continues.
   *  - "following" → end the series the day before this occurrence.
   *  - "all"       → delete the note outright.
   *
   * A one-off event ignores the scope and is simply deleted.
   */
  async deleteOccurrence(ev: EventItem, occurrenceISO: string, scope: "single" | "following" | "all"): Promise<void> {
    if (!ev.recurrence || scope === "all") return this.deleteEvent(ev);

    if (scope === "single") return this.addExdate(ev, occurrenceISO);

    const untilISO = shiftISO(occurrenceISO, -1) ?? occurrenceISO;
    // Cutting from the first occurrence would leave an empty series — delete it instead.
    if (untilISO < ev.date) return this.deleteEvent(ev);
    await this.setRecurrence(ev, setUntil(ev.recurrence, untilISO));
  }

  /** Non-recurring, not-yet-archived events whose last covered day is before `beforeISO`. */
  pastEvents(beforeISO: string): EventItem[] {
    return this.getEvents().filter(
      (ev) => !ev.recurrence && ev.date && !ev.archived && eventLastCoveredISO(ev) < beforeISO
    );
  }

  /**
   * Move every past event note into the archive folder, preserving its category subfolder,
   * and return how many were moved. Recurring events are left in place.
   */
  async archivePastEvents(beforeISO: string): Promise<number> {
    let moved = 0;
    for (const ev of this.pastEvents(beforeISO)) {
      const file = this.app.vault.getAbstractFileByPath(ev.path);
      if (!(file instanceof TFile)) continue;
      const rel = ev.path.startsWith(this.settings.eventsFolder + "/")
        ? ev.path.slice(this.settings.eventsFolder.length + 1)
        : file.name;
      const dest = this.avoidCollision(normalizePath(`${this.settings.eventsArchiveFolder}/${rel}`));
      await this.ensureParent(dest);
      try {
        await this.app.fileManager.renameFile(file, dest);
        moved++;
      } catch {
        /* skip files that can't be moved */
      }
    }
    return moved;
  }

  private async ensureParent(destPath: string): Promise<void> {
    const parts = destPath.split("/");
    parts.pop(); // drop filename
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          /* already exists / race */
        }
      }
    }
  }

  private avoidCollision(dest: string): string {
    if (!this.app.vault.getAbstractFileByPath(dest)) return dest;
    const dot = dest.lastIndexOf(".");
    const base = dest.slice(0, dot);
    const ext = dest.slice(dot);
    let n = 2;
    let cand = `${base} ${n}${ext}`;
    while (this.app.vault.getAbstractFileByPath(cand)) cand = `${base} ${++n}${ext}`;
    return cand;
  }
}
