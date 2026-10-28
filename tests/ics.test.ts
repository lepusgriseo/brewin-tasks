import { test } from "node:test";
import assert from "node:assert/strict";
import { clockIn, expandIcs, icsCalendarName, instantOf, parseIcs, ruleSupported, zoneName } from "../src/ics.ts";

const ICS = [
  "BEGIN:VCALENDAR",
  "X-WR-CALNAME:Work",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/London",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:standup",
  "DTSTART;TZID=America/New_York:20261022T090000",
  "DTEND;TZID=America/New_York:20261022T093000",
  "RRULE:FREQ=WEEKLY;BYDAY=TH",
  "SUMMARY:Stand-up with\\, the US team",
  "LOCATION:Zoom",
  "BEGIN:VALARM",
  "DESCRIPTION:Reminder text that isn't the event's",
  "END:VALARM",
  "DESCRIPTION:Line one\\nline two — a long one that the calendar fold",
  " ed onto the next line",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup",
  "RECURRENCE-ID;TZID=America/New_York:20261112T090000",
  "DTSTART;TZID=America/New_York:20261113T100000",
  "DTEND;TZID=America/New_York:20261113T103000",
  "SUMMARY:Stand-up (moved)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup",
  "RECURRENCE-ID;TZID=America/New_York:20261119T090000",
  "STATUS:CANCELLED",
  "DTSTART;TZID=America/New_York:20261119T090000",
  "SUMMARY:Stand-up",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:leave",
  "DTSTART;VALUE=DATE:20261030",
  "DTEND;VALUE=DATE:20261102",
  "SUMMARY:Annual leave",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:flight",
  "DTSTART:20261029T061500Z",
  "DURATION:PT1H45M",
  "SUMMARY:Flight",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:gym",
  "DTSTART;TZID=\"GMT Standard Time\":20261026T183000",
  "DTEND;TZID=\"GMT Standard Time\":20261026T193000",
  "RRULE:FREQ=DAILY;COUNT=5",
  "EXDATE;TZID=\"GMT Standard Time\":20261028T183000",
  "SUMMARY:Gym",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:board",
  "DTSTART:20261027T140000Z",
  "DTEND:20261027T150000Z",
  "RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-1",
  "SUMMARY:Board meeting",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("parseIcs reads events: escapes, folded lines, zones, durations — and not a VALARM's lines", () => {
  const evs = parseIcs(ICS);
  assert.equal(evs.length, 7);
  const s = evs[0];
  assert.equal(s.summary, "Stand-up with, the US team");
  assert.equal(s.description, "Line one\nline two — a long one that the calendar folded onto the next line");
  assert.deepEqual(s.start, { date: "2026-10-22", time: "09:00", zone: "America/New_York" });
  assert.deepEqual(evs[3].start, { date: "2026-10-30", time: null, zone: null });
  assert.equal(evs[4].minutes, 105);
  assert.equal(evs[5].start.zone, "Europe/London"); // Outlook's Windows name
  assert.equal(icsCalendarName(ICS), "Work");
});

test("clocks: a wall time in one zone is the right instant, and reads right in another", () => {
  assert.equal(new Date(instantOf("2026-10-22", "09:00", "America/New_York", "UTC")).toISOString(), "2026-10-22T13:00:00.000Z");
  assert.equal(new Date(instantOf("2026-11-05", "09:00", "America/New_York", "UTC")).toISOString(), "2026-11-05T14:00:00.000Z");
  assert.deepEqual(clockIn(Date.UTC(2026, 9, 25, 0, 30), "Europe/London"), { date: "2026-10-25", time: "01:30" });
  assert.equal(zoneName("/mozilla.org/20050126_1/Europe/Paris"), "Europe/Paris");
  assert.equal(zoneName("Somewhere Standard Time"), null);
});

test("expandIcs on a London clock: the week the UK and US clocks disagree, exceptions, moves, cancellations", () => {
  const evs = parseIcs(ICS);
  const got = expandIcs(evs, "2026-10-22", "2026-11-20", "Europe/London")
    .map((o) => `${o.date} ${o.start ?? "all day"}${o.end ? "–" + o.end : ""} ${o.title}${o.unsupported ? " (first only)" : ""}`)
    .sort();
  assert.deepEqual(got, [
    "2026-10-22 14:00–14:30 Stand-up with, the US team",
    "2026-10-26 18:30–19:30 Gym",
    "2026-10-27 14:00–15:00 Board meeting (first only)",
    "2026-10-27 18:30–19:30 Gym",
    "2026-10-29 06:15–08:00 Flight", // 06:15 UTC: the UK has been on GMT since the 25th
    "2026-10-29 13:00–13:30 Stand-up with, the US team", // UK on GMT, US still on EDT
    "2026-10-29 18:30–19:30 Gym",
    "2026-10-30 18:30–19:30 Gym", // the 28th was an exception; COUNT=5 still counts it
    "2026-10-30 all day Annual leave",
    "2026-10-31 all day Annual leave",
    "2026-11-01 all day Annual leave",
    "2026-11-05 14:00–14:30 Stand-up with, the US team",
    "2026-11-13 15:00–15:30 Stand-up (moved)", // the 12th's, moved to Friday 10:00 New York
  ]);
});

test("a long all-day event started before the window still shows inside it", () => {
  const evs = parseIcs(["BEGIN:VEVENT", "UID:x", "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261105", "RRULE:FREQ=MONTHLY", "SUMMARY:Conference", "END:VEVENT"].join("\n"));
  assert.deepEqual(expandIcs(evs, "2026-11-03", "2026-11-03", "Europe/London").map((o) => o.date), ["2026-11-03"]);
});

test("ruleSupported: plain parts yes; BYSETPOS, BYHOUR, hourly no; a yearly rule's own month yes", () => {
  const start = { date: "2026-10-28", time: null, zone: null };
  assert.equal(ruleSupported("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO", start), true);
  assert.equal(ruleSupported("FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=28", start), true);
  assert.equal(ruleSupported("FREQ=YEARLY;BYMONTH=3,10", start), false);
  assert.equal(ruleSupported("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-1", start), false);
  assert.equal(ruleSupported("FREQ=HOURLY", start), false);
});
