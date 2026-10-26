// "＋ Add attribute…" → "New attribute…": name it, pick its kind, and it is offered on every task
// from then on (settings list them all).
//
// Before anything is made, the name is checked against the properties the notes already have. A
// property of that name on task notes is adopted — its spelling kept, its kind guessed from Obsidian's
// own type for it or from its values — so those values show at once rather than a second, empty
// property being started beside them. The same goes for a name used elsewhere in the vault, since
// Obsidian holds one type per property name.

import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { ATTR_KINDS, AttrKind, findProperty, inferKind, PropertyUse, scanProperties, TaskAttribute, uniqueAttrKey } from "./attributes";

/** Obsidian's type for a property name, where one is assigned. Not in the public API; read defensively. */
function obsidianType(app: App, name: string): string | null {
  try {
    const mgr = (app as unknown as { metadataTypeManager?: { getAssignedType?(n: string): string | null | undefined } }).metadataTypeManager;
    return mgr?.getAssignedType?.(name) ?? null;
  } catch {
    return null;
  }
}

const sample = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v)).slice(0, 24);

export class AttributeModal extends Modal {
  private label = "";
  private kind: AttrKind = "text";
  /** The user picked the kind by hand — a found property no longer overrides it. */
  private kindChosen = false;
  private icon = "";
  private unit = "";
  private options = "";
  private onRow = true;
  private uses = new Map<string, PropertyUse>();
  private found: PropertyUse | null = null;

  constructor(
    app: App,
    private settings: { attributes: TaskAttribute[]; itemsFolder: string; routinesFolder: string },
    private onCreate: (attr: TaskAttribute) => void,
    private initialLabel = ""
  ) {
    super(app);
  }

  onOpen(): void {
    this.uses = this.scan();
    const { contentEl } = this;
    this.modalEl.addClass("brewin-attr-modal");
    contentEl.createEl("h3", { text: "New attribute" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "A field of your own, offered on every task from now on and saved on the task's note as a property. Settings → Attributes lists them all.",
    });

    // Properties the task notes already carry that aren't attributes yet: one tap to make one.
    const onTasks = [...this.uses.values()].filter((u) => u.taskNotes > 0).sort((a, b) => b.taskNotes - a.taskNotes).slice(0, 8);
    if (onTasks.length) {
      const box = contentEl.createDiv({ cls: "brewin-attr-found-list" });
      box.createSpan({ cls: "setting-item-description", text: "Already on your task notes: " });
      for (const u of onTasks) {
        const b = box.createEl("button", { cls: "brewin-chip-mini", text: `${u.key} · ${u.taskNotes}` });
        b.setAttr("aria-label", `Make an attribute of “${u.key}”, on ${u.taskNotes} task note${u.taskNotes === 1 ? "" : "s"}`);
        b.addEventListener("click", () => {
          nameInput.value = u.key;
          this.setLabel(u.key);
        });
      }
    }

    let nameInput!: HTMLInputElement;
    new Setting(contentEl).setName("Name").addText((t) => {
      nameInput = t.inputEl;
      t.setPlaceholder("Cost, Client, Room…").setValue(this.initialLabel).onChange((v) => this.setLabel(v));
      window.setTimeout(() => t.inputEl.focus(), 0);
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit();
        }
      });
    });
    this.foundEl = contentEl.createDiv({ cls: "brewin-attr-found" });

    this.kindSetting = new Setting(contentEl).setName("Kind");
    this.kindSetting.addDropdown((d) => {
      this.kindDropdown = d.selectEl;
      for (const k of ATTR_KINDS) d.addOption(k.kind, `${k.icon} ${k.label}`);
      d.setValue(this.kind).onChange((v) => {
        this.kind = v as AttrKind;
        this.kindChosen = true;
        this.drawExtra();
      });
    });
    this.extraEl = contentEl.createDiv();
    this.drawExtra();
    if (this.initialLabel) this.setLabel(this.initialLabel);

    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Add attribute", cls: "mod-cta" }).addEventListener("click", () => this.submit());
  }

  private foundEl!: HTMLElement;
  private extraEl!: HTMLElement;
  private kindSetting!: Setting;
  private kindDropdown!: HTMLSelectElement;

  /** The notes' properties: task notes (in the Planner's folders) apart from the rest of the vault. */
  private scan(): Map<string, PropertyUse> {
    const s = this.settings;
    const isTask = (f: TFile) => [s.itemsFolder, s.routinesFolder].some((d) => f.path.startsWith(d + "/"));
    const tasks: Record<string, unknown>[] = [];
    const others: Record<string, unknown>[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
      if (!fm) continue;
      (isTask(f) ? tasks : others).push(fm);
    }
    return scanProperties(tasks, others, s.attributes);
  }

  /** A new name: look it up among the notes' properties and say what was found. */
  private setLabel(v: string): void {
    this.label = v;
    this.found = findProperty(this.uses, v);
    this.foundEl.empty();
    const u = this.found;
    if (!u) {
      if (v.trim()) this.foundEl.createDiv({ cls: "brewin-attr-found-none", text: "New — no note has a property of this name yet." });
      return;
    }
    const where = [
      u.taskNotes ? `${u.taskNotes} task note${u.taskNotes === 1 ? "" : "s"}` : "",
      u.otherNotes ? `${u.otherNotes} other note${u.otherNotes === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" and ");
    const values = u.samples.slice(0, 4).map(sample).join(", ");
    this.foundEl.createDiv({
      cls: "brewin-attr-found-yes",
      text: `Already a property: “${u.key}”, on ${where}${values ? ` (e.g. ${values})` : ""}. This attribute will use it${u.taskNotes ? ", so those tasks show their values straight away" : ""}.`,
    });
    if (!this.kindChosen) {
      const guess = inferKind(u.samples, obsidianType(this.app, u.key));
      this.kind = guess.kind;
      this.kindDropdown.value = guess.kind;
      if (guess.options && !this.options) this.options = guess.options.join(", ");
      this.drawExtra();
    }
  }

  private drawExtra(): void {
    const extra = this.extraEl;
    extra.empty();
    const info = ATTR_KINDS.find((k) => k.kind === this.kind)!;
    this.kindSetting.setDesc(info.hint);
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
  }

  private submit(): void {
    const typed = this.label.trim();
    if (!typed) return void new Notice("Give it a name first.");
    // Typed as the property is named but for capitals: take the notes' spelling for the name too.
    const label = this.found && this.found.key.toLowerCase() === typed.toLowerCase() ? this.found.key : typed;
    const same = this.settings.attributes.find((a) => a.label.toLowerCase() === label.toLowerCase() || a.key.toLowerCase() === label.toLowerCase());
    if (same) return void new Notice(`There is already an attribute called “${same.label}”.`);
    const info = ATTR_KINDS.find((k) => k.kind === this.kind)!;
    // A property the notes already have is used as they spell it; a new name gets a key of its own.
    const key = this.found ? this.found.key : uniqueAttrKey(label, this.settings.attributes);
    const attr: TaskAttribute = { key, label, icon: this.icon.trim() || info.icon, kind: this.kind, onRow: this.onRow };
    if (this.kind === "number" && this.unit.trim()) attr.unit = this.unit.trim();
    if (this.kind === "choice") attr.options = [...new Set(this.options.split(",").map((o) => o.trim()).filter(Boolean))];
    this.close();
    this.onCreate(attr);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
