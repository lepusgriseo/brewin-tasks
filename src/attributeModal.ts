// "＋ Add attribute…" from the task window: name it, pick its kind, and it is offered on every
// task from then on (settings list them all). The key it is saved under comes from the name and is
// fixed, so renaming it later in settings loses no values.

import { App, Modal, Notice, Setting } from "obsidian";
import { ATTR_KINDS, AttrKind, TaskAttribute, uniqueAttrKey } from "./attributes";

export class AttributeModal extends Modal {
  private label = "";
  private kind: AttrKind = "text";
  private icon = "";
  private unit = "";
  private options = "";
  private onRow = true;

  constructor(app: App, private existing: readonly TaskAttribute[], private onCreate: (attr: TaskAttribute) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("brewin-attr-modal");
    contentEl.createEl("h3", { text: "New attribute" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "It's offered on every task from now on, and saved on the task's note as a property of its own. Settings → Attributes lists them all.",
    });

    new Setting(contentEl).setName("Name").addText((t) => {
      t.setPlaceholder("Cost, Client, Room…").onChange((v) => (this.label = v));
      window.setTimeout(() => t.inputEl.focus(), 0);
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit();
        }
      });
    });

    const kinds = new Setting(contentEl).setName("Kind");
    const extra = contentEl.createDiv();
    kinds.addDropdown((d) => {
      for (const k of ATTR_KINDS) d.addOption(k.kind, `${k.icon} ${k.label}`);
      d.setValue(this.kind).onChange((v) => {
        this.kind = v as AttrKind;
        drawExtra();
      });
    });

    const drawExtra = () => {
      extra.empty();
      const info = ATTR_KINDS.find((k) => k.kind === this.kind)!;
      kinds.setDesc(info.hint);
      if (this.kind === "number") {
        new Setting(extra)
          .setName("Unit")
          .setDesc("Optional. £ or $ goes before the number; anything else (km, kg, h) after it.")
          .addText((t) => t.setPlaceholder("£").setValue(this.unit).onChange((v) => (this.unit = v)));
      }
      if (this.kind === "choice") {
        new Setting(extra)
          .setName("Choices")
          .setDesc("Separated by commas, in the order to offer them. More can be added from any task.")
          .addText((t) => t.setPlaceholder("low, medium, high").setValue(this.options).onChange((v) => (this.options = v)));
      }
      new Setting(extra)
        .setName("Icon")
        .setDesc(`An emoji for the task row and the menu. Leave empty for ${info.icon}.`)
        .addText((t) => {
          t.inputEl.addClass("brewin-attr-icon");
          t.setPlaceholder(info.icon).setValue(this.icon).onChange((v) => (this.icon = v));
        });
      new Setting(extra)
        .setName("Show on task rows")
        .setDesc(this.kind === "bool" ? "A ticked one shows its name on the row." : "Its value shows on the row, beside the dates and contexts.")
        .addToggle((t) => t.setValue(this.onRow).onChange((v) => (this.onRow = v)));
    };
    drawExtra();

    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Add attribute", cls: "mod-cta" }).addEventListener("click", () => this.submit());
  }

  private submit(): void {
    const label = this.label.trim();
    if (!label) return void new Notice("Give it a name first.");
    if (this.existing.some((a) => a.label.toLowerCase() === label.toLowerCase())) return void new Notice(`There is already an attribute called “${label}”.`);
    const info = ATTR_KINDS.find((k) => k.kind === this.kind)!;
    const attr: TaskAttribute = { key: uniqueAttrKey(label, this.existing), label, icon: this.icon.trim() || info.icon, kind: this.kind, onRow: this.onRow };
    if (this.kind === "number" && this.unit.trim()) attr.unit = this.unit.trim();
    if (this.kind === "choice") attr.options = [...new Set(this.options.split(",").map((o) => o.trim()).filter(Boolean))];
    this.close();
    this.onCreate(attr);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
