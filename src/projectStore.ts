import { App, TFile } from "obsidian";
import { writeText } from "./undo";
import { BrewinSettings } from "./settings";
import { ProjectTask, ProjectTaskSource } from "./projectTasks";
import { todayISO } from "./dates";
import {
  applyPatch,
  ProjectInfo,
  ProjectPatch,
  projectFromFrontmatter,
  ProjectStatus,
  statusPatch,
  tagStep,
  tickStep,
  withLogEntry,
  withNewStep,
  withProjectFields,
} from "./projects";

/**
 * The project notes' own fields — status, waiting on, deadline — read from the
 * metadata cache. Straight after the Planner writes a note the cache still holds the old
 * frontmatter, until Obsidian re-indexes it; so what was written is kept here and laid over the
 * cache until that note's own `changed` event says the cache has caught up.
 */
export class ProjectStore {
  private written = new Map<string, ProjectInfo>();

  constructor(private app: App, private settings: BrewinSettings) {}

  /** Every project note, any status, by name. */
  list(): ProjectInfo[] {
    const src = new ProjectTaskSource(this.app, this.settings);
    return src
      .listProjectFiles()
      .map((f) => this.written.get(f.path) ?? projectFromFrontmatter(f.path, f.basename, this.app.metadataCache.getFileCache(f)?.frontmatter));
  }

  /** The cache has re-read this note, so it is the truth again. */
  forget(path: string): void {
    this.written.delete(path);
  }

  setStatus(p: ProjectInfo, status: ProjectStatus, waitingOn = ""): Promise<ProjectInfo | null> {
    return this.write(p, statusPatch(p, status, todayISO(), waitingOn));
  }

  setDue(p: ProjectInfo, iso: string | null): Promise<ProjectInfo | null> {
    return this.write(p, { due: iso });
  }

  /**
   * Finish a next action, choose the one after it, or both — in a single write. The finished
   * `#next` step is ticked with today's date and logged under today; the chosen step is tagged
   * `#next`, or a typed one is added as a new `#next` step.
   */
  advance(p: ProjectInfo, o: { done: ProjectTask | null; promote: ProjectTask | null; add: string }): Promise<ProjectInfo | null> {
    return this.write(p, {}, (text) => {
      const lines = text.split("\n");
      if (o.done) tickStep(lines, o.done.line, o.done.raw, todayISO());
      if (o.promote) tagStep(lines, o.promote.line, o.promote.raw);
      let out = lines.join("\n");
      if (o.add.trim()) out = withNewStep(out, o.add);
      return o.done ? withLogEntry(out, todayISO(), `Done: ${o.done.text}`) : out;
    });
  }

  private async write(p: ProjectInfo, patch: ProjectPatch, body: (text: string) => string = (t) => t): Promise<ProjectInfo | null> {
    const file = this.app.vault.getAbstractFileByPath(p.path);
    if (!(file instanceof TFile)) return null;
    const after = applyPatch(p, patch);
    await writeText(this.app, file, (text) => {
      // Kept before the write lands, so the cache's change event for it always comes after.
      this.written.set(p.path, after);
      return withProjectFields(body(text), { ...patch, modified: todayISO() });
    });
    return after;
  }
}
