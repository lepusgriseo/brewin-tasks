import { App, TFile } from "obsidian";
import { BrewinSettings } from "./settings";
import { coerceISO } from "./dates";
import { stepText } from "./projects";

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
}

const OPEN_CHECKBOX = /^(\s*)- \[ \]\s+(.*)$/;

function extractField(text: string, field: string): string | null {
  const m = new RegExp(`\\[${field}::\\s*([^\\]]+)\\]`).exec(text);
  return m ? coerceISO(m[1].trim()) : null;
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
        const m = OPEN_CHECKBOX.exec(raw);
        if (!m) return;
        const body = m[2];
        out.push({
          projectPath: file.path,
          projectName: file.basename,
          line: i,
          raw,
          text: stepText(body),
          scheduled: extractField(body, "scheduled"),
          due: extractField(body, "due"),
          isNext: /#next\b/.test(body),
        });
      });
    }
    return out;
  }

  private async rewriteLine(pt: ProjectTask, transform: (line: string) => string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(pt.projectPath);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    // Prefer the recorded line index if it still matches; otherwise find the exact raw line.
    let idx = pt.line;
    if (lines[idx] !== pt.raw) idx = lines.indexOf(pt.raw);
    if (idx < 0) return;
    lines[idx] = transform(lines[idx]);
    await this.app.vault.modify(file, lines.join("\n"));
  }

  async complete(pt: ProjectTask): Promise<void> {
    await this.rewriteLine(pt, (line) => line.replace(/- \[ \]/, "- [x]"));
  }

  /** Set or replace an inline date field on the project checkbox line. */
  async setDate(pt: ProjectTask, field: "scheduled" | "due", iso: string | null): Promise<void> {
    await this.rewriteLine(pt, (line) => {
      let out = line.replace(new RegExp(`\\s*\\[${field}::\\s*[^\\]]*\\]`), "");
      if (iso) out = out.replace(/\s*$/, "") + ` [${field}:: ${iso}]`;
      return out;
    });
  }
}
