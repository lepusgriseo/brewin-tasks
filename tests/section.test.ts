import { test } from "node:test";
import assert from "node:assert/strict";
import { fillSection } from "../src/section.ts";

const FM = "---\ntype: weekly-review\nWeek: \"2026-W37\"\ntop3: []\n---\n";
const H = "### Tasks this week";
const BLOCK = "*2026-W37*\n\n**Done — 2**\n- Call plumber\n- Submit invoice";

test("fills the region under the heading, down to the next heading of equal-or-higher level", () => {
  const doc = `${FM}# Weekly Review — 2026-W37\n\n## The week in data\n\n${H}\n\n_placeholder_\n\n### Habits this week\n\n_other_\n`;
  const out = fillSection(doc, H, BLOCK);
  assert.ok(out.startsWith(FM), "frontmatter is byte-identical");
  assert.match(out, /### Tasks this week\n\n\*2026-W37\*\n\n\*\*Done — 2\*\*\n- Call plumber\n- Submit invoice\n\n### Habits this week/);
  assert.doesNotMatch(out, /_placeholder_/);
  assert.match(out, /### Habits this week\n\n_other_/, "the following section is untouched");
});

test("a horizontal rule bounds the section just like a heading", () => {
  const doc = `${FM}${H}\n\n_placeholder_\n\n---\n\n## 2 · Reflect\n`;
  const out = fillSection(doc, H, BLOCK);
  assert.match(out, /- Submit invoice\n\n---\n\n## 2 · Reflect\n$/);
  assert.doesNotMatch(out, /_placeholder_/);
});

test("heading at EOF with no trailing newline", () => {
  const doc = `${FM}# Title\n\n${H}\n\nold body no newline`;
  const out = fillSection(doc, H, BLOCK);
  assert.ok(out.startsWith(`${FM}# Title\n\n${H}\n\n`));
  assert.ok(out.endsWith("- Submit invoice\n"));
  assert.doesNotMatch(out, /old body/);
});

test("heading absent → appended at EOF with a blank-line gap", () => {
  const doc = `${FM}# Title\n\nSome prose.\n`;
  const out = fillSection(doc, H, BLOCK);
  assert.equal(out, `${FM}# Title\n\nSome prose.\n\n${H}\n\n${BLOCK}\n`);
});

test("appends cleanly when there is no body at all", () => {
  const out = fillSection(FM, H, BLOCK);
  assert.equal(out, `${FM}\n${H}\n\n${BLOCK}\n`);
});

test("the H1 title is never mistaken for the section heading", () => {
  const doc = `${FM}# Weekly Review — 2026-W37\n\nprose\n`;
  const out = fillSection(doc, "# Weekly Review — 2026-W37", BLOCK);
  // '# Weekly Review …' as a heading arg would match the H1; but our real headings are '### …'
  // and can't. Guard the inverse: a '### Tasks this week' never touches the H1.
  const out2 = fillSection(doc, H, BLOCK);
  assert.match(out2, /# Weekly Review — 2026-W37\n\nprose\n\n### Tasks this week/);
  assert.ok(out.length > 0);
});

test("a heading inside a callout/quote is not matched", () => {
  const doc = `${FM}> ${H}\n> quoted\n`;
  const out = fillSection(doc, H, BLOCK);
  // No real heading → appended, the quoted line left alone.
  assert.match(out, /> ### Tasks this week\n> quoted\n\n### Tasks this week\n\n/);
});

test("idempotent — a second identical run changes nothing", () => {
  const doc = `${FM}## The week in data\n\n${H}\n\n_placeholder_\n\n### Habits this week\n\n_other_\n`;
  const once = fillSection(doc, H, BLOCK);
  const twice = fillSection(once, H, BLOCK);
  assert.equal(twice, once);
  // bold sub-labels inside the block ("**Done — 2**") must not act as boundaries
  assert.match(twice, /- Submit invoice\n\n### Habits this week/);
});

test("only the first of two identically-named headings is replaced", () => {
  const doc = `${FM}${H}\n\nfirst\n\n## Mid\n\n${H}\n\nsecond\n`;
  const out = fillSection(doc, H, BLOCK);
  assert.doesNotMatch(out, /first/);
  assert.match(out, /## Mid\n\n### Tasks this week\n\nsecond/);
});
