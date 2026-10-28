import { App, normalizePath, TFile, TFolder } from "obsidian";
import { BrewinSettings } from "./settings";
import { applyTaskToFrontmatter, parentLinkpath, sanitizeFilename, taskFromFrontmatter, TASK_TAG, toWikilink } from "./task";
import { yamlString } from "./yaml";
import { createNote, moveNote, trashNote, writeProperties, writeText } from "./undo";
import { buildIndex, childrenOf, openChildren, wouldCreateCycle } from "./hierarchy";
import { openDependencies } from "./dependencies";
import { completeRecurringOccurrence, currentOccurrenceISO, shiftAnchor, skipRecurringOccurrence, skipThisTime } from "./recurrence";
import { addMinutesHM, dayDelta, shiftISO, todayISO } from "./dates";
import { setUntil, stripEnd } from "./rrule";
import { formatSlot, nextOpenSlot, pruneSlotLog, slotProgress, withSlotToggled } from "./slots";
import { hasContext } from "./contexts";
import type { EditScope } from "./recurrenceScopeModal";
import { Priority, Status, Task, TaskSlot } from "./types";
import { flagRefusal, flagToWrite, StatusFlag } from "./statusFlags";
import { attrToFrontmatter, AttrValue } from "./attributes";
import { ChecklistItem, checklistItems, setChecklistItem } from "./checklist";

export interface NewTaskFields {
  title: string;
  scheduled: string | null;
  startTime?: string | null;
  endTime?: string | null;
  due: string | null;
  priority: Priority;
  contexts: string[];
  recurrence?: string | null;
  recurrenceAnchor?: "scheduled" | "due";
  /** "completion": the next date counts from the day it's done. */
  recurrenceFrom?: "schedule" | "completion";
  body?: string;
  /** Wikilink to a parent task, e.g. `[[Ship v2]]`. */
  parent?: string | null;
  /** Fixed times to repeat at within each day. Turns this into a multi-slot task. */
  times?: TaskSlot[];
  /** Inclusive last day of a multi-day task. */
  endDate?: string | null;
  /** Effort estimate in minutes. */
  estimate?: number | null;
  /** Reminder override: "30m" custom lead, "none" to silence. */
  remind?: string | null;
  /** At-the-time reminder override; null defers to the global setting. */
  remindStart?: boolean | null;
  /** Wikilinks to tasks this one depends on. Blocks completion only. */
  dependsOn?: string[];
  /** Wikilink to the project note this task belongs to. */
  project?: string | null;
  /** ISO "YYYY-MM" this task is dedicated to — see `Task.month`. */
  month?: string | null;
  /** ISO week label ("2026-W37") this task is dedicated to — see `Task.week`. */
  week?: string | null;
}

/** Outcome of a completion attempt — `ok:false` means it was blocked by open subtasks and/or
 *  unfinished dependencies. */
export interface CompleteResult {
  ok: boolean;
  /** How many subtasks are still open (only meaningful when blocked). */
  open: number;
  /** How many dependencies aren't done yet (only meaningful when blocked). Kept separate from
   *  `open` — a subtask and a dependency are refused for different reasons and read differently
   *  in the UI ("2 subtasks still open" vs. "waiting on 1 other task"). */
  blocked: number;
}

/** Reads and mutates the task-note collection. All file I/O lives here. */
/** A task's fields as a new task would take them — for an occurrence moved onto a note of its own. */
export function fieldsOf(task: Task, scheduled: string): NewTaskFields {
  return {
    title: task.title,
    scheduled,
    startTime: task.startTime,
    endTime: task.endTime,
    due: task.due,
    priority: task.priority,
    contexts: task.contexts,
    parent: task.parent,
    recurrence: task.recurrence,
    recurrenceAnchor: task.recurrenceAnchor,
    recurrenceFrom: task.recurrenceFrom,
    endDate: task.endDate,
    estimate: task.estimate,
    remind: task.remind,
    remindStart: task.remindStart,
    times: task.times,
    dependsOn: task.dependsOn,
  };
}

export class TaskStore {
  constructor(private app: App, private settings: BrewinSettings) {}

  /** The tasks as last read, and by path — rebuilt only after a change (see `invalidate`). */
  private index: { list: Task[]; byPath: Map<string, Task> } | null = null;

  /**
   * Forget what was read, so the next read builds the list afresh. The plugin calls this on every
   * metadata, create, delete and rename event that could change a task. Building it means reading all
   * 9,000-odd notes, and the views asked for it several times per redraw (the Review page once a row).
   */
  invalidate(): void {
    this.index = null;
  }

  /**
   * All task notes under the Items + Routines folders (identified by the `task` tag). A new array each
   * time; the tasks in it are shared with every other caller, so they are never changed in place.
   */
  getTasks(): Task[] {
    return [...this.read().list];
  }

  private read(): { list: Task[]; byPath: Map<string, Task> } {
    if (!this.index) {
      const list = this.scan();
      this.index = { list, byPath: new Map(list.map((t) => [t.path, t])) };
    }
    return this.index;
  }

  /** Read every task note from the metadata cache — what `getTasks` used to do on every call. */
  private scan(): Task[] {
    const folders = [this.settings.itemsFolder, this.settings.routinesFolder];
    const out: Task[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!folders.some((f) => file.path.startsWith(f + "/") || file.path === f)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
      const tags = collectTags(fm, cache);
      if (!tags.includes(TASK_TAG)) continue;
      const task = taskFromFrontmatter(fm, file.path, file.basename, this.settings.statusFlags, this.settings.attributes);
      task.parentPath = this.resolveParentPath(task.parent, file.path);
      task.dependsOnPaths = this.resolveLinkPaths(task.dependsOn, file.path);
      task.projectPath = this.resolveParentPath(task.project, file.path);
      // The checklist in its body (its `- [ ]` lines), counted from the metadata cache — no read.
      const boxes = cache?.listItems?.filter((li) => li.task !== undefined) ?? [];
      task.checklist = boxes.length ? { done: boxes.filter((li) => li.task !== " ").length, total: boxes.length } : null;
      out.push(task);
    }
    return out;
  }

  /** Resolve a stored `parent:` wikilink to a vault path (null when unset or dangling). */
  private resolveParentPath(parent: string | null, sourcePath: string): string | null {
    const linkpath = parentLinkpath(parent);
    if (!linkpath) return null;
    const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    return dest ? dest.path : null;
  }

  /** Same resolution as `resolveParentPath`, over a list — dangling links are dropped rather
   *  than kept as unresolvable paths. */
  private resolveLinkPaths(links: string[], sourcePath: string): string[] {
    const out: string[] = [];
    for (const link of links) {
      const linkpath = parentLinkpath(link);
      if (!linkpath) continue;
      const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      if (dest) out.push(dest.path);
    }
    return out;
  }

  /** All tasks plus a prebuilt hierarchy index (children, ancestors, cycle checks). */
  getIndexedTasks(): { tasks: Task[]; index: ReturnType<typeof buildIndex> } {
    const tasks = this.getTasks();
    return { tasks, index: buildIndex(tasks) };
  }

  private async ensureFolder(path: string): Promise<void> {
    const norm = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(norm);
    if (existing instanceof TFolder) return;
    if (existing) return;
    try {
      await this.app.vault.createFolder(norm);
    } catch {
      /* already exists / race — ignore */
    }
  }

  private uniquePath(folder: string, title: string): string {
    const safe = sanitizeFilename(title) || "Untitled task";
    let candidate = normalizePath(`${folder}/${safe}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folder}/${safe} ${n}.md`);
      n++;
    }
    return candidate;
  }

  async createTask(fields: NewTaskFields): Promise<TFile> {
    const recurring = !!fields.recurrence;
    const folder = recurring ? this.settings.routinesFolder : this.settings.itemsFolder;
    await this.ensureFolder(folder);
    const path = this.uniquePath(folder, fields.title);
    const today = todayISO();

    const fm: string[] = [
      "---",
      // Free text is quoted where YAML would misread it (see yaml.ts); links and rules always are.
      `up: ${JSON.stringify(`[[${this.settings.hubNote}]]`)}`,
      "tags:",
      `  - ${TASK_TAG}`,
      "status: todo",
      `scheduled: ${fields.scheduled ?? ""}`,
      ...(fields.endDate ? [`endDate: ${fields.endDate}`] : []),
      ...(fields.startTime ? [`startTime: ${fields.startTime}`] : []),
      ...(fields.startTime && fields.endTime ? [`endTime: ${fields.endTime}`] : []),
      `due: ${fields.due ?? ""}`,
      `priority: ${fields.priority}`,
      ...(fields.estimate ? [`estimate: ${fields.estimate}`] : []),
      ...(fields.remind ? [`remind: ${yamlString(fields.remind)}`] : []),
      ...(fields.remindStart != null ? [`remind_start: ${fields.remindStart}`] : []),
      `contexts: [${fields.contexts.map((c) => yamlString(c, { flow: true })).join(", ")}]`,
    ];
    if (fields.month) fm.push(`month: ${yamlString(fields.month)}`);
    if (fields.week) fm.push(`week: ${yamlString(fields.week)}`);
    if (fields.parent) fm.push(`parent: ${JSON.stringify(fields.parent)}`);
    if (fields.project) fm.push(`project: ${JSON.stringify(fields.project)}`);
    if (fields.dependsOn?.length) {
      fm.push("depends_on:");
      for (const link of fields.dependsOn) fm.push(`  - ${JSON.stringify(link)}`);
    }
    if (recurring) {
      fm.push(`recurrence: ${JSON.stringify(fields.recurrence)}`);
      fm.push(`recurrence_anchor: ${fields.recurrenceAnchor ?? "scheduled"}`);
      if (fields.recurrenceFrom === "completion") fm.push("recurrence_from: completion");
      fm.push("complete_instances: []");
      fm.push("on_completion: keep");
    }
    if (fields.times?.length) {
      fm.push("times:");
      for (const s of fields.times) fm.push(`  - ${JSON.stringify(formatSlot(s))}`);
      fm.push("complete_slots: {}");
    }
    fm.push(`created: ${today}`, "completed:", `modified: ${today}`, "---", "");

    const body = `# ${fields.title}\n${fields.body ? "\n" + fields.body + "\n" : ""}`;
    return createNote(this.app, path, fm.join("\n") + "\n" + body);
  }

  /**
   * Create a parent task and its subtasks in one go. The parent is created first so the
   * children can link to it by basename.
   */
  async createWithSubtasks(fields: NewTaskFields, childTitles: string[]): Promise<TFile> {
    const parentFile = await this.createTask(fields);
    const link = toWikilink(parentFile.basename);
    for (const raw of childTitles) {
      const title = raw.trim();
      if (!title) continue;
      await this.createTask({
        title,
        scheduled: null,
        due: null,
        priority: "normal",
        contexts: fields.contexts,
        parent: link,
      });
    }
    return parentFile;
  }

  /** Add a subtask under an existing task. */
  async addSubtask(parent: Task, title: string): Promise<void> {
    const clean = title.trim();
    if (!clean) return;
    const basename = parent.path.split("/").pop()?.replace(/\.md$/, "") ?? parent.title;
    await this.createTask({
      title: clean,
      scheduled: null,
      due: null,
      priority: "normal",
      contexts: parent.contexts,
      parent: toWikilink(basename),
    });
  }

  /**
   * Point a task at a new parent (or clear it). Refuses self-parenting and cycles.
   * Returns false when the change was rejected.
   */
  async setParent(task: Task, parent: Task | null): Promise<boolean> {
    const { tasks, index } = this.getIndexedTasks();
    void tasks;
    if (parent && wouldCreateCycle(index, task, parent.path)) return false;
    const link = parent ? toWikilink(parent.path.split("/").pop()?.replace(/\.md$/, "") ?? parent.title) : null;
    const file = this.fileFor(task);
    if (!file) return false;
    await writeProperties(this.app, file, (fm) => {
      if (link) fm.parent = link;
      else delete fm.parent;
      fm.modified = todayISO();
    });
    return true;
  }

  /**
   * Put a task note in a project (or take it out, with `null`). The link is by basename, the same
   * way `parent:` links are written, so renaming the project note keeps it attached.
   */
  async setProject(task: Task, projectPath: string | null): Promise<void> {
    const file = this.fileFor(task);
    if (!file) return;
    const link = projectPath ? toWikilink(projectPath.split("/").pop()?.replace(/\.md$/, "") ?? projectPath) : null;
    await writeProperties(this.app, file, (fm) => {
      if (link) fm.project = link;
      else delete fm.project;
      fm.modified = todayISO();
    });
  }

  /**
   * Schedule a task for a day and make it active again in the same write — a Someday or on-hold
   * task dropped on Today is wanted today. One write, because a second one built from the same
   * task object would put the old status straight back (the metadata cache lags a write).
   */
  async moveToDay(task: Task, iso: string): Promise<void> {
    const endDate =
      task.endDate && task.scheduled ? shiftISO(task.endDate, dayDelta(task.scheduled, iso)) : task.endDate;
    await this.persist({ ...task, status: "todo", scheduled: iso, endDate });
  }

  /** Undated and active again: what "back to the inbox" means. A due date is kept — a deadline
   *  is a fact about the task, not a plan for it. */
  async backToInbox(task: Task): Promise<void> {
    await this.persist({ ...task, status: "todo", scheduled: null, startTime: null, endTime: null, endDate: null });
  }

  getByPath(path: string): Task | null {
    return this.read().byPath.get(path) ?? null;
  }

  /**
   * Rename a task by renaming its note file — the filename IS the task title.
   *
   * Uses `fileManager.renameFile`, so Obsidian rewrites every inbound wikilink (including
   * subtasks' `parent:` links). A repair pass afterwards re-points any child that still
   * references the old name, so the hierarchy stays intact regardless.
   *
   * Returns the new path, or null if nothing happened.
   */
  async rename(task: Task, newTitle: string): Promise<string | null> {
    const file = this.fileFor(task);
    if (!file) return null;
    const safe = sanitizeFilename(newTitle);
    if (!safe) return null; // nothing usable left — keep the current filename

    const folder = file.parent?.path ?? this.settings.itemsFolder;
    const plain = normalizePath(`${folder}/${safe}.md`);
    if (plain === file.path) return file.path; // name unchanged after sanitising

    const oldBase = file.basename;
    const kids = childrenOf(this.getIndexedTasks().index, task);
    const dest = this.uniquePath(folder, safe);
    await moveNote(this.app, file, dest);
    const newBase = dest.split("/").pop()!.replace(/\.md$/, "");

    // Safety net: ensure children point at the new name.
    for (const kid of kids) {
      const kf = this.app.vault.getAbstractFileByPath(kid.path);
      if (!(kf instanceof TFile)) continue;
      await writeProperties(this.app, kf, (fm) => {
        if (parentLinkpath(fm.parent ? String(fm.parent) : null) === oldBase) {
          fm.parent = toWikilink(newBase);
        }
      });
    }

    // The filename is now the title — drop any stale `title:` override.
    const moved = this.app.vault.getAbstractFileByPath(dest);
    if (moved instanceof TFile) {
      await writeProperties(this.app, moved, (fm) => {
        delete fm.title;
        fm.modified = todayISO();
      });
    }
    return dest;
  }

  /**
   * Delete a task note. Uses `trashFile`, so it honours the vault's "Deleted files"
   * setting (system trash / .trash / permanent) rather than hard-deleting.
   *
   * @param withSubtasks true → delete the whole subtree; false → keep the children and
   *                     clear their `parent:` link so nothing dangles.
   * @returns how many notes were removed.
   */
  async deleteTask(task: Task, withSubtasks: boolean): Promise<number> {
    const { index } = this.getIndexedTasks();
    const kids = childrenOf(index, task);
    let removed = 0;

    if (withSubtasks) {
      // Depth-first so descendants go before their parents.
      for (const kid of kids) removed += await this.deleteTask(kid, true);
    } else {
      for (const kid of kids) {
        const kf = this.app.vault.getAbstractFileByPath(kid.path);
        if (!(kf instanceof TFile)) continue;
        await writeProperties(this.app, kf, (fm) => {
          delete fm.parent;
          fm.modified = todayISO();
        });
      }
    }

    const file = this.fileFor(task);
    if (file) {
      await trashNote(this.app, file);
      removed++;
    }
    return removed;
  }

  /** The note body — everything after the frontmatter and the leading `# Heading`. */
  async getBody(task: Task): Promise<string> {
    const file = this.fileFor(task);
    if (!file) return "";
    const text = await this.app.vault.read(file);
    const afterFm = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
    return afterFm.replace(/^\s*#\s+[^\n]*\n?/, "").trim();
  }

  /**
   * Rewrite the note body, leaving the frontmatter block byte-identical. The existing
   * `# Heading` is preserved verbatim unless `retitleTo` is given (i.e. the user actually
   * renamed the task) — so opening a task and saving it unchanged is a true no-op.
   */
  /** The checklist in a task note's body, as the note now reads (not the cache: it follows a tick). */
  async checklist(task: Task): Promise<ChecklistItem[]> {
    const file = this.fileFor(task);
    return file ? checklistItems(await this.app.vault.read(file)) : [];
  }

  /** Tick or untick one checklist item in place. False when its line has changed since it was read. */
  async tickChecklist(task: Task, item: ChecklistItem, done: boolean): Promise<boolean> {
    const file = this.fileFor(task);
    if (!file) return false;
    let ok = false;
    await writeText(this.app, file, (text) => {
      const next = setChecklistItem(text, item, done);
      ok = next !== null;
      return next ?? text;
    });
    return ok;
  }

  async setBody(task: Task, body: string, retitleTo?: string): Promise<void> {
    const file = this.fileFor(task);
    if (!file) return;
    // One atomic read-and-write, so nothing written to the note in between is lost.
    await writeText(this.app, file, (text) => {
      const fm = /^---\n[\s\S]*?\n---\n?/.exec(text)?.[0] ?? "";
      const afterFm = text.slice(fm.length);
      const existingHeading = /^\s*#\s+[^\n]*\n?/.exec(afterFm)?.[0].replace(/^\s+/, "");
      const heading = retitleTo !== undefined ? `# ${retitleTo}\n` : existingHeading ?? `# ${task.title}\n`;
      return `${fm}\n${heading}${body.trim() ? "\n" + body.trim() + "\n" : ""}`;
    });
  }

  private fileFor(task: Task): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(task.path);
    return f instanceof TFile ? f : null;
  }

  async persist(task: Task): Promise<void> {
    const file = this.fileFor(task);
    if (!file) return;
    await writeProperties(this.app, file, (fm) => {
      applyTaskToFrontmatter(fm, task);
      fm.modified = todayISO();
    });
  }

  /**
   * Move a task's do-date. A multi-day task's `endDate` moves the SAME number of days along
   * with it, so dragging a spanning task ("Run 10k" Fri→Sun) to a new week keeps it a 3-day
   * span instead of collapsing it (endDate is an absolute date, not an offset — left alone,
   * it would end up before the new start, or detached from it entirely).
   */
  async setScheduled(task: Task, iso: string | null): Promise<void> {
    const endDate =
      task.endDate && task.scheduled && iso ? shiftISO(task.endDate, dayDelta(task.scheduled, iso)) : task.endDate;
    await this.persist({ ...task, scheduled: iso, endDate });
  }

  /**
   * Place a task on the calendar. Passing a `startTime` turns it into a timed block;
   * passing null clears the times and returns it to the all-day band. The end time
   * defaults to `defaultMinutes` after the start when not given explicitly.
   */
  async scheduleAt(
    task: Task,
    dateISO: string,
    startTime: string | null,
    endTime: string | null,
    defaultMinutes = 60
  ): Promise<void> {
    const start = startTime;
    const end = start ? endTime ?? addMinutesHM(start, defaultMinutes) : null;
    await this.persist({ ...task, scheduled: dateISO, startTime: start, endTime: end });
  }

  /** Set or clear a task's times without moving its date (duration preserved on move). */
  async setTimes(task: Task, startTime: string | null, endTime: string | null): Promise<void> {
    await this.persist({ ...task, startTime, endTime: startTime ? endTime : null });
  }

  /** Edit arbitrary task fields from the calendar edit modal. */
  async updateFields(
    task: Task,
    // NOTE: no `title` — a task is renamed by renaming its file (see `rename`).
    f: Partial<
      Pick<Task, "scheduled" | "startTime" | "endTime" | "due" | "priority" | "status" | "flag" | "contexts" | "recurrence" | "recurrenceAnchor" | "recurrenceFrom" | "parent" | "times" | "endDate" | "estimate" | "remind" | "remindStart" | "dependsOn" | "month" | "week" | "project">
    >
    /** @returns the task's path, which changes if the edit moved the note. */
  ): Promise<string> {
    const file = this.fileFor(task);
    if (!file) return task.path;
    // Defensive: never let an edit set `done` while subtasks are open (the modal checks
    // first and warns; this keeps the invariant true even if a caller forgets).
    const status = f.status === "done" && !this.checkComplete(task).ok ? undefined : f.status;
    await writeProperties(this.app, file, (fm) => {
      if (f.scheduled !== undefined) fm.scheduled = f.scheduled ?? null;
      if (f.startTime !== undefined) {
        if (f.startTime) fm.startTime = f.startTime;
        else delete fm.startTime;
      }
      if (f.endTime !== undefined) {
        if (f.endTime && f.startTime !== null) fm.endTime = f.endTime;
        else delete fm.endTime;
      }
      if (f.endDate !== undefined) {
        if (f.endDate) fm.endDate = f.endDate;
        else delete fm.endDate;
      }
      if (f.due !== undefined) fm.due = f.due ?? null;
      if (f.priority !== undefined) fm.priority = f.priority;
      if (f.estimate !== undefined) {
        if (f.estimate) fm.estimate = f.estimate;
        else delete fm.estimate;
      }
      if (f.remind !== undefined) {
        if (f.remind) fm.remind = f.remind;
        else delete fm.remind;
      }
      if (f.remindStart !== undefined) {
        if (f.remindStart != null) fm.remind_start = f.remindStart;
        else delete fm.remind_start;
      }
      if (status !== undefined) fm.status = status;
      // Marked done here (from the edit window's Status, or a flag standing for Done): it gets its
      // completed date as a tick would give it, and loses it again if it is opened back up.
      if (status === "done" && task.status !== "done" && !fm.completed) fm.completed = todayISO();
      if (status !== undefined && status !== "done" && task.status === "done") delete fm.completed;
      // A new flag, or a new status the old flag may no longer match.
      if (f.flag !== undefined || status !== undefined) {
        const flag = flagToWrite(f.flag !== undefined ? f.flag : task.flag, status ?? task.status);
        if (flag) fm.flag = flag;
        else delete fm.flag;
      }
      if (f.contexts !== undefined) fm.contexts = f.contexts;
      if (f.parent !== undefined) {
        if (f.parent) fm.parent = f.parent;
        else delete fm.parent;
      }
      if (f.project !== undefined) {
        if (f.project) fm.project = f.project;
        else delete fm.project;
      }
      if (f.dependsOn !== undefined) {
        if (f.dependsOn.length) fm.depends_on = f.dependsOn;
        else delete fm.depends_on;
      }
      if (f.month !== undefined) {
        if (f.month) fm.month = f.month;
        else delete fm.month;
      }
      if (f.week !== undefined) {
        if (f.week) fm.week = f.week;
        else delete fm.week;
      }
      if (f.recurrence !== undefined) {
        if (f.recurrence) {
          fm.recurrence = f.recurrence;
          fm.recurrence_anchor = f.recurrenceAnchor ?? "scheduled";
        } else {
          delete fm.recurrence;
          delete fm.recurrence_from;
        }
      }
      if (f.recurrenceFrom !== undefined && (f.recurrence ?? task.recurrence)) {
        if (f.recurrenceFrom === "completion") fm.recurrence_from = "completion";
        else delete fm.recurrence_from;
      }
      if (f.times !== undefined) {
        if (f.times.length) {
          fm.times = f.times.map(formatSlot);
          if (fm.complete_slots == null) fm.complete_slots = {};
        } else {
          // Dropping the slots drops their log too — it would otherwise be orphaned data
          // describing times the task no longer has.
          delete fm.times;
          delete fm.complete_slots;
        }
      }
      fm.modified = todayISO();
    });

    // Recurrence decides which folder a task lives in — adding or removing it on an
    // existing task has to move the note, not just rewrite the field.
    if (f.recurrence !== undefined) return this.relocateForRecurrence(task, !!f.recurrence);
    return task.path;
  }

  /**
   * Keep a task in the folder its recurrence implies (Routines for recurring, Items for
   * one-offs). Completed tasks already filed under the Done folder are left alone.
   */
  private async relocateForRecurrence(task: Task, recurring: boolean): Promise<string> {
    const file = this.fileFor(task);
    if (!file) return task.path;
    if (task.path.startsWith(this.settings.doneFolder + "/")) return task.path;

    const target = recurring ? this.settings.routinesFolder : this.settings.itemsFolder;
    if (task.path.startsWith(target + "/")) return task.path; // already correct

    await this.ensureFolder(target);
    const dest = this.uniquePath(target, file.basename);
    try {
      await moveNote(this.app, file, dest);
      return dest;
    } catch {
      return task.path;
    }
  }

  async setRecurrence(task: Task, rrule: string): Promise<void> {
    const file = this.fileFor(task);
    if (!file) return;
    await writeProperties(this.app, file, (fm) => {
      fm.recurrence = rrule;
      fm.modified = todayISO();
    });
  }

  /** Add a recurrence exception (skip this occurrence date) — mirrors `EventStore.addExdate`. */
  async addExdate(task: Task, iso: string): Promise<void> {
    const file = this.fileFor(task);
    if (!file) return;
    await writeProperties(this.app, file, (fm) => {
      const cur: string[] = Array.isArray(fm.recurrence_exdates) ? fm.recurrence_exdates.map(String) : [];
      if (!cur.includes(iso)) cur.push(iso);
      fm.recurrence_exdates = cur.sort();
      fm.modified = todayISO();
    });
  }

  /**
   * Apply an edit (from a drag or the capture modal) to a recurring task at the clicked
   * occurrence — mirrors `EventStore.applyRecurringEdit` exactly:
   *  - "all": shift the whole series by however far this occurrence moved, then write every
   *    other field onto the same note (the only scope that reuses `updateFields`, so rename/
   *    body/subtask handling around this call in the caller still applies).
   *  - "single": skip this occurrence in the series (+ advance the anchor past it, if this WAS
   *    the anchor — otherwise the note is left sitting on a date it no longer owns) and create
   *    a standalone edited task at the new date.
   *  - "following": end the series the day before this occurrence, then start a new edited
   *    series here. Collapses to "all" when the occurrence IS the series' own start — splitting
   *    there would strand the tail before the series ever begins.
   *
   * Returns the resulting path of the ORIGINAL note (unchanged for "single"/"following" — the
   * edit landed on a new sibling note instead; only "all" can move the original).
   */
  async applyRecurringEdit(original: Task, occurrenceISO: string, scope: EditScope, f: NewTaskFields): Promise<string> {
    if (scope === "all") {
      const { scheduled, due } = shiftAnchor(original, occurrenceISO, f.scheduled ?? occurrenceISO);
      return this.updateFields(original, {
        scheduled,
        due,
        startTime: f.startTime ?? null,
        endTime: f.endTime ?? null,
        priority: f.priority,
        contexts: f.contexts,
        parent: f.parent ?? null,
        project: f.project ?? null,
        recurrence: f.recurrence ?? original.recurrence,
        recurrenceAnchor: f.recurrenceAnchor,
        recurrenceFrom: f.recurrenceFrom,
        endDate: f.endDate ?? null,
        estimate: f.estimate ?? null,
        remind: f.remind ?? null,
        remindStart: f.remindStart ?? null,
        times: f.times ?? [],
        dependsOn: f.dependsOn ?? [],
      });
    }

    if (scope === "single") {
      await this.addExdate(original, occurrenceISO);
      const currentAnchor = original.recurrenceAnchor === "due" ? original.due : original.scheduled;
      if (currentAnchor === occurrenceISO) {
        // The exception just written goes into what is persisted, or that write would drop it again
        // (and the reviews would count the moved occurrence as missed).
        const withExdate = { ...original, exdates: [...new Set([...original.exdates, occurrenceISO])].sort() };
        const res = skipRecurringOccurrence(withExdate, occurrenceISO, todayISO());
        await this.persist(res.task);
        if (res.ended && res.archive) await this.archiveNote(res.task);
      }
      await this.createTask({ ...f, recurrence: null });
      return original.path;
    }

    // "following" — starting from the series' own first occurrence is just "all"; splitting
    // there would end the original series before its own start date.
    if (occurrenceISO <= (original.scheduled ?? occurrenceISO)) {
      return this.applyRecurringEdit(original, occurrenceISO, "all", f);
    }
    const untilISO = shiftISO(occurrenceISO, -1) ?? occurrenceISO;
    await this.setRecurrence(original, setUntil(original.recurrence ?? "", untilISO));
    await this.createTask({ ...f, recurrence: stripEnd(f.recurrence || original.recurrence || "") });
    return original.path;
  }

  /**
   * "Skip this time": a repeating task's current occurrence let go, and on to its next — see
   * `skipThisTime`. The next date, or null when that was the series' last.
   */
  async skipOccurrence(task: Task): Promise<string | null> {
    if (!task.recurrence) return null;
    const res = skipThisTime(task, currentOccurrenceISO(task) ?? todayISO(), todayISO());
    await this.persist(res.task);
    if (res.ended && res.archive) await this.archiveNote(res.task);
    return res.ended ? null : currentOccurrenceISO(res.task);
  }

  /** Star a task as one of `day`'s top three (or take the star off, with null). */
  async setTop(task: Task, day: string | null): Promise<void> {
    await this.persist({ ...task, top: day });
  }

  async setDue(task: Task, iso: string | null): Promise<void> {
    await this.persist({ ...task, due: iso });
  }

  /** A built-in status — which also takes off any status flag the task had. */
  async setStatus(task: Task, status: Status): Promise<void> {
    await this.persist(withStatus(task, status));
  }

  /**
   * Give a task one of the user's status flags, and with it the status the flag stands for.
   * Returns why not when it can't: a repeating task can't be flagged into Someday or Done, and a
   * Done flag is refused while subtasks or dependencies are open, as ticking the task would be.
   */
  async setFlag(task: Task, flag: StatusFlag): Promise<string | null> {
    const refused = flagRefusal(task, flag);
    if (refused) return refused;
    if (flag.base === "done") {
      const check = this.checkComplete(task);
      if (!check.ok) {
        return [
          check.open ? `has ${check.open} subtask${check.open === 1 ? "" : "s"} still open` : null,
          check.blocked ? `is waiting on ${check.blocked} other task${check.blocked === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" and ");
      }
      await this.persist({ ...task, status: "done", completed: task.completed ?? todayISO(), flag });
      return null;
    }
    await this.persist(withStatus(task, flag.base, flag));
    return null;
  }

  /**
   * Set the user's own attributes on a task: a value per key; "" to keep the property on the note
   * but empty (a yes/no one as "no"); null to take the property off. Attributes are frontmatter
   * properties nothing else in the Planner writes, so this touches only those keys.
   */
  async setAttrs(path: string, values: Record<string, AttrValue | null>): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || !Object.keys(values).length) return;
    const defs = new Map(this.settings.attributes.map((a) => [a.key, a]));
    await writeProperties(this.app, file, (fm) => {
      for (const [key, v] of Object.entries(values)) {
        const attr = defs.get(key);
        if (!attr) continue;
        if (v === null) delete fm[key];
        else if (v === "") fm[key] = attr.kind === "bool" ? false : null;
        else fm[key] = attrToFrontmatter(attr, v);
      }
      fm.modified = todayISO();
    });
  }

  /** Take a task's flag off, leaving its status as it is. */
  async clearFlag(task: Task): Promise<void> {
    await this.persist({ ...task, flag: null });
  }

  async setPriority(task: Task, priority: Priority): Promise<void> {
    await this.persist({ ...task, priority });
  }

  /** Assign (or clear, with `null`) which month's calendar panel a task belongs to. */
  async setMonth(task: Task, month: string | null): Promise<void> {
    await this.persist({ ...task, month });
  }

  /** Tasks dedicated to a given ISO "YYYY-MM" month — see `Task.month`. */
  tasksForMonth(month: string): Task[] {
    return this.getTasks().filter((t) => t.month === month);
  }

  /** Assign (or clear, with `null`) which week's calendar panel a task belongs to. */
  async setWeek(task: Task, week: string | null): Promise<void> {
    await this.persist({ ...task, week });
  }

  /** Tasks dedicated to a given ISO week label ("2026-W37") — see `Task.week`. */
  tasksForWeek(week: string): Task[] {
    return this.getTasks().filter((t) => t.week === week);
  }

  /** May this task be completed right now? `open` counts blocking subtasks, `blocked` counts
   *  unfinished dependencies — refused for either. */
  checkComplete(task: Task): CompleteResult {
    const { tasks, index } = this.getIndexedTasks();
    const open = openChildren(index, task).length;
    const blocked = openDependencies(tasks, task).length;
    return { ok: open === 0 && blocked === 0, open, blocked };
  }

  /**
   * Complete a task. Recurring tasks advance to the next occurrence; one-offs are marked done.
   *
   * Enforces the hierarchy invariant: a parent with open subtasks is NOT completed and no
   * write happens — the guard lives here so every call path (dashboard, calendar, command)
   * is protected, not just the button that happens to be wired up.
   */
  async complete(task: Task): Promise<CompleteResult> {
    const check = this.checkComplete(task);
    if (!check.ok) return check;

    // A multi-slot task ticks its next open slot rather than completing outright — the day
    // only closes (and the date rolls forward) once the last slot is done.
    if (task.times?.length) {
      const next = nextOpenSlot(task.times, task.completeSlots ?? {}, todayISO());
      if (!next) return { ok: true, open: 0, blocked: 0 }; // every slot already ticked
      return this.toggleSlot(task, next.time);
    }

    if (task.recurrence) {
      const occ = currentOccurrenceISO(task) ?? todayISO();
      const res = completeRecurringOccurrence(task, occ, todayISO());
      await this.persist(res.task);
      if (res.ended && res.archive) await this.archiveNote(res.task);
      return { ok: true, open: 0, blocked: 0 };
    }
    await this.persist({ ...task, status: "done", completed: todayISO() });
    return { ok: true, open: 0, blocked: 0 };
  }

  // ── Bulk operations ────────────────────────────────────────────────────────
  //
  // Triage is the bottleneck: most captured tasks arrive undated, and processing them one
  // modal at a time is why an inbox stops draining. These act on a selection in one pass.
  // Each returns how many were actually changed, so the caller can report honestly rather
  // than claiming a count it didn't achieve.

  /** Give every selected task the same do-date (null clears it). */
  async bulkSchedule(tasks: Task[], iso: string | null): Promise<number> {
    let n = 0;
    for (const task of tasks) {
      await this.persist({ ...task, scheduled: iso });
      n++;
    }
    return n;
  }

  /**
   * "Push all overdue to today" — moves ONLY `scheduled`, never `due`. The deadline stays
   * visible as already-passed; that distinction (a missed *scheduled* day vs. a missed *due*
   * date) is the whole point of separating overdue from slipped in the Attention view.
   */
  async bulkReschedule(tasks: Task[], iso: string): Promise<number> {
    let n = 0;
    for (const task of tasks) {
      await this.persist({ ...task, scheduled: iso });
      n++;
    }
    return n;
  }

  /** Add a context to each selected task, skipping any that already carry it. */
  async bulkAddContext(tasks: Task[], context: string): Promise<number> {
    const value = context.trim();
    if (!value) return 0;
    let n = 0;
    for (const task of tasks) {
      if (hasContext(task.contexts, value)) continue;
      await this.persist({ ...task, contexts: [...task.contexts, value] });
      n++;
    }
    return n;
  }

  /** Remove a context from each selected task (case-insensitive). */
  async bulkRemoveContext(tasks: Task[], context: string): Promise<number> {
    const value = context.trim().toLowerCase();
    let n = 0;
    for (const task of tasks) {
      if (!hasContext(task.contexts, value)) continue;
      await this.persist({ ...task, contexts: task.contexts.filter((c) => c.toLowerCase() !== value) });
      n++;
    }
    return n;
  }

  async bulkSetPriority(tasks: Task[], priority: Priority): Promise<number> {
    let n = 0;
    for (const task of tasks) {
      if (task.priority === priority) continue;
      await this.persist({ ...task, priority });
      n++;
    }
    return n;
  }

  async bulkSetEstimate(tasks: Task[], minutes: number | null): Promise<number> {
    let n = 0;
    for (const task of tasks) {
      await this.persist({ ...task, estimate: minutes });
      n++;
    }
    return n;
  }

  async bulkSetStatus(tasks: Task[], status: Status): Promise<number> {
    let n = 0;
    for (const task of tasks) {
      if (task.status === status) continue;
      await this.persist(withStatus(task, status));
      n++;
    }
    return n;
  }

  /**
   * Complete a selection. Goes through `complete()` per task so the subtask invariant and
   * the recurrence advance both still hold; returns what was blocked so the caller can say so.
   */
  async bulkComplete(tasks: Task[]): Promise<{ done: number; blocked: Task[] }> {
    let done = 0;
    const blocked: Task[] = [];
    for (const task of tasks) {
      const res = await this.complete(task);
      if (res.ok) done++;
      else blocked.push(task);
    }
    return { done, blocked };
  }

  /**
   * Delete a selection. Subtasks are kept and un-parented rather than deleted with them —
   * a bulk action shouldn't quietly remove notes the user didn't have selected.
   * Returns the total number of notes removed.
   */
  async bulkDelete(tasks: Task[]): Promise<number> {
    let n = 0;
    for (const task of tasks) n += await this.deleteTask(task, false);
    return n;
  }

  async reopen(task: Task): Promise<void> {
    await this.persist({ ...task, status: "todo", completed: null });
  }

  /**
   * Tick (or untick) one time-slot for a day.
   *
   * When that closes the day — the last slot is now done — the task rolls forward to its
   * next occurrence exactly as a normal recurring completion would, so it disappears from
   * Today and comes back tomorrow with a clean sheet. Unticking the last slot on a day that
   * had already closed simply reopens it; the date isn't rolled back, because the task has
   * already moved on and guessing which occurrence to return to would be wrong more often
   * than right.
   */
  async toggleSlot(task: Task, time: string, dateISO = todayISO()): Promise<CompleteResult> {
    const check = this.checkComplete(task);
    if (!check.ok) return check;

    const slots = task.times ?? [];
    const before = slotProgress(slots, task.completeSlots ?? {}, dateISO);
    const completeSlots = pruneSlotLog(
      withSlotToggled(task.completeSlots ?? {}, dateISO, time),
      dateISO
    );
    const after = slotProgress(slots, completeSlots, dateISO);

    // The day just closed → advance the series.
    if (!before.dayComplete && after.dayComplete) {
      const withLog = { ...task, completeSlots };
      if (task.recurrence) {
        const occ = currentOccurrenceISO(task) ?? dateISO;
        const res = completeRecurringOccurrence(withLog, occ, dateISO);
        await this.persist(res.task);
        if (res.ended && res.archive) await this.archiveNote(res.task);
        return { ok: true, open: 0, blocked: 0 };
      }
      // Not recurring: a one-off with slots is simply finished.
      await this.persist({ ...withLog, status: "done", completed: dateISO });
      return { ok: true, open: 0, blocked: 0 };
    }

    await this.persist({ ...task, completeSlots, status: "todo", completed: null });
    return { ok: true, open: 0, blocked: 0 };
  }

  private async archiveNote(task: Task): Promise<void> {
    const file = this.fileFor(task);
    if (!file) return;
    await this.ensureFolder(this.settings.doneFolder);
    const dest = this.uniquePath(this.settings.doneFolder, task.title);
    await moveNote(this.app, file, dest);
  }

  /** File the given tasks into the Done folder. Returns how many moved. */
  async archiveTasks(tasks: Task[]): Promise<number> {
    let moved = 0;
    for (const task of tasks) {
      await this.archiveNote(task);
      moved++;
    }
    return moved;
  }

  /** Move all completed one-off tasks into the Done folder. Returns how many moved. */
  async archiveDone(): Promise<number> {
    let moved = 0;
    for (const task of this.getTasks()) {
      if (task.status !== "done") continue;
      if (task.path.startsWith(this.settings.doneFolder + "/")) continue;
      if (task.recurrence) continue;
      await this.archiveNote(task);
      moved++;
    }
    return moved;
  }
}

/**
 * A task with a new status. Someday means undated by definition, so moving a task there clears the
 * day and time it was planned for — otherwise it would keep a date nobody intends to keep. A due
 * date stays: a real deadline is not something to quietly drop.
 */
function withStatus(task: Task, status: Status, flag: StatusFlag | null = null): Task {
  if (status !== "someday") return { ...task, status, flag };
  return { ...task, status, flag, scheduled: null, startTime: null, endTime: null, endDate: null };
}

/** A note's tags, from its frontmatter and its body, without the `#`. */
export function collectTags(fm: Record<string, unknown>, cache: ReturnType<App["metadataCache"]["getFileCache"]>): string[] {
  const tags = new Set<string>();
  const fmTags = fm.tags;
  if (Array.isArray(fmTags)) fmTags.forEach((t) => tags.add(String(t).replace(/^#/, "")));
  else if (typeof fmTags === "string") tags.add(fmTags.replace(/^#/, ""));
  cache?.tags?.forEach((t) => tags.add(t.tag.replace(/^#/, "")));
  return [...tags];
}
