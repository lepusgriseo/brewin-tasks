import { App, Modal } from "obsidian";

/** Minimal confirm dialog used before bulk/irreversible-ish actions. */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private opts: { title: string; body: string; cta: string; onConfirm: () => void }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.opts.title });
    contentEl.createEl("p", { text: this.opts.body });
    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const cta = btns.createEl("button", { text: this.opts.cta, cls: "mod-cta" });
    cta.addEventListener("click", () => {
      this.close();
      this.opts.onConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
