import { test } from "node:test";
import assert from "node:assert/strict";
import { yamlString } from "../src/yaml.ts";
import { cleanFolder, matchFolderCase } from "../src/paths.ts";
import { MAX_NAME_CHARS, sanitizeFilename } from "../src/task.ts";
import { completionRefusal } from "../src/status.ts";
import { tripNoteContent } from "../src/trip.ts";

test("yamlString: ordinary text stays bare, so notes look as they always have", () => {
  for (const s of ["Dentist", "Buy milk, eggs", "C# course", "Fix [bug] today", "Week review", "Café au lait 🎉", "e-mail Mum", "50% off?", "v1.2 notes"]) {
    assert.equal(yamlString(s), s, s);
  }
});

test("yamlString: text YAML would misread is quoted, and reads back as the same text", () => {
  const cases = [
    "Call: dentist", // a mapping
    "Dinner #2", // a comment
    "#1 priority", // a comment from the start
    "@home", "[draft] plan", "{x}", "*star", "&anchor", "!tag", "|pipe", ">fold", "%pct", "`code`", "'quoted'", '"quoted"',
    "- list", "? key", ": colon", "ends with:",
    "yes", "No", "true", "null", "~", "123", "1,000", "12:30", "-5", "0x1F", ".inf", "<<", "2026-10-27", "2026-10-27 09:00",
    " leading", "trailing ", "line\nbreak", "tab\there", "back\\slash: x",
  ];
  for (const s of cases) {
    const out = yamlString(s);
    assert.match(out, /^".*"$/s, s);
    assert.equal(JSON.parse(out), s, s);
  }
  assert.equal(yamlString(""), '""');
});

test("yamlString: inside [a, b], the characters that end a flow item are quoted too", () => {
  assert.equal(yamlString("home", { flow: true }), "home");
  assert.equal(yamlString("errands, town", { flow: true }), '"errands, town"');
  assert.equal(yamlString("x]y", { flow: true }), '"x]y"');
  assert.equal(yamlString("50% off?", { flow: true }), '"50% off?"');
  assert.equal(yamlString("errands, town"), "errands, town"); // a block value is fine with a comma
});

test("cleanFolder: slashes, backslashes, spaces and Unicode forms all come out as vault paths", () => {
  assert.equal(cleanFolder("00_Systems/Tasks/Items/"), "00_Systems/Tasks/Items");
  assert.equal(cleanFolder("  /00_Systems//Tasks/Items  "), "00_Systems/Tasks/Items");
  assert.equal(cleanFolder("00_Systems\\Tasks\\Items\\"), "00_Systems/Tasks/Items"); // typed on Windows
  assert.equal(cleanFolder("Tâches"), "Tâches");
  assert.equal(cleanFolder("Tâches"), "Tâches"); // macOS's decomposed accent
  assert.equal(cleanFolder("My Tasks"), "My Tasks");
  assert.equal(cleanFolder("   "), "");
});

test("matchFolderCase: a folder typed with other capitals takes the vault's spelling", () => {
  const folders = ["00_Systems", "00_Systems/Tasks", "00_Systems/Tasks/Items"];
  assert.equal(matchFolderCase("00_systems/tasks/items", folders), "00_Systems/Tasks/Items");
  assert.equal(matchFolderCase("00_Systems/Tasks/Items", folders), "00_Systems/Tasks/Items");
  assert.equal(matchFolderCase("New/Folder", folders), "New/Folder"); // not there yet: kept as typed
});

test("sanitizeFilename: no hidden files, no Windows device names, no names too long to save", () => {
  assert.equal(sanitizeFilename(".net upgrade"), "net upgrade");
  assert.equal(sanitizeFilename("...  later"), "later");
  assert.equal(sanitizeFilename("v1.2 release"), "v1.2 release"); // dots inside are fine
  assert.equal(sanitizeFilename("Con"), "Con_");
  assert.equal(sanitizeFilename("NUL"), "NUL_");
  assert.equal(sanitizeFilename("Buy a con trolley"), "Buy a con trolley");
  assert.equal(sanitizeFilename("tab\there"), "tabhere");
  const long = sanitizeFilename("word ".repeat(60));
  assert.ok([...long].length <= MAX_NAME_CHARS, String(long.length));
  assert.ok(long.endsWith("word"), "cut at a word, not mid-word");
  const emoji = sanitizeFilename("🎉".repeat(200));
  assert.equal([...emoji].length, MAX_NAME_CHARS); // counted in characters, never splitting one
});

test("completionRefusal: says what is actually in the way", () => {
  assert.equal(completionRefusal({ open: 2, blocked: 0 }), "2 subtasks still open");
  assert.equal(completionRefusal({ open: 0, blocked: 1 }), "waiting on 1 other task");
  assert.equal(completionRefusal({ open: 1, blocked: 2 }), "1 subtask still open and waiting on 2 other tasks");
  assert.equal(completionRefusal({ open: 0, blocked: 0 }), "something it depends on isn't done");
});

test("tripNoteContent: a destination YAML would misread is quoted", () => {
  assert.match(tripNoteContent("Lisbon", "2026-11-01", "2026-11-03", "2026-10-27"), /\ndestination: Lisbon\n/);
  assert.match(tripNoteContent("Paris: day trip", "2026-11-01", "2026-11-01", "2026-10-27"), /\ndestination: "Paris: day trip"\n/);
});
