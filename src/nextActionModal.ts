import { App, Modal } from "obsidian";
import { ProjectTask } from "./projectTasks";
import { matchStep, plainText, ProjectInfo, promoteCandidates } from "./projects";

export interface NextActionChoice {
  /** The step the finished action was, to tick in the note — null leaves the steps alone. */
  tick: ProjectTask | null;
  /** The step chosen to be the next action, whose `#next` tag comes off. */
  promote: ProjectTask | null;
  next: string;
}

/** Steps offered before "Show all": every `#next` one, then this many of the rest. */
const FIRST_STEPS = 6;

/**
 * Finish a project's next action and choose the one after it — or, for a project without one, just
 * choose. The note's own steps come first, `#next` ones on top; anything else can be typed.
 */
export class NextActionModal extends Modal {
  /** The open step the finished action looks like — offered for ticking, never ticked unseen. */
  private matched: { step: ProjectTask; sure: boolean } | null;
  private tick: ProjectTask | null;
  private showAll = false;
  private typed = "";
  private stepsEl: HTMLElement | null = null;

  constructor(
    app: App,
    private o: { project: ProjectInfo; steps: ProjectTask[]; done: boolean; onSubmit: (c: NextActionChoice) => void }
  ) {
    super(app);
    this.matched = o.done && o.project.next ? matchStep(o.project.next, o.steps) : null;
    this.tick = this.matched?.sure ? this.matched.step : null;
  }

  onOpen(): void {
    const { contentEl } = this;
    const p = this.o.project;
    contentEl.addClass("brewin-next-modal");
    contentEl.createEl("h3", { text: this.o.done ? "Next action done" : "Choose the next action" });
    contentEl.createDiv({ cls: "brewin-capture-hint", text: p.name });

    if (this.o.done && p.next) {
      contentEl.createDiv({ cls: "brewin-next-finished", text: `✓ ${plainText(p.next)}` });
      if (this.matched) {
        const { step, sure } = this.matched;
        const row = contentEl.createEl("label", { cls: "brewin-next-tick" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = sure;
        row.createSpan({ text: `${sure ? "Tick this step in the note as well" : "Was it this step? Tick it in the note too"}: ${plainText(step.text)}` });
        cb.addEventListener("change", () => {
          this.tick = cb.checked ? step : null;
          this.drawSteps(); // a ticked step is finished, so it is no longer offered as the next one
        });
      }
      contentEl.createDiv({ cls: "brewin-capture-hint", text: "It's written into the project's log under today." });
    }

    contentEl.createEl("h4", { text: "What's next?" });
    this.stepsEl = contentEl.createDiv({ cls: "brewin-next-steps" });
    this.drawSteps();

    const input = contentEl.createEl("input", { type: "text", cls: "brewin-capture-title" });
    input.placeholder = "Or type the next action";
    input.addEventListener("input", () => (this.typed = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (this.typed.trim()) this.submit(null, this.typed.trim());
    });
    if (!this.o.steps.length) window.setTimeout(() => input.focus(), 0);

    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    if (this.o.done) {
      btns.createEl("button", { text: "Nothing yet" }).addEventListener("click", () => this.submit(null, ""));
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
    const all = promoteCandidates(this.o.steps, this.tick);
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
      b.addEventListener("click", () => this.submit(s, s.text));
    }
    if (shown.length < all.length) {
      const more = el.createEl("button", { cls: "brewin-next-more", text: `Show all ${all.length} steps` });
      more.addEventListener("click", () => {
        this.showAll = true;
        this.drawSteps();
      });
    }
  }

  private submit(promote: ProjectTask | null, next: string): void {
    this.close();
    this.o.onSubmit({ tick: this.tick, promote, next });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
