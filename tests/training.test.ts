import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTimes, slotTime, TrainingSource, trainingItems } from "../src/training";

// The user's real plan: two sessions Mon–Thu, one Fri/Sat, rest Sunday.
const PLAN: Record<number, string[] | "rest"> = {
  1: ["AM PT Test", "PM Strength — Lower A (Squat)"],
  2: ["AM Smoke Session", "PM Strength — Press"],
  5: ["AM Murph (Scaled)"],
  0: "rest",
};
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const logged: Record<string, { path: string; status: string }> = {
  "2026-10-12|AM PT Test": { path: "Sessions/2026-10-12 AM PT Test.md", status: "complete" },
  "2026-10-13|AM Smoke Session": { path: "Sessions/2026-10-13 AM Smoke Session.md", status: "active" },
};
const src: TrainingSource = {
  slots: (d) => { const v = PLAN[dow(d)]; return Array.isArray(v) ? v : []; },
  isRest: (d) => PLAN[dow(d)] === "rest",
  session: (r, d) => logged[`${d}|${r}`] ?? null,
};

test("times are read from a forgiving list", () => {
  assert.deepEqual(parseTimes("06:15, 20:00"), ["06:15", "20:00"]);
  assert.deepEqual(parseTimes("6:15 20:00"), ["06:15", "20:00"]);
  assert.deepEqual(parseTimes("06:15, later, 25:99"), ["06:15"], "nonsense is dropped, not guessed at");
});

test("extra sessions beyond the configured times are spaced an hour apart", () => {
  assert.equal(slotTime(["06:15", "20:00"], 0), "06:15");
  assert.equal(slotTime(["06:15", "20:00"], 1), "20:00");
  assert.equal(slotTime(["06:15", "20:00"], 2), "21:00");
  assert.equal(slotTime([], 0), null);
});

test("a two-session Monday becomes two timed items, morning first", () => {
  const items = trainingItems(src, "2026-10-12", "2026-10-12", ["06:15", "20:00"], 45);
  assert.deepEqual(items.map((i) => [i.title, i.start, i.end]), [
    ["AM PT Test", "06:15", "07:00"],
    ["PM Strength — Lower A (Squat)", "20:00", "20:45"],
  ]);
  assert.ok(items.every((i) => i.kind === "training" && i.recurring), "never draggable: the plan owns them");
});

test("done means finished in Fitness; started is not done", () => {
  const mon = trainingItems(src, "2026-10-12", "2026-10-12", ["06:15", "20:00"], 45);
  assert.equal(mon[0].done, true);
  assert.equal(mon[0].training?.sessionPath, "Sessions/2026-10-12 AM PT Test.md");
  assert.equal(mon[1].done, false);
  const tue = trainingItems(src, "2026-10-13", "2026-10-13", ["06:15", "20:00"], 45);
  assert.equal(tue[0].done, false, "an unfinished session is not done");
  assert.equal(tue[0].training?.sessionPath, "Sessions/2026-10-13 AM Smoke Session.md", "but it opens where you left off");
});

test("a rest day is an all-day marker; an unscheduled day is nothing", () => {
  const week = trainingItems(src, "2026-10-12", "2026-10-18", ["06:15", "20:00"], 45);
  const sun = week.filter((i) => i.date === "2026-10-18");
  assert.deepEqual(sun.map((i) => [i.title, i.allDay, i.training?.rest]), [["Rest day", true, true]]);
  assert.equal(week.filter((i) => i.date === "2026-10-15").length, 0, "Thursday isn't in this test plan: nothing, not 'rest'");
  assert.equal(week.filter((i) => !i.allDay).length, 5);
});

test("with no times configured, sessions sit in the all-day band rather than vanishing", () => {
  const items = trainingItems(src, "2026-10-16", "2026-10-16", [], 45);
  assert.deepEqual(items.map((i) => [i.title, i.allDay]), [["AM Murph (Scaled)", true]]);
});

test("a Fitness plan's schedule format is read directly", async () => {
  const { planSlots, planIsRest } = await import("../src/training");
  // The real plan's shape: a list on two-session days, a plain value otherwise.
  const schedule = {
    monday: ["AM PT Test", "PM Strength — Lower A (Squat)"],
    friday: "AM Murph (Scaled)",
    saturday: "",
    sunday: "rest",
  };
  assert.deepEqual(planSlots(schedule, "2026-10-12"), ["AM PT Test", "PM Strength — Lower A (Squat)"]);
  assert.deepEqual(planSlots(schedule, "2026-10-16"), ["AM Murph (Scaled)"]);
  assert.deepEqual(planSlots(schedule, "2026-10-17"), [], "unset");
  assert.equal(planIsRest(schedule, "2026-10-18"), true);
  assert.equal(planIsRest(schedule, "2026-10-17"), false, "unset is not rest");
  assert.equal(planIsRest(schedule, "2026-10-12"), false);
});
