// Keyboard shortcuts for the dashboard and the calendar: which key does what, in one place. The views
// carry the actions out (each on its own Obsidian Scope, so a key works while that pane is the active
// one, and never while typing), and the "?" window lists them. Pure, no Obsidian imports.

export type DashKeyAction =
  | { kind: "move"; by: 1 | -1 }
  | { kind: "row"; act: "tick" | "edit" | "schedule" | "due" | "postpone" | "top" | "delete" }
  | { kind: "new" }
  | { kind: "search" }
  | { kind: "view"; index: number }
  | { kind: "undo" }
  | { kind: "help" };

export type CalKeyAction =
  | { kind: "today" }
  | { kind: "step"; by: 1 | -1 }
  | { kind: "view"; view: "month" | "week" | "day" }
  | { kind: "new" }
  | { kind: "undo" }
  | { kind: "help" };

export const DASH_KEYS: [string, string][] = [
  ["j  ↓", "next task"],
  ["k  ↑", "previous task"],
  ["x", "tick it"],
  ["e", "open it"],
  ["s", "schedule it"],
  ["d", "give it a deadline"],
  ["p", "postpone it"],
  ["t", "one of today's top 3"],
  ["Delete", "delete it"],
  ["n", "new task"],
  ["/", "search (? there for its filters)"],
  ["1 – 9", "the menu's views, in order"],
  ["Ctrl/⌘ Z", "undo"],
  ["?", "these keys"],
];

export const CAL_KEYS: [string, string][] = [
  ["t", "today"],
  ["←  →", "back, on"],
  ["m  w  d", "month, week (3 days on a phone), day"],
  ["n", "new event"],
  ["Ctrl/⌘ Z", "undo"],
  ["?", "these keys"],
];

/** The keys each view registers on its Scope — exact modifiers, so Obsidian's own hotkeys still work. */
export const DASH_BINDINGS: [("Mod" | "Shift")[], string][] = [
  ...["j", "k", "ArrowDown", "ArrowUp", "x", "e", "s", "d", "p", "t", "Delete", "n", "/", "?", "1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k): [[], string] => [[], k]),
  [["Shift"], "?"],
  [["Mod"], "z"],
];
export const CAL_BINDINGS: [("Mod" | "Shift")[], string][] = [
  ...["t", "ArrowLeft", "ArrowRight", "m", "w", "d", "n", "?"].map((k): [[], string] => [[], k]),
  [["Shift"], "?"],
  [["Mod"], "z"],
];

interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** Keys belong to whatever is being typed into. */
export function isTyping(el: EventTarget | null): boolean {
  const e = el as { tagName?: string; isContentEditable?: boolean } | null;
  return !!e && (!!e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName ?? ""));
}

export function dashKey(e: KeyLike): DashKeyAction | null {
  if (e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return e.key.toLowerCase() === "z" ? { kind: "undo" } : null;
  const row = (act: Extract<DashKeyAction, { kind: "row" }>["act"]): DashKeyAction => ({ kind: "row", act });
  switch (e.key) {
    case "j": case "ArrowDown": return { kind: "move", by: 1 };
    case "k": case "ArrowUp": return { kind: "move", by: -1 };
    case "x": return row("tick");
    case "e": return row("edit");
    case "s": return row("schedule");
    case "d": return row("due");
    case "p": return row("postpone");
    case "t": return row("top");
    case "Delete": return row("delete");
    case "n": return { kind: "new" };
    case "/": return { kind: "search" };
    case "?": return { kind: "help" };
  }
  return /^[1-9]$/.test(e.key) ? { kind: "view", index: Number(e.key) - 1 } : null;
}

export function calKey(e: KeyLike): CalKeyAction | null {
  if (e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return e.key.toLowerCase() === "z" ? { kind: "undo" } : null;
  switch (e.key) {
    case "t": return { kind: "today" };
    case "ArrowLeft": return { kind: "step", by: -1 };
    case "ArrowRight": return { kind: "step", by: 1 };
    case "m": return { kind: "view", view: "month" };
    case "w": return { kind: "view", view: "week" };
    case "d": return { kind: "view", view: "day" };
    case "n": return { kind: "new" };
    case "?": return { kind: "help" };
  }
  return null;
}
