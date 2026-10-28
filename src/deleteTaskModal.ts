import { App, Modal } from "obsidian";

export type DeleteChoice = "task-only" | "with-subtasks";

/**
 * Confirms deleting a task. When the task has subtasks the choice is explicit, so it's
 * never ambiguous what happens to the children.
 */
export class DeleteTaskModal extends Modal {
  /** A choice was made — closing after it isn't a cancel. */
  private chosen = false;

  constructor(
    app: App,
    private title: string,
    private childCount: number,
    private onChoose: (choice: DeleteChoice | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Delete task" });
    contentEl.createEl("p", { text: `"${this.title}"` });
    contentEl.createDiv({
      cls: "brewin-capture-hint",
      text: "Goes to your vault's trash — recoverable via Obsidian's 'Deleted files' setting.",
    });

    const pick = (label: string, choice: DeleteChoice, warn = false) => {
      const b = contentEl.createEl("button", { text: label, cls: "brewin-scope-btn" + (warn ? " brewin-danger" : "") });
      b.addEventListener("click", () => {
        this.chosen = true;
        this.onChoose(choice);
        this.close();
      });
    };

    if (this.childCount > 0) {
      const n = this.childCount;
      pick(`Delete this task only — keep ${n} subtask${n === 1 ? "" : "s"}`, "task-only");
      pick(`Delete this task and its ${n} subtask${n === 1 ? "" : "s"}`, "with-subtasks", true);
    } else {
      pick("Delete task", "task-only", true);
    }

    const cancel = contentEl.createEl("button", { text: "Cancel", cls: "brewin-scope-cancel" });
    cancel.addEventListener("click", () => this.close());
    // The safe choice has the focus, so Enter never deletes by accident.
    window.setTimeout(() => cancel.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    // Escape, a tap outside and Cancel all mean "no" — and the caller hears it either way.
    if (!this.chosen) this.onChoose(null);
  }
}
