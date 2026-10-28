import { App, TFile } from "obsidian";
import { BrewinSettings } from "./settings";
import { todayISO } from "./dates";
import { InlineChanges, parseInlineTask, writeInlineTask } from "./inlineTask";
import { writeText } from "./undo";
import { forgetNoteTasks } from "./noteTasks";

/** A checkbox task surfaced from a #project note, with the info needed to write back. */
export interface ProjectTask {
  projectPath: string;
  projectName: string;
  line: number; // 0-based line index in the file
  raw: string; // the exact source line
  text: string; // display text (checkbox + inline fields stripped)
  scheduled: string | null;
  due: string | null;
  isNext: boolean;
  /** A checkbox task from a note outside the projects (noteTasks.ts), not a project's step. */
  fromNote?: boolean;
}


export class ProjectTaskSource {
  constructor(private app: App, private settings: BrewinSettings) {}

  isProjectNote(file: TFile): boolean {
    const folder = this.settings.projectsFolder;
    if (!file.path.startsWith(folder + "/")) return false;
    // The folder's own hub note (03_Projects/03_Projects.md) lists projects; it isn't one.
    if (file.path === `${folder}/${folder.split("/").pop()}.md`) return false;
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    const fmTags = fm?.tags;
    const tagList = Array.isArray(fmTags) ? fmTags.map(String) : fmTags ? [String(fmTags)] : [];
    if (tagList.map((t) => t.replace(/^#/, "")).includes("project")) return true;
    return (cache?.tags ?? []).some((t) => t.tag.replace(/^#/, "") === "project");
  }

  private projectStatus(file: TFile): string {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    return String(fm?.status ?? "").toLowerCase();
  }

  /**
   * The project notes themselves, by name — including a project with nothing open, which still
   * belongs in a list of projects. Synchronous: it only reads the metadata cache.
   */
  listProjects(activeOnly = false): { path: string; name: string }[] {
    return this.listProjectFiles()
      .filter((file) => !activeOnly || this.projectStatus(file) === "active")
      .map((file) => ({ path: file.path, name: file.basename }));
  }

  /** The project notes, by name. */
  listProjectFiles(): TFile[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => this.isProjectNote(file))
      .sort((a, b) => a.basename.localeCompare(b.basename));
  }

  /** @param activeOnly when true, only tasks from projects with `status: active` are returned. */
  async getProjectTasks(activeOnly = false): Promise<ProjectTask[]> {
    const out: ProjectTask[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.isProjectNote(file)) continue;
      if (activeOnly && this.projectStatus(file) !== "active") continue;
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split("\n");
      lines.forEach((raw, i) => {
        // Dated either way the vault writes it: `[due:: …]` fields or the Tasks plugin's 📅 ⏳.
        const t = parseInlineTask(raw);
        if (!t || t.mark !== " ") return;
        out.push({
          projectPath: file.path,
          projectName: file.basename,
          line: i,
          raw,
          text: t.text,
          scheduled: t.scheduled,
          due: t.due,
          isNext: t.next,
        });
      });
    }
    return out;
  }

  /**
   * Rewrite a step's line — or take it out, when `transform` gives null. One atomic read-and-write
   * (it used to read, then write the whole note back, losing anything written in between), recorded
   * for Undo. False when the line is no longer in the note as it was read.
   */
  private async rewriteLine(pt: ProjectTask, transform: (line: string) => string | null): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(pt.projectPath);
    if (!(file instanceof TFile)) return false;
    let found = false;
    await writeText(this.app, file, (content) => {
      const lines = content.split("\n");
      // The recorded line if it still says the same; otherwise the same text wherever it now is.
      const idx = lines[pt.line] === pt.raw ? pt.line : lines.indexOf(pt.raw);
      if (idx < 0) return content;
      found = true;
      const next = transform(lines[idx]);
      if (next === null) lines.splice(idx, 1);
      else lines[idx] = next;
      return lines.join("\n");
    });
    // A note task's note is read again on the redraw that follows, not served from before the write.
    forgetNoteTasks(pt.projectPath);
    return found;
  }

  /** Tick a step, with today's completion date as the line writes dates (`[completion:: …]` or ✅). */
  async complete(pt: ProjectTask): Promise<boolean> {
    return this.rewriteLine(pt, (line) => writeInlineTask(line, { done: true }, todayISO()));
  }

  /** Set or replace an inline date on the step's line, in the line's own style. */
  async setDate(pt: ProjectTask, field: "scheduled" | "due", iso: string | null): Promise<boolean> {
    return this.rewriteLine(pt, (line) => writeInlineTask(line, { [field]: iso }, todayISO()));
  }

  /** Change a step's words, dates or `#next` — the step window's Save. */
  async edit(pt: ProjectTask, changes: InlineChanges): Promise<boolean> {
    return this.rewriteLine(pt, (line) => writeInlineTask(line, changes, todayISO()));
  }

  /** Take a step's line out of its note. */
  async remove(pt: ProjectTask): Promise<boolean> {
    return this.rewriteLine(pt, () => null);
  }
}
