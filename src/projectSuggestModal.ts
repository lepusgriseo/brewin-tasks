import { App, FuzzySuggestModal } from "obsidian";

/** A project note, as offered when moving a task into one. */
export interface ProjectChoice {
  path: string;
  name: string;
}

/** Fuzzy picker over the active project notes. */
export class ProjectSuggestModal extends FuzzySuggestModal<ProjectChoice> {
  constructor(app: App, private projects: ProjectChoice[], private onPick: (project: ProjectChoice) => void) {
    super(app);
    this.setPlaceholder("Move to which project?");
    this.emptyStateText = "No active projects — a project note needs the #project tag and status: active.";
  }

  getItems(): ProjectChoice[] {
    return this.projects;
  }

  getItemText(p: ProjectChoice): string {
    return p.name;
  }

  onChooseItem(p: ProjectChoice): void {
    this.onPick(p);
  }
}
