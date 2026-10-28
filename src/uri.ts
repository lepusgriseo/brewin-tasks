// Links into the Planner from outside Obsidian — a phone's share sheet, an iOS Shortcut, a launcher:
//   obsidian://brewin-planner?vault=<vault>&add=<words>        a task, read like the capture box
//   obsidian://brewin-planner?vault=<vault>&add=<words>&window the task window, those words in it
//   obsidian://brewin-planner?vault=<vault>&view=<view>        today, week, inbox, calendar, plan…
//   obsidian://brewin-planner?vault=<vault>&edit=<note>        a task's window
//   obsidian://brewin-planner?vault=<vault>&focus=<note>       a task's focus timer
// What a link asks for is worked out here; main.ts carries it out. Pure, no Obsidian imports.

export const URI_ACTION = "brewin-planner";

/** The dashboard's views, then the other windows a link can open. */
export const URI_VIEWS = ["today", "week", "inbox", "attention", "projects", "goals", "review", "all", "birthdays", "calendar", "time", "plan", "shutdown"] as const;
export type UriView = (typeof URI_VIEWS)[number];

export type UriRequest =
  | { kind: "add"; text: string; window: boolean }
  | { kind: "view"; view: UriView }
  | { kind: "edit"; note: string }
  | { kind: "focus"; note: string }
  | { kind: "unknown"; reason: string };

/**
 * What a link's parameters ask for. Obsidian hands over a parameter written without a value
 * (`&window`) as "true". A link with nothing but its vault opens Today.
 */
export function readUri(p: Record<string, string | undefined>): UriRequest {
  const given = (v: string | undefined) => (v === undefined || v === "true" ? "" : v.trim());
  const on = (v: string | undefined) => v !== undefined && !/^(0|false|no)$/i.test(v);
  if (p.add !== undefined) {
    const text = given(p.add);
    // No words: the window, empty — a "new task" button on a home screen.
    return { kind: "add", text, window: !text || on(p.window) };
  }
  if (p.view !== undefined) {
    const view = given(p.view).toLowerCase();
    return (URI_VIEWS as readonly string[]).includes(view)
      ? { kind: "view", view: view as UriView }
      : { kind: "unknown", reason: `there's no view called “${view}” — try ${URI_VIEWS.join(", ")}.` };
  }
  for (const kind of ["edit", "focus"] as const) {
    if (p[kind] === undefined) continue;
    const note = given(p[kind]);
    return note ? { kind, note } : { kind: "unknown", reason: `${kind}= needs a task note's name or path.` };
  }
  const asked = Object.keys(p).filter((k) => k !== "action" && k !== "vault");
  return asked.length ? { kind: "unknown", reason: `this link asks for ${asked.join(", ")} — it understands add, view, edit and focus.` } : { kind: "view", view: "today" };
}
