// A project's step in a window of its own: its words, its dates and whether it is a `#next` step,
// changed in place on its line in the note — or ticked, opened in the note, or taken out. The user's
// own task asked for it: "inline tasks from project files … must be editable". A checkbox task from
// any other note (noteTasks.ts) opens here too, as a task: #next only means something in a project.

import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { pickDate } from "./datePicker";
import { isSubmitKey } from "./a11y";
import { InlineChanges } from "./inlineTask";
import { ProjectTask, ProjectTaskSource } from "./projectTasks";
import { plainText } from "./projects";

export interface StepModalOptions {
  source: ProjectTaskSource;
  firstDayOfWeek: number;
  /** The plugin's `act`: a change offered back with Undo. */
  act: (fn: () => Promise<string | null>) => Promise<void>;
  /** After anything was changed — redraw. */
  onChange: () => void;
}

export class StepModal extends Modal {
  private text: string;
  private scheduled: string | null;
  private due: string | null;
  private next: boolean;

  constructor(app: App, private step: ProjectTask, private o: StepModalOptions) {
    super(app);
    this.text = step.text;
    this.scheduled = step.scheduled;
    this.due = step.due;
    this.next = step.isNext;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("brewin-step-modal");
    contentEl.createEl("h3", { text: this.step.fromNote ? "Task in a note" : "Step" });
    contentEl.createDiv({ cls: "brewin-capture-hint", text: `In ${this.step.projectName}` });

    const input = contentEl.createEl("input", { type: "text", cls: "brewin-capture-title", attr: { "aria-label": this.step.fromNote ? "What the task is" : "What the step is" } });
    input.value = this.text;
    input.addEventListener("input", () => (this.text = input.value));
    input.addEventListener("keydown", (e) => {
      if (!isSubmitKey(e)) return;
      e.preventDefault();
      void this.save();
    });
    window.setTimeout(() => input.focus(), 0);

    const dates = contentEl.createDiv({ cls: "brewin-capture-dates" });
    const sched = dates.createEl("button", { cls: "brewin-chip" });
    const due = dates.createEl("button", { cls: "brewin-chip" });
    const paint = () => {
      sched.setText(this.scheduled ? `📅 ${this.scheduled}` : "📅 Schedule");
      sched.toggleClass("brewin-chip-set", !!this.scheduled);
      due.setText(this.due ? `🚩 ${this.due}` : "🚩 Due");
      due.toggleClass("brewin-chip-set", !!this.due);
    };
    paint();
    sched.addEventListener("click", async () => {
      const r = await pickDate(this.app, this.scheduled, this.o.firstDayOfWeek, { selectedLabel: "Scheduled", relatedISO: this.due, relatedLabel: "Due" });
      if (r !== undefined) this.scheduled = r;
      paint();
    });
    due.addEventListener("click", async () => {
      const r = await pickDate(this.app, this.due, this.o.firstDayOfWeek, { selectedLabel: "Due", relatedISO: this.scheduled, relatedLabel: "Scheduled" });
      if (r !== undefined) this.due = r;
      paint();
    });

    if (!this.step.fromNote) {
      new Setting(contentEl)
        .setName("A next action")
        .setDesc("Tagged #next — offered first when the project's next action is chosen.")
        .addToggle((t) => t.setValue(this.next).onChange((v) => (this.next = v)));
    }

    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    btns.createEl("button", { text: "Delete", cls: "mod-warning" }).addEventListener("click", () => {
      this.close();
      void this.o.act(async () => {
        const ok = await this.o.source.remove(this.step);
        this.o.onChange();
        return ok ? `Took “${plainText(this.step.text)}” out of ${this.step.projectName}.` : this.gone();
      });
    });
    btns.createEl("button", { text: "Open in note" }).addEventListener("click", () => {
      this.close();
      void this.openInNote();
    });
    btns.createEl("button", { text: "✓ Done" }).addEventListener("click", () => {
      this.close();
      void this.o.act(async () => {
        const ok = await this.o.source.complete(this.step);
        this.o.onChange();
        return ok ? `✓ ${plainText(this.step.text)}` : this.gone();
      });
    });
    btns.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  /** Only what changed is written; nothing at all when nothing did. */
  private async save(): Promise<void> {
    const ch: InlineChanges = {};
    const words = this.text.trim();
    if (!words) return void new Notice(`A ${this.step.fromNote ? "task" : "step"} needs some words — or delete it.`);
    if (words !== this.step.text) ch.text = words;
    if (this.scheduled !== this.step.scheduled) ch.scheduled = this.scheduled;
    if (this.due !== this.step.due) ch.due = this.due;
    if (this.next !== this.step.isNext) ch.next = this.next;
    this.close();
    if (!Object.keys(ch).length) return;
    const ok = await this.o.source.edit(this.step, ch);
    if (!ok) new Notice(this.gone());
    this.o.onChange();
  }

  private gone(): string {
    return `“${plainText(this.step.text)}” has changed in ${this.step.projectName} since it was read — open the note to edit it there.`;
  }

  private async openInNote(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.step.projectPath);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file, { eState: { line: this.step.line } });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
