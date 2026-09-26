import { test } from "node:test";
import assert from "node:assert/strict";
import {
  digestSource,
  DigestCounts,
  dueReminders,
  parseRemindField,
  parseRemindStart,
  previewTimes,
  pruneFired,
  relativeLabel,
  reminderId,
  ReminderSource,
} from "../src/reminders.ts";

const TODAY = "2026-07-31";
const src = (p: Partial<ReminderSource> = {}): ReminderSource => ({
  key: "Events/Project Work.md|2026-07-31",
  title: "Project Work",
  subtitle: "20:00–21:00 · Projects",
  path: "Events/Project Work.md",
  atMinutes: 20 * 60, // 20:00
  leadOverride: null,
  atStartOverride: null,
  suppressed: false,
  ...p,
});
const opts = (o: Partial<Parameters<typeof dueReminders>[2]> = {}) => ({
  lead: 10,
  atStart: true,
  grace: 15,
  fired: new Set<string>(),
  todayISO: TODAY,
  ...o,
});

// ── the window ───────────────────────────────────────────────────────────────

test("a reminder inside the tick window fires; one still ahead doesn't", () => {
  // 19:50 is the lead for a 20:00 item. Tick covering 19:49→19:50 catches it.
  const hit = dueReminders([src()], { from: 19 * 60 + 49, to: 19 * 60 + 50 }, opts());
  assert.deepEqual(hit.map((d) => d.kind), ["lead"]);

  const early = dueReminders([src()], { from: 19 * 60 + 40, to: 19 * 60 + 45 }, opts());
  assert.deepEqual(early, []);
});

test("a tick that spans several minutes catches everything in between", () => {
  // A throttled timer: last tick 19:45, now 20:00. Both the lead AND the start are due.
  const hits = dueReminders([src()], { from: 19 * 60 + 45, to: 20 * 60 }, opts());
  assert.deepEqual(hits.map((d) => d.kind), ["lead", "start"]);
  assert.deepEqual(hits.map((d) => d.firedFor), [19 * 60 + 50, 20 * 60]);
});

test("the window's lower bound is exclusive, so adjacent ticks never double-fire", () => {
  const at = 19 * 60 + 50;
  const first = dueReminders([src()], { from: at - 1, to: at }, opts());
  assert.equal(first.length, 1);
  // The next tick starts exactly where the last ended; without dedupe this is the danger case.
  const second = dueReminders([src()], { from: at, to: at + 1 }, opts({ fired: new Set([first[0].id]) }));
  assert.deepEqual(second, []);
});

// ── grace ────────────────────────────────────────────────────────────────────

test("a stale reminder is dropped rather than fired hours late", () => {
  // Obsidian opened at 18:00; an 08:00 item must not shout on launch.
  const morning = src({ atMinutes: 8 * 60 });
  const hits = dueReminders([morning], { from: 0, to: 18 * 60 }, opts());
  assert.deepEqual(hits, []);
});

test("a reminder missed by a couple of minutes still fires — that's what grace is for", () => {
  // Launched at 19:52; the 19:50 lead is only 2 minutes stale.
  const hits = dueReminders([src()], { from: 0, to: 19 * 60 + 52 }, opts());
  assert.deepEqual(hits.map((d) => d.kind), ["lead"]);
});

// ── dedupe ───────────────────────────────────────────────────────────────────

test("an already-fired reminder never fires again, even after a restart", () => {
  const id = reminderId(src().key, "lead", TODAY);
  const hits = dueReminders([src()], { from: 19 * 60 + 49, to: 19 * 60 + 50 }, opts({ fired: new Set([id]) }));
  assert.deepEqual(hits, []);
});

test("lead and start are separate ids for the same item", () => {
  const a = reminderId("k", "lead", TODAY);
  const b = reminderId("k", "start", TODAY);
  assert.notEqual(a, b);
  // …and the same reminder tomorrow is a different id again.
  assert.notEqual(reminderId("k", "lead", "2026-08-01"), a);
});

test("pruneFired keeps only today's ids", () => {
  const kept = pruneFired(
    [reminderId("a", "lead", TODAY), reminderId("b", "start", "2026-07-30"), reminderId("c", "lead", TODAY)],
    TODAY
  );
  assert.equal(kept.length, 2);
  assert.ok(kept.every((id) => id.startsWith(TODAY)));
});

// ── per-item overrides ───────────────────────────────────────────────────────

test("`remind: none` suppresses the item entirely", () => {
  const hits = dueReminders([src({ suppressed: true })], { from: 0, to: 20 * 60 }, opts());
  assert.deepEqual(hits, []);
});

test("a per-item lead overrides the global one", () => {
  const early = src({ leadOverride: 30 }); // wants 30 minutes, not the default 10
  assert.equal(dueReminders([early], { from: 19 * 60 + 29, to: 19 * 60 + 30 }, opts()).length, 1);
  // …and the global 19:50 no longer applies to it.
  assert.deepEqual(dueReminders([early], { from: 19 * 60 + 49, to: 19 * 60 + 50 }, opts()), []);
});

test("a zero lead means start-only, with no warning beforehand", () => {
  const hits = dueReminders([src({ leadOverride: 0 })], { from: 0, to: 20 * 60 }, opts());
  assert.deepEqual(hits.map((d) => d.kind), ["start"]);
});

test("atStart off leaves only the warning", () => {
  const hits = dueReminders([src()], { from: 19 * 60 + 45, to: 20 * 60 }, opts({ atStart: false }));
  assert.deepEqual(hits.map((d) => d.kind), ["lead"]);
});

// ── ordering & misc ──────────────────────────────────────────────────────────

test("a burst arrives in fire-time order, interleaved across items", () => {
  const reading = src({ key: "a", title: "Reading", atMinutes: 21 * 60 });      // lead 20:50
  const journal = src({ key: "b", title: "Journal", atMinutes: 21 * 60 + 5 });  // lead 20:55
  // Deliberately passed out of order, and with grace wide enough to hold all four.
  const hits = dueReminders([journal, reading], { from: 20 * 60 + 49, to: 21 * 60 + 5 }, opts({ grace: 20 }));
  assert.deepEqual(hits.map((d) => `${d.source.title}/${d.kind}`), [
    "Reading/lead",   // 20:50
    "Journal/lead",   // 20:55
    "Reading/start",  // 21:00
    "Journal/start",  // 21:05
  ]);
});

test("a wide window still only fires what's within grace — the rest is stale", () => {
  // Caught a wrong assumption of mine: a 90-minute catch-up window does NOT replay the whole
  // evening. Only the last `grace` minutes are worth saying out loud.
  const reading = src({ key: "a", title: "Reading", atMinutes: 21 * 60 });
  const journal = src({ key: "b", title: "Journal", atMinutes: 21 * 60 + 30 });
  const hits = dueReminders([reading, journal], { from: 20 * 60, to: 21 * 60 + 30 }, opts({ grace: 15 }));
  assert.deepEqual(hits.map((d) => `${d.source.title}/${d.kind}`), ["Journal/lead", "Journal/start"]);
});

test("parseRemindField reads the forms a person would type", () => {
  assert.deepEqual(parseRemindField("30m"), { minutes: 30, off: false });
  assert.deepEqual(parseRemindField("30"), { minutes: 30, off: false });
  assert.deepEqual(parseRemindField("1h"), { minutes: 60, off: false });
  assert.deepEqual(parseRemindField("none"), { minutes: null, off: true });
  assert.deepEqual(parseRemindField("off"), { minutes: null, off: true });
  assert.deepEqual(parseRemindField("0"), { minutes: 0, off: false }); // start-only
  assert.deepEqual(parseRemindField(""), { minutes: null, off: false });
  assert.deepEqual(parseRemindField("whenever"), { minutes: null, off: false }); // no opinion
});

const digestCounts = (p: Partial<DigestCounts> = {}): DigestCounts => ({
  dueCount: 0,
  overdueCount: 0,
  habitsBehindCount: 0,
  fitnessMissedCount: 0,
  ...p,
});

test("the digest only exists when there's something to say", () => {
  assert.equal(digestSource(8 * 60, digestCounts()), null);
  const d = digestSource(8 * 60, digestCounts({ dueCount: 3, overdueCount: 1 }))!;
  assert.equal(d.subtitle, "1 overdue · 3 due today");
  assert.equal(d.leadOverride, 0); // fires at its time, never early
});

test("the digest fires on cross-plugin backlog alone, even with tasks clean", () => {
  const d = digestSource(8 * 60, digestCounts({ habitsBehindCount: 2, fitnessMissedCount: 1 }))!;
  assert.ok(d);
  assert.equal(d.subtitle, "2 habits behind · 1 fitness session missed");
});

test("the digest pluralises singular counts correctly", () => {
  const d = digestSource(8 * 60, digestCounts({ habitsBehindCount: 1, fitnessMissedCount: 1 }))!;
  assert.equal(d.subtitle, "1 habit behind · 1 fitness session missed");
});

test("the digest composes all four counts together, in order", () => {
  const d = digestSource(
    8 * 60,
    digestCounts({ overdueCount: 1, dueCount: 2, habitsBehindCount: 3, fitnessMissedCount: 4 })
  )!;
  assert.equal(d.subtitle, "1 overdue · 2 due today · 3 habits behind · 4 fitness sessions missed");
});

test("relativeLabel reads naturally", () => {
  assert.equal(relativeLabel("start", src(), 10), "Starting now");
  assert.equal(relativeLabel("lead", src(), 10), "In 10 minutes");
  assert.equal(relativeLabel("lead", src({ leadOverride: 60 }), 10), "In 1 hour");
  assert.equal(relativeLabel("lead", src({ leadOverride: 120 }), 10), "In 2 hours");
  assert.equal(relativeLabel("digest", src(), 10), "Today");
});

// ── per-item at-start override (v1.37.1) ─────────────────────────────────────

test("an item can turn the at-start reminder on when the global setting is off", () => {
  // leadOverride 0 removes the warning, so this isolates the at-start behaviour —
  // otherwise grace legitimately catches the 19:50 lead too and the test proves nothing.
  const hits = dueReminders(
    [src({ atStartOverride: true, leadOverride: 0 })],
    { from: 19 * 60 + 59, to: 20 * 60 },
    opts({ atStart: false })
  );
  assert.deepEqual(hits.map((d) => d.kind), ["start"]);
});

test("…and off when the global setting is on", () => {
  const hits = dueReminders(
    [src({ atStartOverride: false })],
    { from: 19 * 60 + 45, to: 20 * 60 },
    opts({ atStart: true })
  );
  assert.deepEqual(hits.map((d) => d.kind), ["lead"]); // warning only
});

test("parseRemindStart reads booleans and the words around them", () => {
  assert.equal(parseRemindStart(true), true);
  assert.equal(parseRemindStart("yes"), true);
  assert.equal(parseRemindStart("off"), false);
  assert.equal(parseRemindStart(false), false);
  assert.equal(parseRemindStart(undefined), null); // no opinion → global setting
  assert.equal(parseRemindStart("maybe"), null);
});

test("previewTimes states exactly when an item will fire", () => {
  // 20:00 item, default 10-minute lead, at-start on.
  assert.deepEqual(previewTimes(20 * 60, null, null, false, 10, true), [
    { minutes: 19 * 60 + 50, kind: "lead" },
    { minutes: 20 * 60, kind: "start" },
  ]);
  // A per-item 30-minute lead, no at-start.
  assert.deepEqual(previewTimes(20 * 60, 30, false, false, 10, true), [
    { minutes: 19 * 60 + 30, kind: "lead" },
  ]);
  // Silenced.
  assert.deepEqual(previewTimes(20 * 60, 30, true, true, 10, true), []);
  // A lead that would land before midnight is dropped rather than wrapping to yesterday.
  assert.deepEqual(previewTimes(5, 30, false, false, 10, true), []);
});
