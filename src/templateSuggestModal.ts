import { App, SuggestModal } from "obsidian";
import { describeTemplate, PlannerTemplate } from "./plannerTemplate";

/** Pick a template by typing its name. Shows what each one will do, so the list is self-explaining. */
export class TemplateSuggestModal extends SuggestModal<PlannerTemplate> {
  constructor(app: App, private templates: PlannerTemplate[], private onChoose: (t: PlannerTemplate) => void) {
    super(app);
    this.setPlaceholder(templates.length ? "Which template?" : "No templates in the library yet");
  }

  getSuggestions(query: string): PlannerTemplate[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.templates;
    return this.templates.filter((t) => t.name.toLowerCase().includes(q) || t.kind.includes(q));
  }

  renderSuggestion(t: PlannerTemplate, el: HTMLElement): void {
    el.createDiv({ text: t.name, cls: "brewin-suggest-title" });
    el.createDiv({ cls: "brewin-suggest-meta", text: describeTemplate(t) });
  }

  onChooseSuggestion(t: PlannerTemplate): void {
    this.onChoose(t);
  }
}
