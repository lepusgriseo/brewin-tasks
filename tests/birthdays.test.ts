import { test } from "node:test";
import assert from "node:assert/strict";
import {
  birthdayDigestBits,
  birthdayIn,
  birthdayLabel,
  birthdayPage,
  birthdaysBetween,
  formatBirthDate,
  nextBirthday,
  parseBirthDate,
  Person,
  personFromNote,
  withDob,
} from "../src/birthdays.ts";

const person = (name: string, raw: string, extra: Partial<Person> = {}): Person => ({
  path: `04_Areas/People/${name}.md`,
  name,
  raw,
  dob: parseBirthDate(raw),
  hidden: false,
  died: false,
  ...extra,
});

// ── Reading dates ────────────────────────────────────────────────────────────

test("reads the ways the people notes actually write a birthday", () => {
  assert.deepEqual(parseBirthDate("1990-03-18"), { month: 3, day: 18, year: 1990 });
  assert.deepEqual(parseBirthDate("22nd November"), { month: 11, day: 22, year: null });
  assert.deepEqual(parseBirthDate("5 Nov 1971"), { month: 11, day: 5, year: 1971 });
  assert.deepEqual(parseBirthDate("November 5th, 1971"), { month: 11, day: 5, year: 1971 });
  assert.deepEqual(parseBirthDate("Sept 9"), { month: 9, day: 9, year: null });
  assert.deepEqual(parseBirthDate("18/03/1990"), { month: 3, day: 18, year: 1990 }); // day first
  assert.deepEqual(parseBirthDate("11-29"), { month: 11, day: 29, year: null }); // month first, as ISO
  assert.deepEqual(parseBirthDate("--11-29"), { month: 11, day: 29, year: null });
});

test("refuses what isn't a date rather than guessing", () => {
  for (const s of ["", "Smith", "31 June", "30 February", "29 February 2023", "13-01", "Ma 5", "1990"]) {
    assert.equal(parseBirthDate(s), null, s);
  }
  assert.deepEqual(parseBirthDate("29 February"), { month: 2, day: 29, year: null }); // no year: could be
});

test("writes a date back with the year when known, as a readable day and month when not", () => {
  assert.equal(formatBirthDate({ month: 11, day: 12, year: 1971 }), "1971-11-12");
  assert.equal(formatBirthDate({ month: 11, day: 5, year: null }), "5 November");
});

// ── When it falls ────────────────────────────────────────────────────────────

test("29 February falls on the 28th outside leap years", () => {
  const leapling = { month: 2, day: 29, year: 2000 };
  assert.equal(birthdayIn(leapling, 2027), "2027-02-28");
  assert.equal(birthdayIn(leapling, 2028), "2028-02-29");
});

test("birthdays in a range span a new year and carry the age turned", () => {
  const got = birthdaysBetween(
    [person("Cleo Ashby", "1994-12-03"), person("Ben Fernsby", "1972-01-20"), person("Pip", "14 June")],
    "2026-12-01",
    "2027-01-31"
  );
  assert.deepEqual(got.map((b) => [b.person.name, b.date, b.age]), [
    ["Cleo Ashby", "2026-12-03", 32],
    ["Ben Fernsby", "2027-01-20", 55],
  ]);
});

test("hidden and dead people are kept off the calendar", () => {
  const got = birthdaysBetween(
    [person("Elon Musk", "1971-06-28", { hidden: true }), person("Edward Bernays", "1891-11-22", { died: true }), person("Pip", "14 June")],
    "2026-01-01",
    "2026-12-31"
  );
  assert.deepEqual(got.map((b) => b.person.name), ["Pip"]);
});

test("the next birthday is today when it is today, and rolls into next year once passed", () => {
  assert.deepEqual(nextBirthday({ month: 10, day: 21, year: 1990 }, "2026-10-21"), { date: "2026-10-21", inDays: 0, age: 36 });
  assert.deepEqual(nextBirthday({ month: 10, day: 20, year: null }, "2026-10-21"), { date: "2027-10-20", inDays: 364, age: null });
});

test("the label carries the age only when it is known", () => {
  assert.equal(birthdayLabel("Ada Fernsby", 55), "Ada Fernsby · 55");
  assert.equal(birthdayLabel("Pip", null), "Pip");
});

// ── Reminders ────────────────────────────────────────────────────────────────

test("the digest names today's birthdays and the ones exactly the warning away", () => {
  const people = [person("Ada Fernsby", "1971-11-12"), person("Gus Fernsby", "8 November"), person("Pip", "14 June")];
  assert.deepEqual(birthdayDigestBits(people, "2026-11-05", 7), ["🎂 Ada Fernsby in 7 days"]);
  assert.deepEqual(birthdayDigestBits(people, "2026-11-12", 7), ["🎂 Ada Fernsby today (55)"]);
  assert.deepEqual(birthdayDigestBits(people, "2026-11-08", 0), ["🎂 Gus Fernsby today"]);
  assert.deepEqual(birthdayDigestBits(people, "2026-11-06", 7), []);
});

// ── The page ─────────────────────────────────────────────────────────────────

test("the page runs the year ahead by month, then the people still missing a date", () => {
  const page = birthdayPage(
    [
      person("Ada Fernsby", "1971-11-12"),
      person("Ben Fernsby", "1972-01-20"),
      person("Pip", "14 June"),
      person("Dan Ashby", ""),
      person("Typo", "Smith"),
      person("Elon Musk", "1971-06-28", { hidden: true }),
      person("Edward Bernays", "1891-11-22", { died: true }),
    ],
    "2026-10-21"
  );
  assert.deepEqual(page.months.map((m) => [m.label, m.rows.map((r) => r.person.name)]), [
    ["November 2026", ["Ada Fernsby"]],
    ["January 2027", ["Ben Fernsby"]],
    ["June 2027", ["Pip"]],
  ]);
  assert.deepEqual(page.noDate.map((p) => p.name), ["Dan Ashby"]);
  assert.deepEqual(page.unreadable.map((p) => p.name), ["Typo"]);
  assert.deepEqual(page.hidden.map((p) => p.name), ["Elon Musk"]);
  assert.deepEqual(page.died.map((p) => p.name), ["Edward Bernays"]);
});

// ── The note ─────────────────────────────────────────────────────────────────

const NOTE = "---\nup: x\n---\n# Dan\n#### Personal\nFirst:: Dan\nLast:: Ashby\nDOB:: \nLaterality:: \n";

test("reads a people note's fields, and skips notes that aren't people", () => {
  assert.deepEqual(personFromNote("p/Dan.md", "Dan", NOTE.replace("DOB:: ", "DOB:: 5 November")), {
    path: "p/Dan.md", name: "Dan", raw: "5 November", dob: { month: 11, day: 5, year: null }, hidden: false, died: false,
  });
  assert.equal(personFromNote("p/People.md", "People", "# 👥 People\n\nSome hub text"), null);
  const hidden = personFromNote("p/E.md", "E", NOTE.replace("DOB:: ", "DOB:: 1971-06-28\nBirthday:: hidden"));
  assert.equal(hidden?.hidden, true);
  const died = personFromNote("p/B.md", "B", NOTE.replace("DOB:: ", "DOB:: 1891-11-22\nDOD:: 1995-03-09"));
  assert.equal(died?.died, true);
  assert.equal(personFromNote("p/R.md", "R", NOTE)?.raw, "");
});

test("setting a date rewrites the DOB line, or adds one under Last", () => {
  assert.match(withDob(NOTE, "5 November"), /^DOB:: 5 November$/m);
  assert.equal(withDob(NOTE, "5 November").split("\n").length, NOTE.split("\n").length);
  const noLine = NOTE.replace("DOB:: \n", "");
  assert.match(withDob(noLine, "1990-03-18"), /Last:: Ashby\nDOB:: 1990-03-18\n/);
});
