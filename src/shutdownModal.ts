// Shut down — the end of the day in one window: what got done, how the top three went, and an answer
// for everything still open (tomorrow, Someday, or leave it), then the day note to write in. Every
// change is offered back with Undo; the window keeps its own record of what has been answered.

import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import type BrewinTasksPlugin from "./main";
import { dayClose } from "./planDay";
import { longDay } from "./planDayModal";
import { shiftISO, todayISO } from "./dates";
import { restoreFocus, saveFocus } from "./a11y";

export class ShutdownModal extends Modal {
  private readonly today = todayISO();
  /** Open tasks answered here, by path, with what was done with them. */
  private answered = new Map<string, string>();

  constructor(app: App, private plugin: BrewinTasksPlugin) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("brewin-plan-modal", "brewin-shutdown-modal");
    this.draw();
  }

  private draw(): void {
    const { contentEl } = this;
    const focus = saveFocus(contentEl);
    contentEl.empty();
    const close = dayClose(this.plugin.store.getTasks(), this.today, this.today);

    const head = contentEl.createDiv({ cls: "brewin-plan-head" });
    head.createEl("h3", { text: "🌙 Shut down" });
    head.createDiv({ cls: "brewin-capture-hint", text: longDay(this.today) });

    const body = contentEl.createDiv({ cls: "brewin-plan-body" });
    if (close.top.total) {
      const t = body.createDiv({ cls: "brewin-plan-sum" + (close.top.done === close.top.total ? " is-done" : "") });
      t.setText(`⭐ Top ${close.top.total}: ${close.top.done} done${close.top.open.length ? ` — still open: ${close.top.open.map((x) => x.title).join(", ")}` : ""}`);
    }

    body.createEl("h4", { cls: "brewin-plan-h", text: `Done today · ${close.done.length}` });
    if (!close.done.length) body.createDiv({ cls: "brewin-plan-lede", text: "Nothing ticked today." });
    for (const t of close.done) body.createDiv({ cls: "brewin-plan-row is-done", text: `✓ ${t.title}` });

    const open = close.open;
    body.createEl("h4", { cls: "brewin-plan-h", text: `Still open · ${open.length}` });
    if (!open.length) body.createDiv({ cls: "brewin-plan-lede", text: "Nothing left from today. 🎉" });
    const unanswered = open.filter((t) => !this.answered.has(t.path));
    if (unanswered.length > 1) {
      const all = body.createEl("button", { cls: "brewin-chip-mini", text: "All to tomorrow", attr: { "data-focus": "all" } });
      all.addEventListener("click", async () => {
        const tomorrow = shiftISO(this.today, 1) ?? this.today;
        await this.plugin.act(async () => {
          const n = await this.plugin.store.bulkReschedule(unanswered, tomorrow);
          return `Moved ${n} task${n === 1 ? "" : "s"} to tomorrow`;
        });
        for (const t of unanswered) this.answered.set(t.path, "tomorrow");
        this.draw();
      });
    }
    for (const t of open) {
      const row = body.createDiv({ cls: "brewin-plan-row" });
      row.createDiv({ cls: "brewin-plan-title", text: t.title });
      const answer = this.answered.get(t.path);
      if (answer) {
        row.addClass("is-answered");
        row.createSpan({ cls: "brewin-plan-answer", text: `✓ ${answer}` });
        continue;
      }
      const btns = row.createDiv({ cls: "brewin-plan-btns" });
      const act = (label: string, said: string, fn: () => Promise<unknown>) =>
        btns.createEl("button", { text: label, cls: "brewin-chip-mini", attr: { "aria-label": `${label}: ${t.title}`, "data-focus": `open:${label}:${t.path}` } }).addEventListener("click", async () => {
          await this.plugin.act(async () => {
            await fn();
            return `“${t.title}” → ${said}`;
          });
          this.answered.set(t.path, said);
          this.draw();
        });
      if (!t.recurrence) act("Tomorrow", "tomorrow", () => this.plugin.store.setScheduled(t, shiftISO(this.today, 1)));
      if (!t.recurrence) act("Someday", "Someday", () => this.plugin.store.setStatus(t, "someday"));
      btns.createEl("button", { text: "Leave it", cls: "brewin-chip-mini", attr: { "aria-label": `Leave “${t.title}” as it is` } }).addEventListener("click", () => {
        this.answered.set(t.path, "left as it is");
        this.draw();
      });
    }

    const foot = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    foot.createEl("button", { text: "Open today's note", attr: { "data-focus": "note" } }).addEventListener("click", () => void this.openDayNote());
    foot.createEl("button", { text: "Done", cls: "mod-cta", attr: { "data-focus": "done" } }).addEventListener("click", () => this.close());
    restoreFocus(contentEl, focus, contentEl.querySelector<HTMLElement>("[data-focus='done']"));
  }

  /** The day note, where the journal line for the day goes. */
  private async openDayNote(): Promise<void> {
    const path = normalizePath(`${this.plugin.settings.dayNotesFolder}/${this.today}.md`);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return void new Notice(`No day note for today yet (${path}).`);
    this.close();
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  onClose(): void {
    this.contentEl.empty();
    this.plugin.refreshViews();
  }
}
