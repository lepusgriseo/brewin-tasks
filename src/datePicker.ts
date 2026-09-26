import { App, Modal } from "obsidian";
import {
  addDays,
  addMonths,
  daysInMonth,
  formatISO,
  parseISO,
  todayUTC,
} from "./dates";
import { parseNaturalDate } from "./dateParser";
import { dayMarks } from "./calendar";

const WEEK_HEADERS_MON = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const WEEK_HEADERS_SUN = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export interface DatePickerOptions {
  /** The paired date (e.g. the due date while picking `scheduled`), shown for context. */
  relatedISO?: string | null;
  /** What that paired date is, e.g. "Due" — used in the tooltip and footer. */
  relatedLabel?: string;
  /** What the value being picked is, e.g. "Scheduled". */
  selectedLabel?: string;
}

/**
 * A mobile-safe calendar date picker rendered as a Modal (works identically on
 * desktop and phone). Resolves to an ISO string, null (cleared), or undefined (cancelled).
 *
 * The grid marks three things distinctly: the **selected** date (filled), the **paired**
 * date and the span between them (tinted), and **today** (ring).
 */
export class DatePickerModal extends Modal {
  private view: Date;
  private firstDay: number;
  private onPick: (iso: string | null | undefined) => void;
  private picked = false;
  private selectedISO: string | null;
  private opts: DatePickerOptions;

  constructor(
    app: App,
    currentISO: string | null,
    firstDayOfWeek: number,
    onPick: (iso: string | null | undefined) => void,
    opts: DatePickerOptions = {}
  ) {
    super(app);
    this.view = parseISO(currentISO) ?? todayUTC();
    this.firstDay = firstDayOfWeek === 0 ? 0 : 1;
    this.onPick = onPick;
    const current = currentISO ? parseISO(currentISO) : null;
    this.selectedISO = current ? formatISO(current) : null;
    this.opts = opts;
  }

  onOpen(): void {
    this.modalEl.addClass("brewin-datepicker-modal");
    this.render();
  }

  private choose(iso: string | null): void {
    this.picked = true;
    this.onPick(iso);
    this.close();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Quick row
    const quick = contentEl.createDiv({ cls: "brewin-dp-quick" });
    const today = todayUTC();
    const mkQuick = (label: string, date: Date | null) =>
      quick.createEl("button", { text: label, cls: "brewin-dp-quickbtn" }).addEventListener("click", () =>
        this.choose(date ? formatISO(date) : null)
      );
    mkQuick("Today", today);
    mkQuick("Tomorrow", addDays(today, 1));
    mkQuick("Next week", addDays(today, 7));
    mkQuick("Clear", null);

    // NL input
    const nl = contentEl.createDiv({ cls: "brewin-dp-nl" });
    const input = nl.createEl("input", { type: "text", placeholder: "e.g. next fri, +3d, 2026-08-01" });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const iso = parseNaturalDate(input.value);
        if (iso) this.choose(iso);
        else input.addClass("brewin-dp-invalid");
      }
    });

    // Month header
    const header = contentEl.createDiv({ cls: "brewin-dp-header" });
    header.createEl("button", { text: "‹" }).addEventListener("click", () => {
      this.view = addMonths(this.view, -1);
      this.render();
    });
    header.createEl("span", {
      cls: "brewin-dp-title",
      text: this.view.toLocaleString("default", { month: "long", timeZone: "UTC" }) + " " + this.view.getUTCFullYear(),
    });
    header.createEl("button", { text: "›" }).addEventListener("click", () => {
      this.view = addMonths(this.view, 1);
      this.render();
    });

    // Grid
    const grid = contentEl.createDiv({ cls: "brewin-dp-grid" });
    const headers = this.firstDay === 0 ? WEEK_HEADERS_SUN : WEEK_HEADERS_MON;
    headers.forEach((h) => grid.createDiv({ cls: "brewin-dp-dow", text: h }));

    const year = this.view.getUTCFullYear();
    const month = this.view.getUTCMonth();
    const first = new Date(Date.UTC(year, month, 1));
    const startDow = first.getUTCDay(); // 0=Sun
    const offset = this.firstDay === 0 ? startDow : (startDow + 6) % 7;
    const dim = daysInMonth(year, month);
    const todayISO = formatISO(today);

    // Marks: the value being picked, its paired date, and the span between them.
    const selected = this.selectedISO;
    const relatedDate = this.opts.relatedISO ? parseISO(this.opts.relatedISO) : null;
    const related = relatedDate ? formatISO(relatedDate) : null;

    for (let i = 0; i < offset; i++) grid.createDiv({ cls: "brewin-dp-empty" });
    for (let day = 1; day <= dim; day++) {
      const cellDate = new Date(Date.UTC(year, month, day));
      const iso = formatISO(cellDate);
      const cell = grid.createEl("button", { cls: "brewin-dp-day", text: String(day) });

      const m = dayMarks(iso, selected, related, todayISO);
      if (m.inSpan) cell.addClass("brewin-dp-inspan");
      if (m.related) cell.addClass("brewin-dp-related");
      if (m.selected) cell.addClass("brewin-dp-selected");
      if (m.today) cell.addClass("brewin-dp-today");

      const marks: string[] = [];
      if (m.selected) marks.push(`current ${this.opts.selectedLabel?.toLowerCase() ?? "selection"}`);
      if (m.related) marks.push(this.opts.relatedLabel?.toLowerCase() ?? "paired date");
      if (m.today) marks.push("today");
      cell.setAttr("aria-label", marks.length ? `${iso} — ${marks.join(", ")}` : iso);

      cell.addEventListener("click", () => this.choose(iso));
    }

    // Key for the marks — so the colours aren't the only thing carrying meaning.
    const key = contentEl.createDiv({ cls: "brewin-dp-key" });
    if (selected) {
      const k = key.createSpan({ cls: "brewin-dp-key-item" });
      k.createSpan({ cls: "brewin-dp-key-swatch is-selected" });
      k.createSpan({ text: `${this.opts.selectedLabel ?? "Selected"} ${selected}` });
    }
    if (related) {
      const k = key.createSpan({ cls: "brewin-dp-key-item" });
      k.createSpan({ cls: "brewin-dp-key-swatch is-related" });
      k.createSpan({ text: `${this.opts.relatedLabel ?? "Paired"} ${related}` });
    }
    const kt = key.createSpan({ cls: "brewin-dp-key-item" });
    kt.createSpan({ cls: "brewin-dp-key-swatch is-today" });
    kt.createSpan({ text: "Today" });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.picked) this.onPick(undefined); // cancelled
  }
}

/** Promise wrapper: resolves to ISO | null (cleared) | undefined (cancelled). */
export function pickDate(
  app: App,
  currentISO: string | null,
  firstDayOfWeek: number,
  opts: DatePickerOptions = {}
): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    new DatePickerModal(app, currentISO, firstDayOfWeek, resolve, opts).open();
  });
}
