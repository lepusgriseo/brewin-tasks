// Project templates: a note in the templates folder with `planner_template: project`, whose checkbox
// steps carry an offset — `- [ ] Book the van [offset:: -14d]` — counted back (or on) from the
// deadline, or from the start with `from: start`. "New project from template…" asks for a name and a
// deadline and writes the project note with each of those steps dated. Pure, no Obsidian imports.

import { shiftISO } from "./dates";
import { parseInlineTask } from "./inlineTask";
import { yamlString } from "./yaml";

export interface ProjectTemplate {
  path: string;
  name: string;
  icon: string | null;
  /** What the offsets count from. */
  from: "deadline" | "start";
  area: string;
  /** A link to the goal new projects serve, as written (`[[Goal]]`), or "". */
  goal: string;
  /** The template's body: the new note's body, offsets still in it. */
  body: string;
  /** Its steps, and how many carry an offset. */
  steps: number;
  offsets: number;
}

const OFFSET = /\s*\[offset::\s*([+-]?\d+)\s*([dw])?\s*\]/i;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** A note's frontmatter and body, read as a project template — null when it isn't one. */
export function parseProjectTemplate(note: { path: string; basename: string; frontmatter?: Record<string, unknown> | null; body: string }): ProjectTemplate | null {
  const fm = note.frontmatter ?? {};
  if (str(fm.planner_template).toLowerCase() !== "project") return null;
  const lines = note.body.split("\n").filter((l) => parseInlineTask(l)?.mark === " ");
  return {
    path: note.path,
    name: str(fm.name) || note.basename.replace(/\s*template$/i, "").trim() || note.basename,
    icon: str(fm.icon) || null,
    from: str(fm.from).toLowerCase() === "start" ? "start" : "deadline",
    area: str(fm.area),
    goal: str(fm.goal),
    body: note.body,
    steps: lines.length,
    offsets: lines.filter((l) => OFFSET.test(l)).length,
  };
}

/**
 * The project note a template makes: frontmatter as the user's own project notes have it (status
 * active, started today, the deadline as `due`, the template's area and goal), then the template's
 * body with each offset turned into a do-date — or dropped, when there's no deadline to count from.
 * The template's `#next` steps stay tagged: they are the new project's next actions.
 */
export function projectNoteFromTemplate(t: ProjectTemplate, o: { deadline: string | null; today: string; hub: string }): { text: string; dated: number } {
  const base = t.from === "start" ? o.today : o.deadline;
  let dated = 0;
  const body = t.body
    .split("\n")
    .map((line) => {
      const task = parseInlineTask(line);
      if (!task || task.mark !== " ") return line;
      const m = OFFSET.exec(line);
      if (!m) return line;
      const days = Number(m[1]) * (m[2]?.toLowerCase() === "w" ? 7 : 1);
      const day = base ? shiftISO(base, days) : null;
      if (!day) return line.replace(OFFSET, "");
      dated++;
      return line.replace(OFFSET, ` [scheduled:: ${day}]`);
    })
    .join("\n");
  const fm = [
    "---",
    `up: ${JSON.stringify(`[[${o.hub}]]`)}`,
    "tags:",
    "  - project",
    "status: active",
    'waiting_on: ""',
    `area: ${yamlString(t.area)}`,
    `goal: ${t.goal ? JSON.stringify(t.goal) : '""'}`,
    `due: ${o.deadline ?? ""}`,
    `started: ${o.today}`,
    "completed:",
    "---",
  ];
  return { text: `${fm.join("\n")}\n${body.replace(/^\n+/, "")}`, dated };
}
