// Keyboard and screen-reader basics for the Planner's own controls.
//
// Much of the Planner is drawn as spans and divs that act on a click — a task's title, a chip, a
// section heading, an event on the calendar. A mouse or a finger can use them; a keyboard couldn't
// reach them, and a screen reader didn't know they did anything. `pressable` gives such an element
// what a button has: a place in the tab order, a role, and Enter and Space. The click handlers stay
// as they are — a key press clicks the element.
//
// The views also redraw themselves after every change, which used to drop keyboard focus back to the
// top of the page; `saveFocus` / `restoreFocus` put it back on the same control, or on the one that
// took its place.

import type { Menu } from "obsidian";

/**
 * Make a clickable element work from the keyboard: focusable, announced as a button (or `role`),
 * and pressed with Enter or Space. A key pressed on a control inside it (a button, a checkbox) is
 * left to that control. `expanded` marks a heading that folds what follows it.
 */
export function pressable<T extends HTMLElement>(
  el: T,
  o: { label?: string; role?: string; expanded?: boolean; pressed?: boolean } = {}
): T {
  if (!el.hasAttribute("role")) el.setAttr("role", o.role ?? "button");
  if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
  if (o.label) el.setAttr("aria-label", o.label);
  if (o.expanded !== undefined) el.setAttr("aria-expanded", String(o.expanded));
  if (o.pressed !== undefined) el.setAttr("aria-pressed", String(o.pressed));
  el.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.target !== el || (e.key !== "Enter" && e.key !== " ") || e.isComposing) return;
    e.preventDefault();
    el.click();
  });
  return el;
}

/** Enter pressed to submit, not to choose a word while an IME is composing (Japanese, Chinese, Korean). */
export function isSubmitKey(e: KeyboardEvent): boolean {
  // 229 is what some browsers report for keys that belong to a composition.
  return e.key === "Enter" && !e.isComposing && e.keyCode !== 229;
}

/**
 * Show a menu where it was asked for: at the pointer for a click, under the control for a key press
 * (a keyboard "click" has no position, and the menu opened in the window's top-left corner).
 */
export function showMenuFor(menu: Menu, ev: MouseEvent | KeyboardEvent): void {
  const fromPointer = ev instanceof MouseEvent && ev.detail > 0 && (ev.clientX !== 0 || ev.clientY !== 0);
  if (fromPointer) {
    menu.showAtMouseEvent(ev as MouseEvent);
    return;
  }
  const target = (ev.currentTarget ?? ev.target) as HTMLElement | null;
  const r = target?.getBoundingClientRect?.();
  menu.showAtPosition(r ? { x: r.left, y: r.bottom } : { x: 0, y: 0 });
}

/** Where keyboard focus was inside a view, to put it back after the view redraws. */
export interface FocusMark {
  key: string | null;
  index: number;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

/** Focus inside `root`, if it is there — null when the keyboard is elsewhere (an editor, another pane). */
export function saveFocus(root: HTMLElement): FocusMark | null {
  const active = root.doc.activeElement;
  if (!(active instanceof HTMLElement) || active === root || !root.contains(active)) return null;
  return { key: active.getAttribute("data-focus"), index: focusables(root).indexOf(active) };
}

/**
 * Put focus back after a redraw: on the control with the same `data-focus` key, else the one now in
 * its place (a ticked task's row is gone; the next row's box is where the keyboard was), else
 * `fallback`. Nothing happens when focus wasn't in the view before.
 */
export function restoreFocus(root: HTMLElement, mark: FocusMark | null, fallback?: HTMLElement | null): void {
  if (!mark) return;
  const all = focusables(root);
  const byKey = mark.key ? all.find((el) => el.getAttribute("data-focus") === mark.key) : undefined;
  const candidates = [byKey, mark.index >= 0 ? all[Math.min(mark.index, all.length - 1)] : undefined, fallback];
  for (const el of candidates) {
    if (!el) continue;
    el.focus({ preventScroll: true });
    if (root.doc.activeElement === el) return;
  }
}
