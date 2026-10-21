// Birthdays, from the `DOB::` line in each people note. No Obsidian imports → unit-testable.
//
// A people note is the one place a birthday is written down: the calendar, the reminders and the
// Birthdays page all read it from there. A date with no year ("5 November") is a birthday whose
// age is unknown — still worth a card.

export interface BirthDate {
  month: number; // 1–12
  day: number; // 1–31
  year: number | null;
}

export interface Person {
  path: string;
  name: string;
  /** What the note's `DOB::` line says, as written — "" when it is empty or missing. */
  raw: string;
  /** Null when nothing is written, or when what is written can't be read as a date. */
  dob: BirthDate | null;
  /** `Birthday:: hidden` — someone with a known date you don't celebrate (a public figure). */
  hidden: boolean;
  /** A `DOD::` is recorded. */
  died: boolean;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export const MONTH_NAMES = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1));

/** "nov", "Sept", "november" → 11. Three letters at least, so "ma" can't mean both March and May. */
function monthFromName(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return null;
  const i = MONTHS.findIndex((m) => m.startsWith(w) || (w === "sept" && m === "september"));
  return i < 0 ? null : i + 1;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (month: number, year: number | null) =>
  month === 2 ? (year == null || isLeap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

function valid(month: number, day: number, year: number | null): BirthDate | null {
  if (!(month >= 1 && month <= 12)) return null;
  if (!(day >= 1 && day <= daysIn(month, year))) return null;
  if (year != null && !(year >= 1800 && year <= 2200)) return null;
  return { month, day, year };
}

/**
 * Read a birth date as people actually write one.
 *
 * - `1990-03-18` — ISO, with the year
 * - `5 November`, `5th Nov`, `5 November 1990`, `November 5`, `Nov 5th, 1990`
 * - `18/03/1990` — day first, the British way
 * - `11-29` or `--11-29` — month then day, the ISO order without a year
 *
 * Anything else is null, which the Birthdays page lists as "can't read" rather than guessing.
 */
export function parseBirthDate(raw: string): BirthDate | null {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return valid(+m[2], +m[3], +m[1]);
  m = /^-{0,2}(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return valid(+m[1], +m[2], null);
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
  if (m) return valid(+m[2], +m[1], +m[3]);
  m = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([A-Za-z]+\.?),?(?: (\d{4}))?$/i.exec(s);
  if (m) {
    const month = monthFromName(m[2]);
    return month ? valid(month, +m[1], m[3] ? +m[3] : null) : null;
  }
  m = /^([A-Za-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?,?(?: (\d{4}))?$/i.exec(s);
  if (m) {
    const month = monthFromName(m[1]);
    return month ? valid(month, +m[2], m[3] ? +m[3] : null) : null;
  }
  return null;
}

/** How a birth date is written back: `1990-11-05` with a year, `5 November` without. */
export function formatBirthDate(d: BirthDate): string {
  if (d.year != null) return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  return `${d.day} ${MONTH_NAMES[d.month - 1]}`;
}

/** The day a birthday falls on in a given year. 29 February is kept on 28 February in other years. */
export function birthdayIn(d: BirthDate, year: number): string {
  const day = d.month === 2 && d.day === 29 && !isLeap(year) ? 28 : d.day;
  return `${year}-${String(d.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Someone whose birthday belongs on the calendar and in reminders. */
export function celebrated(p: Person): p is Person & { dob: BirthDate } {
  return !!p.dob && !p.hidden && !p.died;
}

export interface BirthdayOn {
  person: Person;
  date: string;
  /** The age they turn that day, when the birth year is known. */
  age: number | null;
}

/** Every birthday from `fromISO` to `toISO` inclusive, in date order. */
export function birthdaysBetween(people: Person[], fromISO: string, toISO: string): BirthdayOn[] {
  const out: BirthdayOn[] = [];
  const y0 = Number(fromISO.slice(0, 4));
  const y1 = Number(toISO.slice(0, 4));
  for (const p of people) {
    if (!celebrated(p)) continue;
    for (let y = y0; y <= y1; y++) {
      const date = birthdayIn(p.dob, y);
      if (date < fromISO || date > toISO) continue;
      out.push({ person: p, date, age: p.dob.year != null ? y - p.dob.year : null });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.person.name.localeCompare(b.person.name));
}

const dayNumber = (iso: string) => Math.round(Date.parse(iso + "T00:00:00Z") / 86400000);

/** The next birthday on or after today, how many days away it is, and the age turned. */
export function nextBirthday(d: BirthDate, todayISO: string): { date: string; inDays: number; age: number | null } {
  const year = Number(todayISO.slice(0, 4));
  let date = birthdayIn(d, year);
  if (date < todayISO) date = birthdayIn(d, year + 1);
  const y = Number(date.slice(0, 4));
  return { date, inDays: dayNumber(date) - dayNumber(todayISO), age: d.year != null ? y - d.year : null };
}

/** "Ada Fernsby · 55" — the name as the calendar shows it, with the age when known. */
export function birthdayLabel(name: string, age: number | null): string {
  return age != null && age >= 0 ? `${name} · ${age}` : name;
}

/**
 * What the morning digest says about birthdays: today's, and those exactly `aheadDays` away — one
 * advance warning, early enough to get a card. `aheadDays` 0 means on the day only.
 */
export function birthdayDigestBits(people: Person[], todayISO: string, aheadDays: number): string[] {
  const bits: string[] = [];
  for (const p of people) {
    if (!celebrated(p)) continue;
    const next = nextBirthday(p.dob, todayISO);
    if (next.inDays === 0) bits.push(`🎂 ${p.name} today${next.age != null ? ` (${next.age})` : ""}`);
    else if (aheadDays > 0 && next.inDays === aheadDays) bits.push(`🎂 ${p.name} in ${aheadDays} day${aheadDays === 1 ? "" : "s"}`);
  }
  return bits.sort();
}

export interface BirthdayPage {
  /** Everyone celebrated, soonest first, grouped under the month their next birthday falls in. */
  months: { label: string; rows: { person: Person; date: string; inDays: number; age: number | null }[] }[];
  noDate: Person[];
  unreadable: Person[];
  hidden: Person[];
  died: Person[];
}

/** The Birthdays page: the year ahead by month, then the people still missing a usable date. */
export function birthdayPage(people: Person[], todayISO: string): BirthdayPage {
  const upcoming = people
    .filter(celebrated)
    .map((person) => ({ person, ...nextBirthday(person.dob, todayISO) }))
    .sort((a, b) => a.inDays - b.inDays || a.person.name.localeCompare(b.person.name));
  const months: BirthdayPage["months"] = [];
  for (const row of upcoming) {
    const label = `${MONTH_NAMES[Number(row.date.slice(5, 7)) - 1]} ${row.date.slice(0, 4)}`;
    const last = months[months.length - 1];
    if (last?.label === label) last.rows.push(row);
    else months.push({ label, rows: [row] });
  }
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);
  return {
    months,
    noDate: people.filter((p) => !p.raw && !p.died).sort(byName),
    unreadable: people.filter((p) => !!p.raw && !p.dob).sort(byName),
    hidden: people.filter((p) => !!p.dob && p.hidden && !p.died).sort(byName),
    died: people.filter((p) => p.died).sort(byName),
  };
}

/** Read the fields a people note's birthday depends on from its text. */
export function personFromNote(path: string, name: string, text: string): Person | null {
  const field = (key: string) => {
    const m = new RegExp(`^\\s*${key}::[ \\t]*(.*)$`, "mi").exec(text);
    return m ? m[1].trim() : null;
  };
  const dob = field("DOB") ?? field("Born");
  const birthday = field("Birthday");
  const first = field("First");
  // A people note has the contact template's fields; the folder's hub notes don't.
  if (dob == null && first == null && birthday == null) return null;
  const hidden = !!birthday && /^(hidden|hide|no|off|none|false)$/i.test(birthday);
  // `Birthday:: 5 November` is also accepted as the date, when DOB:: is empty.
  const raw = dob || (birthday && !hidden ? birthday : "") || "";
  return { path, name, raw, dob: parseBirthDate(raw), hidden, died: !!field("DOD") };
}

/**
 * Write a date into a people note's `DOB::` line, returning the new text. A note without the line
 * gets one after `Last::` (or `First::`), where the contact template keeps it.
 */
export function withDob(text: string, value: string): string {
  if (/^\s*DOB::.*$/m.test(text)) return text.replace(/^(\s*)DOB::.*$/m, `$1DOB:: ${value}`);
  for (const anchor of ["Last", "First"]) {
    const re = new RegExp(`^(\\s*${anchor}::.*)$`, "m");
    if (re.test(text)) return text.replace(re, `$1\nDOB:: ${value}`);
  }
  return `${text.replace(/\s*$/, "")}\n\nDOB:: ${value}\n`;
}
