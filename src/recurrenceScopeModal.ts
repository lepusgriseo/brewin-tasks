import { App, Modal } from "obsidian";

export type EditScope = "single" | "following" | "all";

export interface ScopeModalOptions {
  title?: string;
  prompt?: string;
  labels?: { single: string; following: string; all: string };
  /** Style the "all" choice as destructive. */
  danger?: boolean;
}

/** Asks how an action on a recurring event should apply (this / this & following / all). */
export class RecurrenceScopeModal extends Modal {
  /** A choice was made — closing after it isn't a cancel. */
  private chosen = false;

  constructor(app: App, private onChoose: (scope: EditScope | null) => void, private opts: ScopeModalOptions = {}) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.opts.title ?? "Edit recurring event" });
    contentEl.createEl("p", { cls: "brewin-capture-hint", text: this.opts.prompt ?? "Apply your changes to…" });

    const labels = this.opts.labels ?? {
      single: "This event only",
      following: "This and following events",
      all: "All events",
    };
    const opt = (label: string, scope: EditScope, danger = false) => {
      const b = contentEl.createEl("button", { text: label, cls: "brewin-scope-btn" + (danger ? " brewin-danger" : "") });
      b.addEventListener("click", () => {
        this.chosen = true;
        this.onChoose(scope);
        this.close();
      });
      return b;
    };
    const first = opt(labels.single, "single");
    opt(labels.following, "following");
    opt(labels.all, "all", this.opts.danger);

    const cancel = contentEl.createEl("button", { text: "Cancel", cls: "brewin-scope-cancel" });
    cancel.addEventListener("click", () => this.close());
    // Enter takes the narrowest change — this occurrence — or, when deleting, nothing at all.
    window.setTimeout(() => (this.opts.danger ? cancel : first).focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    // Escape, a tap outside and Cancel all mean "no" — and the caller hears it either way.
    if (!this.chosen) this.onChoose(null);
  }
}
