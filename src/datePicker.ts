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
import { isSubmitKey, restoreFocus, saveFocus } from "./a11y";

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
  /** The day the keyboard should land on after the next draw (an arrow key crossed into another month). */
  private focusISO: string | null = null;

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
    // Start on the chosen day (or today), so the arrow keys work at once.
    this.focusISO = this.selectedISO ?? formatISO(todayUTC());
    this.render();
  }

  private choose(iso: string | null): void {
    this.picked = true;
    this.onPick(iso);
    this.close();
  }

  private render(): void {
    const { contentEl } = this;
    // ‹ and › redraw the month; the keyboard stays on the arrow it pressed.
    const focus = saveFocus(contentEl);
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
    input.setAttr("aria-label", "Type a date");
    input.addEventListener("input", () => {
      input.removeClass("brewin-dp-invalid");
      input.removeAttribute("aria-invalid");
    });
    input.addEventListener("keydown", (e) => {
      if (isSubmitKey(e)) {
        const iso = parseNaturalDate(input.value);
        if (iso) this.choose(iso);
        else {
          input.addClass("brewin-dp-invalid");
          input.setAttr("aria-invalid", "true");
        }
      }
    });

    // Month header
    const header = contentEl.createDiv({ cls: "brewin-dp-header" });
    // Each arrow is described by the month heading, so landing back on it after a press says the month.
    const titleId = `brewin-dp-title-${Math.random().toString(36).slice(2, 8)}`;
    const nav = { "aria-describedby": titleId };
    header.createEl("button", { text: "‹", attr: { "aria-label": "Previous month", "data-focus": "dp:prev", ...nav } }).addEventListener("click", () => {
      this.view = addMonths(this.view, -1);
      this.render();
    });
    header.createEl("span", {
      cls: "brewin-dp-title",
      text: this.view.toLocaleString("default", { month: "long", timeZone: "UTC" }) + " " + this.view.getUTCFullYear(),
      attr: { id: titleId },
    });
    header.createEl("button", { text: "›", attr: { "aria-label": "Next month", "data-focus": "dp:next", ...nav } }).addEventListener("click", () => {
      this.view = addMonths(this.view, 1);
      this.render();
    });

    // Grid
    const grid = contentEl.createDiv({ cls: "brewin-dp-grid" });
    const headers = this.firstDay === 0 ? WEEK_HEADERS_SUN : WEEK_HEADERS_MON;
    // The day buttons say their whole date; these two-letter headings are for the eye.
    headers.forEach((h) => grid.createDiv({ cls: "brewin-dp-dow", text: h, attr: { "aria-hidden": "true" } }));
    grid.addEventListener("keydown", (e) => this.arrowKey(e));

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
      const cell = grid.createEl("button", { cls: "brewin-dp-day", text: String(day), attr: { "data-focus": `dp:${iso}`, "data-iso": iso } });

      const m = dayMarks(iso, selected, related, todayISO);
      if (m.inSpan) cell.addClass("brewin-dp-inspan");
      if (m.related) cell.addClass("brewin-dp-related");
      if (m.selected) cell.addClass("brewin-dp-selected");
      if (m.today) cell.addClass("brewin-dp-today");

      const marks: string[] = [];
      if (m.selected) marks.push(`current ${this.opts.selectedLabel?.toLowerCase() ?? "selection"}`);
      if (m.related) marks.push(this.opts.relatedLabel?.toLowerCase() ?? "paired date");
      if (m.today) marks.push("today");
      const spoken = cellDate.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
      cell.setAttr("aria-label", marks.length ? `${spoken} — ${marks.join(", ")}` : spoken);
      if (m.today) cell.setAttr("aria-current", "date");

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

    const land = this.focusISO;
    this.focusISO = null;
    const target = land ? contentEl.querySelector<HTMLElement>(`[data-iso="${land}"]`) : null;
    if (target) target.focus({ preventScroll: true });
    else restoreFocus(contentEl, focus);
  }

  /** Arrow keys move a day or a week, Page Up and Down a month, Home and End to the week's ends. */
  private arrowKey(e: KeyboardEvent): void {
    const from = (e.target as HTMLElement | null)?.getAttribute?.("data-iso");
    const fromDate = from ? parseISO(from) : null;
    if (!fromDate) return;
    const dow = (fromDate.getUTCDay() - this.firstDay + 7) % 7; // 0 = the week's first day
    const step: Record<string, () => Date> = {
      ArrowLeft: () => addDays(fromDate, -1),
      ArrowRight: () => addDays(fromDate, 1),
      ArrowUp: () => addDays(fromDate, -7),
      ArrowDown: () => addDays(fromDate, 7),
      PageUp: () => addMonths(fromDate, -1),
      PageDown: () => addMonths(fromDate, 1),
      Home: () => addDays(fromDate, -dow),
      End: () => addDays(fromDate, 6 - dow),
    };
    const go = step[e.key];
    if (!go) return;
    e.preventDefault();
    const to = go();
    const iso = formatISO(to);
    const here = this.contentEl.querySelector<HTMLElement>(`[data-iso="${iso}"]`);
    if (here) {
      here.focus();
      return;
    }
    this.view = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    this.focusISO = iso;
    this.render();
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
