// The checklist in a task note: the `- [ ]` lines of its body. They are the note's own, never tasks of
// their own (noteTasks.ts leaves task notes alone). The row's ☑ chip ticks a line in place; the task
// window works on its notes box, which stays the one source, and writes it with Save. Pure, no
// Obsidian imports.

export interface ChecklistItem {
  /** 0-based line in the text given. */
  line: number;
  text: string;
  done: boolean;
}

/** A list item with a box: indent and marker, the box's mark, then the words. */
const BOX = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\]\s?)(.*)$/;

/** The line after a leading `---` frontmatter block, or 0. */
function bodyStart(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  return end < 0 ? 0 : end + 1;
}

/** The boxes of a note or a note's body, in order — not in its frontmatter or a code block. */
export function checklistItems(text: string): ChecklistItem[] {
  const lines = text.split("\n");
  const out: ChecklistItem[] = [];
  let fence: string | null = null;
  for (let i = bodyStart(lines); i < lines.length; i++) {
    const f = /^\s*(```|~~~)/.exec(lines[i]);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    if (fence !== null || f) continue;
    const m = BOX.exec(lines[i]);
    // Any mark but a space counts as dealt with: x, and the - or > some people use for dropped or moved.
    if (m) out.push({ line: i, text: m[4].trim(), done: m[2] !== " " });
  }
  return out;
}

/** The text with one item ticked or unticked; null when that line no longer holds that item. */
export function setChecklistItem(text: string, item: Pick<ChecklistItem, "line" | "text">, done: boolean): string | null {
  const lines = text.split("\n");
  const m = BOX.exec(lines[item.line] ?? "");
  if (!m || m[4].trim() !== item.text) return null;
  lines[item.line] = m[1] + (done ? "x" : " ") + m[3] + m[4];
  return lines.join("\n");
}

/** The text with a new open item: after the last one (and anything nested under it), else at the end. */
export function addChecklistItem(text: string, words: string): string {
  const w = words.replace(/\s+/g, " ").trim();
  if (!w) return text;
  const items = checklistItems(text);
  if (!items.length) {
    const body = text.replace(/\s+$/, "");
    return (body ? body + "\n\n" : "") + `- [ ] ${w}`;
  }
  const lines = text.split("\n");
  // The first item sets the indent and marker, so an item never lands nested under the last one.
  const first = BOX.exec(lines[items[0].line])!;
  const indent = /^\s*/.exec(first[1])![0];
  const marker = /^\s*([*+])/.exec(first[1])?.[1] ?? "-";
  let at = items[items.length - 1].line + 1;
  while (at < lines.length && lines[at].trim() && /^\s*/.exec(lines[at])![0].length > indent.length) at++;
  lines.splice(at, 0, `${indent}${marker} [ ] ${w}`);
  return lines.join("\n");
}
