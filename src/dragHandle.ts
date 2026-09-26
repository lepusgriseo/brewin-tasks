// Shared long-press drag. No Obsidian imports.
//
// Dragging used to arm on pointer-down and begin after 6px of movement, which meant a
// slightly imprecise tap on a phone moved an event instead of opening it. Here the FIRST tap
// is always "open this" — dragging only becomes possible after a deliberate press-and-hold.
//
// Sequence:
//   down            → start the hold timer
//   move  < hold    → past a small slop radius this is a scroll or a sloppy tap: cancel
//   timer fires     → armed; onArm() gives feedback so the hold is visibly acknowledged
//   move  > armed   → onMove(); default prevented so the page doesn't scroll under the drag
//   up    armed     → onDrop()
//   up   !armed     → nothing happens here, so the element's own click handler runs
//
// `touch-action` is left permissive so a normal scroll still works over a draggable; if the
// browser does take the gesture for scrolling it sends pointercancel, which aborts cleanly.
//
// **Touch scrolling has to be cancelled via `touchmove`, not `pointermove`.** Chromium (so
// Android, so Obsidian mobile) ignores `preventDefault()` on pointermove for scroll purposes.
// Without a non-passive touchmove listener the browser wins the gesture, scrolls whatever
// container the drag started in, and fires pointercancel — so an armed drag dies the moment
// the finger moves. That looked exactly like "the item only moves inside the ALL DAY band".

export interface LongPressDragOptions {
  /** Milliseconds to hold before dragging becomes possible. */
  holdMs?: number;
  /** Movement (px) before the hold completes that means "this was a scroll, not a press". */
  slop?: number;
  /** The hold completed — the element is now draggable. Show it. */
  onArm: () => void;
  /** Pointer moved while armed. */
  onMove: (x: number, y: number) => void;
  /** Released while armed — perform the drop. */
  onDrop: (x: number, y: number) => void;
  /** Armed drag ended without a drop, or was cancelled. Always runs after onArm. */
  onCancel: () => void;
}

export const DEFAULT_HOLD_MS = 450;
const DEFAULT_SLOP = 8;

/**
 * Wire an element for press-and-hold dragging. Returns a teardown function.
 *
 * The caller keeps ownership of click handling: nothing here calls the element's click, so
 * a plain tap falls through to whatever the element already does.
 */
export function attachLongPressDrag(el: HTMLElement, opts: LongPressDragOptions): () => void {
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS;
  const slop = opts.slop ?? DEFAULT_SLOP;

  const onPointerDown = (e: PointerEvent) => {
    // Ignore secondary mouse buttons; touch and pen report button 0.
    if (e.button !== 0 && e.pointerType === "mouse") return;

    const startX = e.clientX;
    const startY = e.clientY;
    let armed = false;
    let moved = false;
    let timer: number | null = null;
    // Restored on finish — leaving it set would stop the element scrolling ever again.
    const priorTouchAction = el.style.touchAction;
    const blockScroll = (scrollEv: Event) => scrollEv.preventDefault();

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const finish = (cancelled: boolean, ev?: PointerEvent) => {
      clearTimer();
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("touchmove", blockScroll);
      el.style.touchAction = priorTouchAction;
      if (!armed) return;
      // Armed but never actually moved: the user held and let go. Treat that as a cancel
      // rather than "dropped where it already was" — otherwise a hold-and-release rewrites
      // the note's date to the value it already had.
      if (cancelled || !ev || !moved) opts.onCancel();
      else opts.onDrop(ev.clientX, ev.clientY);
    };

    const onMove = (ev: PointerEvent) => {
      if (!armed) {
        // Still waiting on the hold: real movement means the user is scrolling or was
        // just sloppy, so give the gesture back rather than hijacking it.
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > slop) {
          clearTimer();
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          document.removeEventListener("pointercancel", onPointerCancel);
        }
        return;
      }
      ev.preventDefault(); // stop the page scrolling under an active drag
      moved = true;
      opts.onMove(ev.clientX, ev.clientY);
    };

    const onUp = (ev: PointerEvent) => finish(false, ev);
    const onPointerCancel = () => finish(true);

    timer = window.setTimeout(() => {
      timer = null;
      armed = true;
      // Once armed the element owns the gesture; releasing implicit capture here would
      // lose events if the pointer leaves the element mid-drag.
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort — document listeners cover us either way */
      }
      // THE fix for mobile: stop the browser scrolling now that this gesture is a drag.
      document.addEventListener("touchmove", blockScroll, { passive: false });
      el.style.touchAction = "none";
      opts.onArm();
    }, holdMs);

    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onPointerCancel);
  };

  el.addEventListener("pointerdown", onPointerDown);
  return () => el.removeEventListener("pointerdown", onPointerDown);
}

export interface LongPressTapOptions {
  /** Milliseconds to hold before the press counts as a long-press. */
  holdMs?: number;
  /** Movement (px) before the hold completes that cancels it — a scroll, not a hold. */
  slop?: number;
  /** The hold completed without moving. `target` is where the press began (`e.target`). */
  onLongPress: (x: number, y: number, target: EventTarget | null) => void;
}

/**
 * Long-press-in-place, as distinct from {@link attachLongPressDrag}: this is for a stationary
 * hold on empty space (e.g. "long-press the grid to create something here"), not for picking
 * something up and moving it. A hold that ends without moving beyond `slop` fires
 * `onLongPress`; a hold that ends early, or that moves, fires nothing — the gesture falls
 * through to whatever the element already does (a plain tap, a scroll).
 *
 * No touch-scroll suppression is needed here, unlike the drag case: there's no drag phase to
 * defend once armed, and before the timer fires the slop check already yields to a real scroll.
 */
export function attachLongPressTap(el: HTMLElement, opts: LongPressTapOptions): () => void {
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS;
  const slop = opts.slop ?? DEFAULT_SLOP;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;

    const startX = e.clientX;
    const startY = e.clientY;
    const target = e.target;
    let timer: number | null = null;

    const cleanup = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };

    const onMove = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > slop) cleanup();
    };
    const onUp = () => cleanup();

    timer = window.setTimeout(() => {
      timer = null;
      cleanup();
      opts.onLongPress(startX, startY, target);
    }, holdMs);

    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  el.addEventListener("pointerdown", onPointerDown);
  return () => el.removeEventListener("pointerdown", onPointerDown);
}

/** Short haptic tick when a hold arms, where the platform supports it. */
export function hapticTick(): void {
  try {
    navigator.vibrate?.(12);
  } catch {
    /* unsupported — the visual cue carries it */
  }
}
