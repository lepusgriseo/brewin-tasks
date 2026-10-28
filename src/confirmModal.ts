import { App, Modal } from "obsidian";

/**
 * Minimal confirm dialog used before bulk/irreversible-ish actions. The main button has the focus,
 * so Enter confirms and Escape cancels — except for a deletion (`danger`), where Cancel has it and
 * the button says what it does in red.
 */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private opts: { title: string; body: string; cta: string; onConfirm: () => void; danger?: boolean }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.opts.title });
    contentEl.createEl("p", { text: this.opts.body });
    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    const cancel = btns.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const cta = btns.createEl("button", { text: this.opts.cta, cls: this.opts.danger ? "mod-warning" : "mod-cta" });
    cta.addEventListener("click", () => {
      this.close();
      this.opts.onConfirm();
    });
    window.setTimeout(() => (this.opts.danger ? cancel : cta).focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
