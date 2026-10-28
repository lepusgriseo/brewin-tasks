// An event from another calendar: what it is, when and where, and which calendar — read-only, since
// it belongs to that calendar. "Copy as a Planner event" makes an event note of it, which is the
// Planner's to change.

import { App, Modal } from "obsidian";
import type BrewinTasksPlugin from "./main";
import type { CalendarItem } from "./types";
import { longDay } from "./planDayModal";

export class ExternalEventModal extends Modal {
  constructor(app: App, private plugin: BrewinTasksPlugin, private it: CalendarItem) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const it = this.it;
    this.modalEl.addClass("brewin-external-modal");
    contentEl.createEl("h3", { text: it.title });
    const when = it.allDay ? "All day" : `${it.start ?? ""}${it.end ? `–${it.end}` : ""}`;
    contentEl.createDiv({ cls: "brewin-capture-hint", text: `${longDay(it.date)} · ${when}` });
    const cal = contentEl.createDiv({ cls: "brewin-external-cal" });
    cal.createSpan({ cls: "brewin-external-dot" }).style.background = it.external?.color ?? "var(--text-muted)";
    cal.createSpan({ text: `${it.category} — from another calendar, so it's changed there` });
    if (it.location) contentEl.createDiv({ cls: "brewin-external-where", text: `📍 ${it.location}` });
    if (it.external?.unsupported) {
      contentEl.createDiv({ cls: "brewin-external-warn", text: "⚠️ It repeats in a way the Planner can't follow, so only its first date is shown." });
    }
    const desc = it.external?.description;
    if (desc) contentEl.createDiv({ cls: "brewin-external-desc", text: desc.length > 1200 ? `${desc.slice(0, 1200)}…` : desc });

    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    btns.createEl("button", { text: "Copy as a Planner event" }).addEventListener("click", () => {
      this.close();
      void this.plugin.act(async () => {
        const file = await this.plugin.events.createEvent({
          title: it.title,
          date: it.date,
          endDate: null,
          allDay: it.allDay,
          startTime: it.allDay ? null : it.start,
          endTime: it.allDay ? null : it.end,
          category: this.plugin.settings.categories[0]?.name ?? "General",
          location: it.location ?? null,
        });
        this.plugin.refreshViews();
        return `Copied “${it.title}” into ${file.parent?.path ?? "your events"}`;
      });
    });
    btns.createEl("button", { text: "Close", cls: "mod-cta" }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
