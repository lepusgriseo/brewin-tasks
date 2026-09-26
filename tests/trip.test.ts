import { test } from "node:test";
import assert from "node:assert/strict";
import { tripNoteName, tripNoteFolder, tripNoteContent } from "../src/trip.ts";

test("tripNoteName: same-month trip suffixes with just the end day", () => {
  assert.equal(tripNoteName("2026-08-31", "2026-08-31", "London"), "2026-08-31 - 31 London");
  assert.equal(tripNoteName("2026-07-15", "2026-07-19", "Mallorca"), "2026-07-15 - 19 Mallorca");
});

test("tripNoteName: cross-month trip suffixes with MM-DD", () => {
  assert.equal(tripNoteName("2026-08-31", "2026-09-24", "London"), "2026-08-31 - 09-24 London");
  assert.equal(tripNoteName("2025-09-28", "2025-10-03", "Haarlam"), "2025-09-28 - 10-03 Haarlam");
});

test("tripNoteName: strips filesystem-unsafe characters from the destination", () => {
  assert.equal(tripNoteName("2026-01-01", "2026-01-05", "Paris: City of Light?"), "2026-01-01 - 05 Paris City of Light");
});

test("tripNoteFolder: buckets by the start year", () => {
  assert.equal(
    tripNoteFolder("04_Areas/Leisure/Trips", "2026-08-31", "2026-08-31 - 09-24 London"),
    "04_Areas/Leisure/Trips/Trips - 2026/2026-08-31 - 09-24 London"
  );
});

test("tripNoteContent: one Itinerary heading per day, inclusive of both ends", () => {
  const body = tripNoteContent("London", "2026-08-31", "2026-09-02", "2026-08-30");
  assert.match(body, /## 2026-08-31/);
  assert.match(body, /## 2026-09-01/);
  assert.match(body, /## 2026-09-02/);
  assert.doesNotMatch(body, /## 2026-09-03/);
});

test("tripNoteContent: single-day trip still gets its one heading", () => {
  const body = tripNoteContent("Day trip", "2026-08-31", "2026-08-31", "2026-08-30");
  const headings = body.match(/^## \d{4}-\d{2}-\d{2}$/gm) ?? [];
  assert.deepEqual(headings, ["## 2026-08-31"]);
});

test("tripNoteContent: frontmatter carries destination and date range", () => {
  const body = tripNoteContent("London", "2026-08-31", "2026-09-24", "2026-08-30");
  assert.match(body, /destination: London/);
  assert.match(body, /start_date: 2026-08-31/);
  assert.match(body, /end_date: 2026-09-24/);
});

test("tripNoteContent: frontmatter has an empty with: field for the people on the trip", () => {
  const body = tripNoteContent("London", "2026-08-31", "2026-09-24", "2026-08-30");
  const frontmatter = body.split("\n---")[0];
  assert.match(frontmatter, /^with: $/m);
});
