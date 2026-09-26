import { App, Modal, Notice, TFile } from "obsidian";
import { BrewinSettings } from "./settings";
import { pickDate } from "./datePicker";
import { createTrip } from "./tripStore";

/**
 * Quick-create a new trip note, for linking to an event before the trip note exists yet.
 * Both dates default to the event's own date — whichever side (start for a "depart" leg,
 * end for a "return" leg) isn't right just gets moved.
 */
export class TripCreateModal extends Modal {
  private destination = "";
  private start: string;
  private end: string;

  constructor(
    app: App,
    private settings: BrewinSettings,
    defaultDateISO: string,
    private onCreated: (file: TFile) => void
  ) {
    super(app);
    this.start = defaultDateISO;
    this.end = defaultDateISO;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "New trip" });

    const destInput = contentEl.createEl("input", {
      type: "text",
      cls: "brewin-capture-title",
      placeholder: "Destination",
    });
    destInput.addEventListener("input", () => (this.destination = destInput.value));
    window.setTimeout(() => destInput.focus(), 0);

    const dateRow = contentEl.createDiv({ cls: "brewin-capture-dates" });
    const startBtn = dateRow.createEl("button", { cls: "brewin-chip brewin-chip-set" });
    const endBtn = dateRow.createEl("button", { cls: "brewin-chip brewin-chip-set" });
    const render = () => {
      startBtn.setText(`📅 Starts ${this.start}`);
      endBtn.setText(`📅 Ends ${this.end}`);
    };
    render();

    startBtn.addEventListener("click", async () => {
      const r = await pickDate(this.app, this.start, this.settings.firstDayOfWeek, {
        selectedLabel: "Starts",
        relatedISO: this.end,
        relatedLabel: "Ends",
      });
      if (!r) return; // cancelled or cleared — a trip needs a start date
      this.start = r;
      if (this.end < r) this.end = r;
      render();
    });

    endBtn.addEventListener("click", async () => {
      const r = await pickDate(this.app, this.end, this.settings.firstDayOfWeek, {
        selectedLabel: "Ends",
        relatedISO: this.start,
        relatedLabel: "Starts",
      });
      if (!r) return;
      if (r < this.start) {
        new Notice("End date must be on or after the start date.");
        return;
      }
      this.end = r;
      render();
    });

    const btns = contentEl.createDiv({ cls: "brewin-capture-buttons" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Create trip", cls: "mod-cta" }).addEventListener("click", async () => {
      const destination = this.destination.trim();
      if (!destination) {
        new Notice("Trip needs a destination");
        return;
      }
      const file = await createTrip(this.app, this.settings, { destination, start: this.start, end: this.end });
      new Notice(`Trip created: ${destination}`);
      this.onCreated(file);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
