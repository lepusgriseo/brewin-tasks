import { App, TFile } from "obsidian";
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
  tickStep,
  untagStep,
  withLogEntry,
  withProjectFields,
} from "./projects";

/**
 * The project notes' own fields — status, next action, waiting on, deadline — read from the
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

  setNext(p: ProjectInfo, next: string): Promise<ProjectInfo | null> {
    return this.write(p, { next });
  }

  /**
   * Finish the next action, or choose one, in a single write: tick the step it was (when that was
   * asked for), take `#next` off the step promoted in its place, log what was done under today,
   * and set `next:`.
   */
  advance(p: ProjectInfo, o: { done: boolean; tick: ProjectTask | null; promote: ProjectTask | null; next: string }): Promise<ProjectInfo | null> {
    return this.write(p, { next: o.next }, (text) => {
      const lines = text.split("\n");
      if (o.tick) tickStep(lines, o.tick.line, o.tick.raw);
      if (o.promote) untagStep(lines, o.promote.line, o.promote.raw);
      const out = lines.join("\n");
      return o.done && p.next ? withLogEntry(out, todayISO(), `Done: ${p.next}`) : out;
    });
  }

  private async write(p: ProjectInfo, patch: ProjectPatch, body: (text: string) => string = (t) => t): Promise<ProjectInfo | null> {
    const file = this.app.vault.getAbstractFileByPath(p.path);
    if (!(file instanceof TFile)) return null;
    const after = applyPatch(p, patch);
    await this.app.vault.process(file, (text) => {
      // Kept before the write lands, so the cache's change event for it always comes after.
      this.written.set(p.path, after);
      return withProjectFields(body(text), { ...patch, modified: todayISO() });
    });
    return after;
  }
}
