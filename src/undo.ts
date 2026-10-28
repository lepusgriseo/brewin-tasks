// Undo. While an action runs (`journal.run`), every write the stores make through the helpers below is
// recorded; the plugin then offers the action back as one step on a toast, or by command. Writes made
// outside an action — a modal's Save, the focus timer, a repair after a sync — aren't recorded.
//
// What is recorded, and how it is taken back, is undoPlan.ts's (pure, tested).

import { App, normalizePath, TFile, TFolder } from "obsidian";
import { Change, compactChanges, propertyChanges, restoreProperties, restoreText } from "./undoPlan";

/** One action, as Undo can take it back. */
export interface UndoEntry {
  label: string;
  changes: Change[];
}

/** How many actions are kept to take back — for this session only. */
const KEEP = 20;

class UndoJournal {
  private entries: UndoEntry[] = [];
  private recording: Change[] | null = null;

  /** Recording now: the stores' writes are kept. */
  get active(): boolean {
    return this.recording !== null;
  }

  /**
   * Run an action, keeping what it changes. Inside another run it simply becomes part of that one.
   * Returns what it changed, compacted (see `compactChanges`).
   */
  async run<T>(fn: () => Promise<T>): Promise<{ value: T; changes: Change[] }> {
    if (this.recording) return { value: await fn(), changes: [] };
    const changes: Change[] = [];
    this.recording = changes;
    try {
      return { value: await fn(), changes: compactChanges(changes) };
    } finally {
      this.recording = null;
    }
  }

  /** Keep an action that changed something, newest last. */
  keep(label: string, changes: Change[]): UndoEntry | null {
    if (!changes.length) return null;
    const entry = { label, changes };
    this.entries.push(entry);
    if (this.entries.length > KEEP) this.entries.shift();
    return entry;
  }

  latest(): UndoEntry | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  record(c: Change): void {
    this.recording?.push(c);
  }

  /** Take an action back, newest change first. Says how many of its changes couldn't be. */
  async undo(app: App, entry: UndoEntry): Promise<{ skipped: string[] }> {
    this.entries = this.entries.filter((e) => e !== entry);
    const skipped: string[] = [];
    for (const c of [...entry.changes].reverse()) {
      try {
        if (!(await reverse(app, c))) skipped.push(c.kind === "rename" ? c.to : c.path);
      } catch (e) {
        console.error("Brewin Planner: couldn't undo", c, e);
        skipped.push(c.kind === "rename" ? c.to : c.path);
      }
    }
    return { skipped };
  }
}

export const journal = new UndoJournal();

const copy = (o: Record<string, unknown>) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>;

// ── Recorded writes: the stores' only way to change a note ──────────────────

/** `processFrontMatter`, recorded. */
export async function writeProperties(app: App, file: TFile, fn: (fm: Record<string, unknown>) => void): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const before = journal.active ? copy(fm) : null;
    fn(fm);
    if (before) {
      const keys = propertyChanges(before, fm);
      if (Object.keys(keys).length) journal.record({ kind: "fm", path: file.path, keys });
    }
  });
}

/** `vault.process` — an atomic read-and-rewrite of a note's text — recorded. */
export async function writeText(app: App, file: TFile, fn: (text: string) => string): Promise<string> {
  return app.vault.process(file, (text) => {
    const next = fn(text);
    if (journal.active && next !== text) journal.record({ kind: "text", path: file.path, before: text, after: next });
    return next;
  });
}

/** `vault.create`, recorded. */
export async function createNote(app: App, path: string, content: string): Promise<TFile> {
  const file = await app.vault.create(path, content);
  journal.record({ kind: "create", path: file.path });
  return file;
}

/** `fileManager.trashFile` (the vault's own Deleted-files setting), recorded with the note's text. */
export async function trashNote(app: App, file: TFile): Promise<void> {
  const content = journal.active ? await app.vault.read(file) : "";
  const path = file.path;
  await app.fileManager.trashFile(file);
  journal.record({ kind: "trash", path, content });
}

/** `fileManager.renameFile` (links to it follow), recorded. */
export async function moveNote(app: App, file: TFile, dest: string): Promise<void> {
  const from = file.path;
  await app.fileManager.renameFile(file, dest);
  journal.record({ kind: "rename", from, to: dest });
}

// ── Taking one change back ───────────────────────────────────────────────────

const fileAt = (app: App, path: string): TFile | null => {
  const f = app.vault.getAbstractFileByPath(path);
  return f instanceof TFile ? f : null;
};

async function ensureFolderFor(app: App, path: string): Promise<void> {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (!folder || app.vault.getAbstractFileByPath(folder) instanceof TFolder) return;
  try {
    await app.vault.createFolder(normalizePath(folder));
  } catch {
    /* made meanwhile */
  }
}

/** A free path beside `path` for a note brought back where another now stands. */
function freePath(app: App, path: string): string {
  const base = path.replace(/\.md$/, "");
  let candidate = `${base} (restored).md`;
  for (let n = 2; app.vault.getAbstractFileByPath(candidate); n++) candidate = `${base} (restored ${n}).md`;
  return candidate;
}

/** Undo one change. False when it couldn't be (the note is gone, or was changed since). */
async function reverse(app: App, c: Change): Promise<boolean> {
  switch (c.kind) {
    case "fm": {
      const file = fileAt(app, c.path);
      if (!file) return false;
      await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => restoreProperties(fm, c.keys));
      return true;
    }
    case "text": {
      const file = fileAt(app, c.path);
      if (!file) return false;
      let done = false;
      await app.vault.process(file, (current) => {
        const back = restoreText(current, c);
        done = back !== null;
        return back ?? current;
      });
      return done;
    }
    case "create": {
      const file = fileAt(app, c.path);
      if (!file) return false;
      await app.fileManager.trashFile(file);
      return true;
    }
    case "trash": {
      const path = app.vault.getAbstractFileByPath(c.path) ? freePath(app, c.path) : c.path;
      await ensureFolderFor(app, path);
      await app.vault.create(path, c.content);
      return true;
    }
    case "rename": {
      const file = fileAt(app, c.to);
      if (!file || app.vault.getAbstractFileByPath(c.from)) return false;
      await ensureFolderFor(app, c.from);
      await app.fileManager.renameFile(file, c.from);
      return true;
    }
  }
}
