import { App, normalizePath, TFile, TFolder } from "obsidian";
import { BrewinSettings } from "./settings";
import { attentionTasks } from "./views";
import { Task } from "./types";
import { habitsBacklogFromFrontmatter, fitnessBacklogFromFrontmatter, HabitsBacklog, FitnessBacklog } from "./crossPluginBacklog";

const OWN_FILE = "Tasks Backlog.md";
const HABITS_FILE = "Habits Backlog.md";
const FITNESS_FILE = "Fitness Backlog.md";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * Writes the shared cross-plugin backlog note this plugin owns (`Tasks Backlog.md`), and reads
 * the sibling notes Brewin Habits and Brewin Fitness own. Same "state lives in a note" idiom as
 * Brewin Habits' Rewards.md — one note per producing plugin, so there's no cross-plugin write race.
 */
export class BacklogStore {
  constructor(private app: App, private settings: BrewinSettings) {}

  private path(name: string): string {
    return normalizePath(`${this.settings.accountabilityFolder}/${name}`);
  }

  /** The note this plugin owns — exposed so main.ts's vault-change listeners can ignore our own
   *  writes and avoid re-triggering themselves. */
  get notePath(): string {
    return this.path(OWN_FILE);
  }

  private async ensureFolder(): Promise<void> {
    const norm = normalizePath(this.settings.accountabilityFolder);
    if (this.app.vault.getAbstractFileByPath(norm) instanceof TFolder) return;
    if (this.app.vault.getAbstractFileByPath(norm)) return;
    try {
      await this.app.vault.createFolder(norm);
    } catch {
      /* already exists / race */
    }
  }

  private async ensureFile(): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(this.notePath);
    if (existing instanceof TFile) return existing;
    await this.ensureFolder();
    const lines = [
      "---",
      "overdue_count: 0",
      "slipped_count: 0",
      "generated:",
      "---",
      "",
      "# Tasks Backlog",
      "",
      "Written automatically by Brewin Planner. Read by Brewin Habits' cash-in gate — don't " +
        "hand-edit, it'll just be overwritten on the next refresh.",
      "",
    ];
    return this.app.vault.create(this.notePath, lines.join("\n"));
  }

  /**
   * Recompute and write our own backlog — but only if something actually changed, so an
   * unchanged recompute never produces a redundant `changed` event on our own file (which would
   * otherwise re-trigger the vault-change listener that calls this in the first place).
   */
  async writeOwn(tasks: Task[], todayISO: string): Promise<void> {
    const att = attentionTasks(tasks, todayISO);
    const file = await this.ensureFile();
    const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
    if (num(fm.overdue_count) === att.overdue.length && num(fm.slipped_count) === att.slipped.length) return;
    await this.app.fileManager.processFrontMatter(file, (f) => {
      f.overdue_count = att.overdue.length;
      f.slipped_count = att.slipped.length;
      f.generated = new Date().toISOString();
    });
  }

  private readNote(name: string): Record<string, unknown> {
    const file = this.app.vault.getAbstractFileByPath(this.path(name));
    if (!(file instanceof TFile)) return {};
    return (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
  }

  /** All-zero if the sibling plugin isn't installed/enabled or hasn't written yet — never an
   *  error. Synchronous: frontmatter reads come straight from the metadata cache. */
  readHabitsBacklog(): HabitsBacklog {
    return habitsBacklogFromFrontmatter(this.readNote(HABITS_FILE));
  }

  readFitnessBacklog(): FitnessBacklog {
    return fitnessBacklogFromFrontmatter(this.readNote(FITNESS_FILE));
  }
}
