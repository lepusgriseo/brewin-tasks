import { App, Modal } from "obsidian";
import { isSubmitKey } from "./a11y";
import { ProjectTask } from "./projectTasks";
import { plainText, ProjectInfo, promoteCandidates } from "./projects";

export interface NextActionChoice {
  /** The step chosen to be the next action, to tag `#next` — null when one was typed, or none chosen. */
  promote: ProjectTask | null;
  /** A next action typed rather than chosen, added to the note as a new `#next` step — "" for none. */
  add: string;
}

/** Steps offered before "Show all": every `#next` one, then this many of the rest. */
const FIRST_STEPS = 6;

/**
 * Finish a project's next action — the `#next` step `done`, ticked and logged — and choose the one
 * after it; or, with `done` null, just choose. The note's own steps come first, any already tagged
 * `#next` on top; anything else can be typed, and becomes a new `#next` step.
 */
export class NextActionModal extends Modal {
  private showAll = false;
  private typed = "";
  private stepsEl: HTMLElement | null = null;

  constructor(
    app: App,
    private o: { project: ProjectInfo; steps: ProjectTask[]; done: ProjectTask | null; onSubmit: (c: NextActionChoice) => void }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const { project: p, done } = this.o;
    contentEl.addClass("brewin-next-modal");
    contentEl.createEl("h3", { text: done ? "Next action done" : "Choose the next action" });
    contentEl.createDiv({ cls: "brewin-capture-hint", text: p.name });

    if (done) {
      contentEl.createDiv({ cls: "brewin-next-finished", text: `✓ ${plainText(done.text)}` });
      contentEl.createDiv({ cls: "brewin-capture-hint", text: "It's ticked in the note and written into the project's log under today." });
    }

    contentEl.createEl("h4", { text: "What's next?" });
    this.stepsEl = contentEl.createDiv({ cls: "brewin-next-steps" });
    this.drawSteps();

    const input = contentEl.createEl("input", { type: "text", cls: "brewin-capture-title" });
    input.placeholder = "Or type the next action";
    input.setAttr("aria-label", "The next action");
    input.addEventListener("input", () => (this.typed = input.value));
    input.addEventListener("keydown", (e) => {
      if (!isSubmitKey(e)) return;
      e.preventDefault();
      if (this.typed.trim()) this.submit(null, this.typed.trim());
    });
    if (!this.o.steps.some((s) => s !== done)) window.setTimeout(() => input.focus(), 0);

    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    if (done) {
      btns.createEl("button", { text: "Just tick it" }).addEventListener("click", () => this.submit(null, ""));
    }
    btns.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => {
      if (this.typed.trim()) this.submit(null, this.typed.trim());
      else input.focus();
    });
  }

  private drawSteps(): void {
    const el = this.stepsEl;
    if (!el) return;
    el.empty();
    const all = promoteCandidates(this.o.steps, this.o.done);
    if (!all.length) {
      el.createDiv({ cls: "brewin-menu-empty", text: "No open steps in the note — type one below." });
      return;
    }
    const runners = all.filter((s) => s.isNext).length;
    const shown = this.showAll ? all : all.slice(0, runners + FIRST_STEPS);
    for (const s of shown) {
      const b = el.createEl("button", { cls: "brewin-next-step" });
      if (s.isNext) b.createSpan({ cls: "brewin-next", text: "⚡ " });
      b.createSpan({ text: plainText(s.text) || "(untitled step)" });
      if (s.due) b.createSpan({ cls: "brewin-next-step-due", text: ` 🚩 ${s.due}` });
      b.addEventListener("click", () => this.submit(s, ""));
    }
    if (shown.length < all.length) {
      const more = el.createEl("button", { cls: "brewin-next-more", text: `Show all ${all.length} steps` });
      more.addEventListener("click", () => {
        this.showAll = true;
        this.drawSteps();
      });
    }
  }

  private submit(promote: ProjectTask | null, add: string): void {
    this.close();
    this.o.onSubmit({ promote, add });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
