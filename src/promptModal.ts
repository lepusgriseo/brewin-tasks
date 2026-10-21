import { App, Modal } from "obsidian";

/** A one-line text prompt. Enter accepts, Escape cancels — the whole dialog is the input. */
export class PromptModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private opts: {
      title: string;
      body?: string;
      placeholder?: string;
      initial?: string;
      cta: string;
      /** Accept an empty answer — for clearing a field rather than naming something. */
      allowEmpty?: boolean;
      onSubmit: (value: string) => void;
    }
  ) {
    super(app);
    this.value = opts.initial ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.opts.title });
    if (this.opts.body) contentEl.createEl("p", { cls: "setting-item-description", text: this.opts.body });

    const input = contentEl.createEl("input", { type: "text", cls: "brewin-capture-title" });
    input.placeholder = this.opts.placeholder ?? "";
    input.value = this.value;
    input.addEventListener("input", () => (this.value = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
    });
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);

    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: this.opts.cta, cls: "mod-cta" }).addEventListener("click", () => this.submit());
  }

  private submit(): void {
    const value = this.value.trim();
    if (!value && !this.opts.allowEmpty) return;
    this.close();
    this.opts.onSubmit(value);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
