import { test } from "node:test";
import assert from "node:assert/strict";
import { goalsOverview, GoalInfo, GoalProject } from "../src/goals.ts";
import { parseProjectTemplate, projectNoteFromTemplate } from "../src/projectTemplate.ts";

const goal = (p: Partial<GoalInfo>): GoalInfo => ({ path: "G.md", name: "G", status: "active", area: "", period: "", targetDate: null, completed: null, ...p });
const project = (p: Partial<GoalProject>): GoalProject => ({ path: "P.md", name: "P", status: "active", due: null, goalPath: null, done: 0, total: 0, ...p });

test("goalsOverview: each goal with its live projects and their progress, soonest target first", () => {
  const o = goalsOverview(
    [
      goal({ path: "Career.md", name: "Career", targetDate: "2027-07-31" }),
      goal({ path: "Deposit.md", name: "Deposit", targetDate: "2026-12-31" }),
      goal({ path: "Old.md", name: "Old", status: "done" }),
      goal({ path: "Later.md", name: "Later", status: "someday" }),
    ],
    [
      project({ path: "CCNP.md", name: "CCNP", goalPath: "Career.md", done: 3, total: 10, due: "2027-01-30" }),
      project({ path: "Portfolio.md", name: "Portfolio", goalPath: "Career.md", done: 1, total: 2 }),
      project({ path: "Shed.md", name: "Shed", status: "done", goalPath: "Career.md", done: 5, total: 5 }),
      project({ path: "Spanish.md", name: "Spanish" }),
      project({ path: "Lost.md", name: "Lost", goalPath: "Gone.md" }),
      project({ path: "Wait.md", name: "Wait", status: "waiting" }),
    ],
    "2026-10-28"
  );
  assert.deepEqual(o.open.map((g) => [g.goal.name, g.daysLeft, g.projects.map((p) => p.name), g.done, g.total]), [
    ["Deposit", 64, [], 0, 0],
    ["Career", 276, ["CCNP", "Portfolio"], 4, 12],
  ]);
  assert.deepEqual(o.other.map((g) => g.goal.name), ["Later", "Old"]); // parked before finished
  assert.deepEqual(o.unlinked.map((p) => p.name), ["Lost", "Spanish"]); // active only; a link to nothing counts as none
});

const TEMPLATE = {
  path: "_Template/Planner/Move house.md",
  basename: "Move house template",
  frontmatter: { planner_template: "project", area: "Home", goal: "[[Deposit]]", icon: "home" },
  body: "\n## Tasks\n- [ ] Give notice [offset:: -4w]\n- [ ] Book the van [offset:: -14d] #next\n- [ ] Hand back the keys [offset:: 0]\n- [ ] Tell the bank\n- [x] Not a step any more\n",
};

test("parseProjectTemplate reads a project template and counts its steps", () => {
  const t = parseProjectTemplate(TEMPLATE)!;
  assert.deepEqual([t.name, t.from, t.area, t.goal, t.icon, t.steps, t.offsets], ["Move house", "deadline", "Home", "[[Deposit]]", "home", 4, 3]);
  assert.equal(parseProjectTemplate({ ...TEMPLATE, frontmatter: { planner_template: "task" } }), null);
});

test("projectNoteFromTemplate dates the steps from the deadline and fills the frontmatter", () => {
  const t = parseProjectTemplate(TEMPLATE)!;
  const { text, dated } = projectNoteFromTemplate(t, { deadline: "2026-12-19", today: "2026-10-28", hub: "03_Projects" });
  assert.equal(dated, 3);
  assert.match(text, /^---\nup: "\[\[03_Projects\]\]"\ntags:\n  - project\nstatus: active\nwaiting_on: ""\narea: Home\ngoal: "\[\[Deposit\]\]"\ndue: 2026-12-19\nstarted: 2026-10-28\ncompleted:\n---\n## Tasks\n/);
  assert.match(text, /- \[ \] Give notice \[scheduled:: 2026-11-21\]\n- \[ \] Book the van \[scheduled:: 2026-12-05\] #next\n- \[ \] Hand back the keys \[scheduled:: 2026-12-19\]\n- \[ \] Tell the bank\n/);
  // No deadline: the offsets have nothing to count from and go.
  const bare = projectNoteFromTemplate(t, { deadline: null, today: "2026-10-28", hub: "03_Projects" });
  assert.equal(bare.dated, 0);
  assert.match(bare.text, /due: \n/);
  assert.match(bare.text, /- \[ \] Give notice\n/);
  // From the start: counted on from today.
  const fromStart = projectNoteFromTemplate({ ...t, from: "start" }, { deadline: null, today: "2026-10-28", hub: "03_Projects" });
  assert.match(fromStart.text, /Hand back the keys \[scheduled:: 2026-10-28\]/);
});
