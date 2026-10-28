import { App, TAbstractFile, TFile } from "obsidian";
import { writeText } from "./undo";
import { BrewinSettings } from "./settings";
import { Person, personFromNote, withDob } from "./birthdays";

/**
 * The people notes' birthdays, held in memory. `DOB::` is an inline field in the note's body, which
 * the metadata cache doesn't index, so each note is read once and then again only when it changes —
 * and the calendar can draw from memory without waiting on a disk read.
 */
export class BirthdayStore {
  private people = new Map<string, Person>();

  constructor(private app: App, private settings: BrewinSettings) {}

  /** Is this path one of the people notes? */
  owns(path: string): boolean {
    const folder = this.settings.peopleFolder.replace(/\/$/, "");
    return !!folder && path.startsWith(folder + "/") && path.endsWith(".md");
  }

  getPeople(): Person[] {
    return [...this.people.values()];
  }

  /** Read every people note. Called once the vault is indexed, and when the folder setting changes. */
  async loadAll(): Promise<void> {
    const next = new Map<string, Person>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.owns(file.path)) continue;
      const p = await this.read(file);
      if (p) next.set(file.path, p);
    }
    this.people = next;
  }

  /** Bring one note up to date after it was edited, created, deleted or renamed. */
  async update(file: TAbstractFile, oldPath?: string): Promise<void> {
    if (oldPath) this.people.delete(oldPath);
    this.people.delete(file.path);
    if (!(file instanceof TFile) || !this.owns(file.path)) return;
    if (!this.app.vault.getAbstractFileByPath(file.path)) return; // deleted
    const p = await this.read(file);
    if (p) this.people.set(file.path, p);
  }

  /**
   * Write a birthday into a person's note. The in-memory copy is updated from the text just written,
   * so the page and calendar show it at once instead of after the next change event.
   */
  async setDob(person: Person, value: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(person.path);
    if (!(file instanceof TFile)) return;
    const text = await writeText(this.app, file, (t) => withDob(t, value));
    const p = personFromNote(file.path, file.basename, text);
    if (p) this.people.set(file.path, p);
  }

  private async read(file: TFile): Promise<Person | null> {
    try {
      return personFromNote(file.path, file.basename, await this.app.vault.cachedRead(file));
    } catch {
      return null; // an unreadable note just has no birthday
    }
  }
}
