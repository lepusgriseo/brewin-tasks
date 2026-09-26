import { App, FuzzySuggestModal } from "obsidian";
import { Task } from "./types";

/**
 * Fuzzy picker for choosing a parent task. The caller passes an already-filtered list
 * (see `validParentCandidates`), so cycles are impossible by construction.
 */
export class TaskSuggestModal extends FuzzySuggestModal<Task> {
  constructor(app: App, private tasks: Task[], private onPick: (task: Task) => void, placeholder = "Choose a parent task…") {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): Task[] {
    return this.tasks;
  }

  getItemText(task: Task): string {
    return task.title;
  }

  onChooseItem(task: Task): void {
    this.onPick(task);
  }
}
