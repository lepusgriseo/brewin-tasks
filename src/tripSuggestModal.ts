import { App, FuzzySuggestModal, TFile } from "obsidian";

/**
 * Fuzzy picker for linking an event to a trip note. The caller passes an already-filtered
 * list (see the "Link trip…" handler in eventModal.ts).
 */
export class TripSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private trips: TFile[], private onPick: (file: TFile) => void, placeholder = "Choose a trip…") {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): TFile[] {
    return this.trips;
  }

  getItemText(file: TFile): string {
    return file.basename;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}
