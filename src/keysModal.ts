// "?" — the keys a view answers to.

import { App, Modal } from "obsidian";
import { CAL_KEYS, DASH_KEYS } from "./keys";

export class KeysModal extends Modal {
  constructor(app: App, private which: "dashboard" | "calendar") {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("brewin-keys-modal");
    contentEl.createEl("h3", { text: this.which === "dashboard" ? "Keys on the dashboard" : "Keys on the calendar" });
    const list = contentEl.createEl("dl", { cls: "brewin-keys" });
    for (const [key, does] of this.which === "dashboard" ? DASH_KEYS : CAL_KEYS) {
      list.createEl("dt").createEl("kbd", { text: key });
      list.createEl("dd", { text: does });
    }
    contentEl.createEl("p", { cls: "setting-item-description", text: "They work while the view is the active pane, and never while you're typing in a box." });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
