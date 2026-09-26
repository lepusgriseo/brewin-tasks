// Pure markdown section fill — replace the body region under a known heading with fresh
// content, or append the heading + content when it isn't there yet. No Obsidian imports →
// unit-tested.
//
// The weekly-review commands use this to write (and re-write, idempotently) their generated
// block under `### Tasks this week` / `### Habits this week` in the active note without
// disturbing anything else: the frontmatter, the rest of the template, or the user's own
// edits above and below.
//
// Copied byte-identically into brewin-tasks and brewin-habits (same precedent as rrule.ts) —
// deliberately not a shared package.

// Same frontmatter matcher `taskStore.setBody` uses — the leading `---\n … \n---` block.
const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;
// A lone horizontal rule (`---`, `***`, `___`). The weekly-review template delimits its
// sections with these, so they bound a filled section just like the next heading does.
// A table separator line (`| --- |`) starts with `|` and is not matched.
const THEMATIC_BREAK = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/;

/** ATX heading level (1–6), or 0 when the line isn't a heading. */
function headingLevel(line: string): number {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1].length : 0;
}

/**
 * Replace the lines under `heading` — down to the next heading of equal-or-higher level, a
 * horizontal rule, or end of document — with `block`. If `heading` isn't present, append it
 * and `block` at the end. Idempotent: running it again with the same inputs is a no-op.
 * The frontmatter block is never touched.
 *
 * `block` must not itself contain a lone `---`/heading line, or the next run would treat it
 * as a boundary. The weekly-review formatters emit only bullets, bold labels and one table.
 */
export function fillSection(doc: string, heading: string, block: string): string {
  const fm = FRONTMATTER.exec(doc)?.[0] ?? "";
  const body = doc.slice(fm.length);
  const headText = heading.trim();
  const wantLevel = headingLevel(headText) || 6;
  const content = block.trim();

  const lines = body.split("\n");
  const at = lines.findIndex((l) => headingLevel(l) > 0 && l.trim() === headText);

  if (at === -1) {
    const trimmed = body.replace(/\s+$/, "");
    const lead = trimmed ? trimmed + "\n\n" : fm ? "\n" : "";
    return `${fm}${lead}${headText}\n\n${content}\n`;
  }

  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const lvl = headingLevel(lines[i]);
    if ((lvl > 0 && lvl <= wantLevel) || THEMATIC_BREAK.test(lines[i])) {
      end = i;
      break;
    }
  }

  const before = lines.slice(0, at).join("\n").replace(/\s+$/, "");
  const after = lines.slice(end).join("\n").replace(/^\s+/, "");
  const lead = before ? before + "\n\n" : fm ? "\n" : "";
  const tail = after ? "\n\n" + after : "\n";
  return `${fm}${lead}${headText}\n\n${content}${tail}`;
}
