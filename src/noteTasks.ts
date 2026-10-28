// Checkbox tasks in the rest of the vault — a to-do jotted in a day note, `- [ ] Call the bank 📅
// 2026-11-02` in a meeting note, a line tagged #task anywhere — read straight from their notes, shown
// beside the Planner's own tasks, and ticked, dated or changed in place on their lines (the step
// window, as a project's steps are). Which lines count, by the settings:
//   - in the day-notes folder: every open box, on the note's own day unless it gives one;
//   - anywhere else: an open box with a date (Dataview field or Tasks emoji) or a #task tag.
// Never: task notes (their boxes are checklists), project notes (their boxes are steps), templates,
// excluded folders, or a line that only links to a task note (the task note is shown already).

import { App, TFile } from "obsidian";
import type { BrewinSettings } from "./settings";
import { parseInlineTask } from "./inlineTask";
import type { ProjectTask } from "./projectTasks";
import type { CalendarItem } from "./types";

/** The open tasks among a note's lines, by the rules above. Pure. */
export function noteTaskLines(o: {
  text: string;
  path: string;
  name: string;
  /** The day note's own date (`YYYY-MM-DD`), or null for any other note. */
  dayDate: string | null;
  /** Read dated or #task lines (outside day notes, this is the only way in). */
  dated: boolean;
  /** Does a `[[link]]` lead to a task note? */
  isTaskLink: (link: string) => boolean;
}): ProjectTask[] {
  const out: ProjectTask[] = [];
  o.text.split("\n").forEach((raw, line) => {
    const t = parseInlineTask(raw);
    if (!t || t.mark !== " ") return;
    const only = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(t.text.trim());
    if (only && o.isTaskLink(only[1])) return;
    const dated = !!(t.scheduled || t.due || t.start);
    const tagged = /(^|\s)#task\b/i.test(raw);
    if (!o.dayDate && !(o.dated && (dated || tagged))) return;
    out.push({
      projectPath: o.path,
      projectName: o.name,
      line,
      raw,
      text: t.text.replace(/(^|\s)#task\b/gi, "$1").replace(/\s+/g, " ").trim(),
      // A day note's line is on its day, unless it says otherwise.
      scheduled: t.scheduled ?? (o.dayDate && !t.due ? o.dayDate : null),
      due: t.due,
      isNext: t.next,
      fromNote: true,
    });
  });
  return out;
}

/** Note tasks as calendar items: one on their do-date, else their deadline. Pure. */
export function noteTasksToItems(tasks: ProjectTask[], fromISO: string, toISO: string): CalendarItem[] {
  const out: CalendarItem[] = [];
  for (const t of tasks) {
    const day = t.scheduled ?? t.due;
    if (!day || day < fromISO || day > toISO) continue;
    out.push({ kind: "note", path: t.projectPath, title: t.text || "(untitled task)", date: day, allDay: true, start: null, end: null, done: false, category: "Notes", recurring: false, line: t.line });
  }
  return out;
}

/** Parsed lines, per note, until the note changes — or the settings that decide them do. */
const cache = new Map<string, { mtime: number; tasks: ProjectTask[] }>();
let cacheSettings = "";

/** A note was written: read it again next time. Its old tasks are kept until then (see `hadNoteTasks`). */
export function forgetNoteTasks(path: string): void {
  const hit = cache.get(path);
  if (hit) hit.mtime = -1;
}

/** Whether a note held note tasks when last read — a change to it can take one away. */
export function hadNoteTasks(path: string): boolean {
  return (cache.get(path)?.tasks.length ?? 0) > 0;
}

export class NoteTaskSource {
  constructor(private app: App, private settings: BrewinSettings) {}

  /** Every open note task in the vault, by the settings' rules. */
  async list(): Promise<ProjectTask[]> {
    const s = this.settings;
    if (!s.noteTasksDayNotes && !s.noteTasksDated) return [];
    const decides = [s.noteTasksDayNotes, s.noteTasksDated, s.dayNotesFolder, s.itemsFolder, s.routinesFolder].join("|");
    if (decides !== cacheSettings) {
      cache.clear();
      cacheSettings = decides;
    }
    const never = [s.itemsFolder, s.routinesFolder, s.doneFolder, s.projectsFolder, s.templatesFolder, ...s.noteTaskExclude].filter(Boolean);
    const out: ProjectTask[] = [];
    const seen = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (never.some((f) => file.path.startsWith(f + "/"))) continue;
      // The metadata cache knows which notes have an open box; only those are read.
      const items = this.app.metadataCache.getFileCache(file)?.listItems;
      if (!items?.some((li) => li.task === " ")) continue;
      const dayDate = this.dayOf(file);
      if (dayDate ? !s.noteTasksDayNotes && !s.noteTasksDated : !s.noteTasksDated) continue;
      seen.add(file.path);
      const hit = cache.get(file.path);
      if (hit && hit.mtime === file.stat.mtime) {
        out.push(...hit.tasks);
        continue;
      }
      // A note read before and changed since is read from disk: the cached copy can trail a write.
      const tasks = noteTaskLines({
        text: hit ? await this.app.vault.read(file) : await this.app.vault.cachedRead(file),
        path: file.path,
        name: file.basename,
        dayDate: s.noteTasksDayNotes ? dayDate : null,
        dated: s.noteTasksDated,
        isTaskLink: (link) => {
          const dest = this.app.metadataCache.getFirstLinkpathDest(link, file.path);
          return !!dest && [s.itemsFolder, s.routinesFolder].some((f) => dest.path.startsWith(f + "/"));
        },
      });
      cache.set(file.path, { mtime: file.stat.mtime, tasks });
      out.push(...tasks);
    }
    // Notes deleted, renamed or emptied of open boxes since.
    for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
    return out;
  }

  /** A day note's date, from its name in the day-notes folder. */
  private dayOf(file: TFile): string | null {
    if (file.parent?.path !== this.settings.dayNotesFolder) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(file.basename) ? file.basename : null;
  }
}
