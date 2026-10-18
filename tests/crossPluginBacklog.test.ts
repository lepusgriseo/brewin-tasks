import { test } from "node:test";
import assert from "node:assert/strict";
import { fitnessBacklogFromFrontmatter, habitsBacklogFromFrontmatter } from "../src/crossPluginBacklog.ts";

test("habitsBacklogFromFrontmatter reads a well-formed note", () => {
  assert.deepEqual(habitsBacklogFromFrontmatter({ habits_behind: 3, due_unmet_count: 2, backlog_days: 5 }), {
    dueUnmetCount: 2,
    backlogDays: 5,
    habitsBehind: 3,
  });
});

test("habitsBacklogFromFrontmatter falls back to the old sum when an older Brewin Habits wrote the note", () => {
  assert.deepEqual(habitsBacklogFromFrontmatter({ due_unmet_count: 2, backlog_days: 5 }), {
    dueUnmetCount: 2,
    backlogDays: 5,
    habitsBehind: 7,
  });
});

test("habitsBacklogFromFrontmatter trusts a zero habits_behind rather than falling back", () => {
  assert.equal(habitsBacklogFromFrontmatter({ habits_behind: 0, due_unmet_count: 6, backlog_days: 40 }).habitsBehind, 0);
});

test("habitsBacklogFromFrontmatter defaults missing/malformed fields to zero, never throws", () => {
  assert.deepEqual(habitsBacklogFromFrontmatter({}), { dueUnmetCount: 0, backlogDays: 0, habitsBehind: 0 });
  assert.deepEqual(habitsBacklogFromFrontmatter({ due_unmet_count: "not a number", backlog_days: null, habits_behind: "x" }), {
    dueUnmetCount: 0,
    backlogDays: 0,
    habitsBehind: 0,
  });
});

test("habitsBacklogFromFrontmatter rejects negative values", () => {
  assert.deepEqual(habitsBacklogFromFrontmatter({ due_unmet_count: -3, backlog_days: -1, habits_behind: -2 }), {
    dueUnmetCount: 0,
    backlogDays: 0,
    habitsBehind: 0,
  });
});

test("fitnessBacklogFromFrontmatter reads a well-formed note", () => {
  assert.deepEqual(fitnessBacklogFromFrontmatter({ missed_sessions_count: 4 }), { missedSessionsCount: 4 });
});

test("fitnessBacklogFromFrontmatter defaults a missing/malformed note to zero", () => {
  assert.deepEqual(fitnessBacklogFromFrontmatter({}), { missedSessionsCount: 0 });
  assert.deepEqual(fitnessBacklogFromFrontmatter({ missed_sessions_count: "nope" }), { missedSessionsCount: 0 });
});
