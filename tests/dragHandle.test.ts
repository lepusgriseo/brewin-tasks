import { test } from "node:test";
import assert from "node:assert/strict";

// The module talks to window/document/navigator, so stub just enough of them to drive the
// gesture by hand. Timers are manual, so "hold" is deterministic rather than a real wait.
type Handler = (e: any) => void;

let timers: { id: number; fn: () => void }[] = [];
let nextTimer = 1;
const docHandlers = new Map<string, Set<Handler>>();

(globalThis as any).window = {
  setTimeout: (fn: () => void) => {
    const id = nextTimer++;
    timers.push({ id, fn });
    return id;
  },
  clearTimeout: (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  },
};
(globalThis as any).document = {
  addEventListener: (type: string, fn: Handler) => {
    if (!docHandlers.has(type)) docHandlers.set(type, new Set());
    docHandlers.get(type)!.add(fn);
  },
  removeEventListener: (type: string, fn: Handler) => docHandlers.get(type)?.delete(fn),
};
// navigator is getter-only in Node; hapticTick() is never exercised here, so leave it.

const { attachLongPressDrag, attachLongPressTap } = await import("../src/dragHandle.ts");

function fireHold(): void {
  const due = timers.splice(0, timers.length);
  due.forEach((t) => t.fn());
}
function dispatch(type: string, x: number, y: number): void {
  const ev = { clientX: x, clientY: y, preventDefault() {} };
  [...(docHandlers.get(type) ?? [])].forEach((h) => h(ev));
}

function harness() {
  let down: Handler = () => {};
  const el = {
    style: { touchAction: "manipulation" },
    addEventListener: (type: string, fn: Handler) => {
      if (type === "pointerdown") down = fn;
    },
    removeEventListener: () => {},
    setPointerCapture: () => {},
  } as unknown as HTMLElement;

  const log: string[] = [];
  attachLongPressDrag(el, {
    holdMs: 400,
    onArm: () => log.push("arm"),
    onMove: (x, y) => log.push(`move ${x},${y}`),
    onDrop: (x, y) => log.push(`drop ${x},${y}`),
    onCancel: () => log.push("cancel"),
  });
  return {
    log,
    el,
    down: (x = 0, y = 0) => down({ button: 0, pointerType: "touch", pointerId: 1, clientX: x, clientY: y }),
  };
}

function reset(): void {
  timers = [];
  docHandlers.clear();
}

test("a plain tap never arms — the click is left for the element to handle", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  dispatch("pointerup", 10, 10); // released before the hold completes
  assert.deepEqual(h.log, []);
});

test("holding arms the drag", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  fireHold();
  assert.deepEqual(h.log, ["arm"]);
});

test("hold, move, release → a drop at the release point", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  fireHold();
  dispatch("pointermove", 60, 80);
  dispatch("pointerup", 60, 80);
  assert.deepEqual(h.log, ["arm", "move 60,80", "drop 60,80"]);
});

test("moving BEFORE the hold completes abandons the gesture — that's a scroll", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  dispatch("pointermove", 10, 60); // 50px of travel: the user is scrolling
  fireHold(); // the timer was cleared, so this fires nothing
  dispatch("pointerup", 10, 60);
  assert.deepEqual(h.log, []);
});

test("a tiny wobble under the slop radius still allows the hold", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  dispatch("pointermove", 13, 12); // ~3px — a finger resting, not a scroll
  fireHold();
  assert.deepEqual(h.log, ["arm"]);
});

test("arming then releasing WITHOUT moving cancels — it must not rewrite the date", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  fireHold();
  dispatch("pointerup", 10, 10);
  assert.deepEqual(h.log, ["arm", "cancel"]);
});

test("pointercancel mid-drag tears down cleanly", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  fireHold();
  dispatch("pointermove", 40, 40);
  dispatch("pointercancel", 40, 40);
  assert.deepEqual(h.log, ["arm", "move 40,40", "cancel"]);
});

test("a right-click never starts anything", () => {
  reset();
  let down: Handler = () => {};
  const el = {
    addEventListener: (type: string, fn: Handler) => { if (type === "pointerdown") down = fn; },
    removeEventListener: () => {},
    setPointerCapture: () => {},
  } as unknown as HTMLElement;
  const log: string[] = [];
  attachLongPressDrag(el, {
    onArm: () => log.push("arm"), onMove: () => {}, onDrop: () => {}, onCancel: () => log.push("cancel"),
  });
  down({ button: 2, pointerType: "mouse", pointerId: 1, clientX: 0, clientY: 0 });
  fireHold();
  assert.deepEqual(log, []);
});

test("listeners are removed once the gesture ends, so nothing leaks", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  fireHold();
  dispatch("pointermove", 40, 40);
  dispatch("pointerup", 40, 40);
  assert.equal(docHandlers.get("pointermove")?.size ?? 0, 0);
  assert.equal(docHandlers.get("pointerup")?.size ?? 0, 0);
  assert.equal(docHandlers.get("pointercancel")?.size ?? 0, 0);
});

// ── touch scrolling must not steal an armed drag (v1.39.2) ───────────────────
//
// Chromium ignores preventDefault() on pointermove for scroll purposes, so without a
// non-passive touchmove listener the browser pans the container the drag started in and
// fires pointercancel — killing the drag. On Android this made it impossible to drag an
// event out of the ALL DAY band.

const touchCount = () => docHandlers.get("touchmove")?.size ?? 0;

test("arming registers a touchmove blocker; a plain tap does not", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  assert.equal(touchCount(), 0, "not armed yet — ordinary scrolling must still work");
  fireHold();
  assert.equal(touchCount(), 1, "armed → scrolling is suppressed");
});

test("the blocker is removed on drop", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  fireHold();
  dispatch("pointermove", 40, 90);
  dispatch("pointerup", 40, 90);
  assert.equal(touchCount(), 0);
});

test("the blocker is removed on cancel too, not just on a successful drop", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  fireHold();
  dispatch("pointercancel", 10, 10);
  assert.equal(touchCount(), 0);
});

test("touch-action is overridden while armed and RESTORED afterwards", () => {
  reset();
  const h = harness();
  assert.equal(h.el.style.touchAction, "manipulation");
  h.down(10, 10);
  fireHold();
  assert.equal(h.el.style.touchAction, "none", "the browser must not pan during a drag");
  dispatch("pointermove", 40, 90);
  dispatch("pointerup", 40, 90);
  // Leaking "none" here would silently stop the element scrolling ever again.
  assert.equal(h.el.style.touchAction, "manipulation");
});

test("a tap that never arms leaves touch-action untouched", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  dispatch("pointerup", 10, 10);
  assert.equal(h.el.style.touchAction, "manipulation");
  assert.equal(touchCount(), 0);
});

test("a scroll (movement before the hold) leaves the page fully scrollable", () => {
  reset();
  const h = harness();
  h.down(10, 10);
  dispatch("pointermove", 10, 70); // user is scrolling
  fireHold();
  assert.equal(touchCount(), 0, "the gesture was handed back — never block scrolling");
  assert.equal(h.el.style.touchAction, "manipulation");
});

// ── attachLongPressTap: stationary hold → "create something here" (v1.39.4) ──────────────
//
// Distinct from attachLongPressDrag: the natural gesture here is hold-and-release without
// moving, and that must FIRE (the drag gesture treats the same shape as a cancel, on purpose,
// since there it would mean "dropped where it already was").

function tapHarness() {
  let down: Handler = () => {};
  const el = {
    addEventListener: (type: string, fn: Handler) => {
      if (type === "pointerdown") down = fn;
    },
    removeEventListener: () => {},
  } as unknown as HTMLElement;

  const log: { x: number; y: number; target: unknown }[] = [];
  attachLongPressTap(el, {
    holdMs: 400,
    onLongPress: (x, y, target) => log.push({ x, y, target }),
  });
  return {
    log,
    down: (x = 0, y = 0, target: unknown = "el") =>
      down({ button: 0, pointerType: "touch", pointerId: 1, clientX: x, clientY: y, target }),
  };
}

test("a stationary hold fires onLongPress at the press point, with the original target", () => {
  reset();
  const h = tapHarness();
  h.down(10, 10, "the-cell");
  fireHold();
  assert.deepEqual(h.log, [{ x: 10, y: 10, target: "the-cell" }]);
});

test("releasing before the hold completes fires nothing — that's a plain tap", () => {
  reset();
  const h = tapHarness();
  h.down(10, 10);
  dispatch("pointerup", 10, 10);
  fireHold(); // timer was cleared on release, so this is a no-op
  assert.deepEqual(h.log, []);
});

test("moving past the slop before the hold completes cancels it — that's a scroll", () => {
  reset();
  const h = tapHarness();
  h.down(10, 10);
  dispatch("pointermove", 60, 80);
  fireHold();
  assert.deepEqual(h.log, []);
});

test("a tiny wobble under the slop radius still allows the hold to fire", () => {
  reset();
  const h = tapHarness();
  h.down(10, 10);
  dispatch("pointermove", 13, 12);
  fireHold();
  assert.equal(h.log.length, 1);
});

test("pointercancel before the hold completes cancels it", () => {
  reset();
  const h = tapHarness();
  h.down(10, 10);
  dispatch("pointercancel", 10, 10);
  fireHold();
  assert.deepEqual(h.log, []);
});

test("a right-click never starts a long-press tap", () => {
  reset();
  let down: Handler = () => {};
  const el = {
    addEventListener: (type: string, fn: Handler) => {
      if (type === "pointerdown") down = fn;
    },
    removeEventListener: () => {},
  } as unknown as HTMLElement;
  const log: unknown[] = [];
  attachLongPressTap(el, { onLongPress: (...args) => log.push(args) });
  down({ button: 2, pointerType: "mouse", pointerId: 1, clientX: 0, clientY: 0, target: "x" });
  fireHold();
  assert.deepEqual(log, []);
});

test("firing the long-press cleans up its listeners, so nothing leaks", () => {
  reset();
  const h = tapHarness();
  h.down(10, 10);
  fireHold();
  assert.equal(docHandlers.get("pointermove")?.size ?? 0, 0);
  assert.equal(docHandlers.get("pointerup")?.size ?? 0, 0);
  assert.equal(docHandlers.get("pointercancel")?.size ?? 0, 0);
});
