# Brewin Planner

An Obsidian plugin that keeps tasks, recurring routines and calendar events as notes, and puts them
on one day / week / month calendar you can drag things around on.

Its plugin id is `brewin-tasks`; it is called Brewin Planner because it grew past tasks.

## What it does

- **Tasks as notes**, one per task, so a task can hold notes, links and its own history instead of
  being a checkbox in somebody else's file. Quick capture parses dates from what you type ("thursday
  9am", "in three weeks").
- **Recurrence by RRULE**, with a builder, presets, and the "this occurrence or all future ones?"
  question asked properly when you edit one.
- **A calendar** in day, week and month layouts, showing tasks, events and project tasks, with drag
  to reschedule and a configurable slot size.
- **A dashboard with a menu.** Today, Week, Inbox, Projects, Attention, Review and All, each with
  what is left in it, sit in a menu down the left beside the list. The menu also holds today's
  progress (and what Brewin Habits and Fitness say is behind), your active projects, your contexts,
  saved filters, and the calendar and time report. Reorder or hide anything in it. On a phone, or in
  a narrow pane, it becomes a drawer behind ☰. Drag a task onto Today, Tomorrow, Next week, Someday,
  Inbox, a project or a context to send it there.
- **Attributes of your own.** "＋ Add attribute…" in any task's window (or Settings → *Attributes*) makes
  a field every task then offers: text, a number (with a unit such as £ or km), a date, a choice from your
  own list, yes/no, or a link to a note. Values are filled in from the task window and saved as a property
  on the task's note under a key fixed when the attribute is made. Each can show as a chip on task rows, has
  its own section in the dashboard menu listing its values (tap to filter; drop a task on a value to set
  it), can group All, and is found by search.
- **A focus timer on every task.** ⏱️ on a task (or its ⋯ menu, its edit window, or the *Focus timer…*
  command) opens its focus window: a clock you start, pause and finish (✓ Done ticks the task), today's,
  this week's and total time against the task's estimate, and every session, each editable — and time
  already worked can be added by hand. Closing the window while the clock runs asks whether to stay;
  leaving never stops it. A small floating timer then stays over the workspace, on any note, with the
  time and the task: tap it to go back, or pause from it. One clock runs at a time. Sessions are saved
  on the task note (`time_log`, `time_spent`; a running clock as `timer_started`, so it survives a
  restart and shows on another device after a sync) and, optionally, as calendar events in their own
  category, so the Calendar shows when you worked and the Time report counts it.
- **Your own statuses.** Settings → *Statuses* adds statuses beyond To do, On hold, Someday and Done
  (*In progress*, *Waiting on someone*, *Blocked*, *Cancelled*, or your own). Each acts as one of the
  built-in four and behaves exactly like it, with its own icon and name on the task row, in the ⋯ menu
  and the edit window, and in the menu's Statuses section (tap to list, drop a task to set). Notes keep
  the built-in value in `status:` and the custom one in `flag:`, so queries on `status:` keep working.
- **Projects, the way Project HQ runs them.** Each project shows its next action (`next:`) and
  deadline (`due:`) under its name. **✓ Done** writes the finished action into the note's log, offers
  to tick the step it came from, and asks what's next, with the note's `#next` steps first. A
  project's page changes its status (active, waiting on something, someday, done) and its deadline.
  The menu marks an active project with no next action and no `#next` step 🚩, the same rule as HQ's
  Stalled list, and lists waiting projects with what they wait on. The Review's week has a projects
  step: each next action, ticked as you copy it into the notebook.
- **Birthdays** from your people notes: the date in a note's `DOB::` line (`1990-03-18`, or
  `5 November` when the year isn't known) puts a 🎂 on the calendar every year, with the age when
  the year is known. The morning digest names today's birthdays and warns a set number of days
  ahead (7 by default). A Birthdays page lists the year ahead by month and everyone still missing a
  date, with a button to set one. `Birthday:: hidden` in a note leaves someone out; a `DOD::` does too.
- **Auto-scheduling.** Given estimates and a working window, it fits today's unscheduled tasks into
  the free slots rather than leaving you to play tetris.
- **Events** as their own notes, archived past a date by a command.
- **Contexts, categories, dependencies and estimates** — a task can wait on another and will stay out
  of the "do now" list until that one is done.
- **Reminders**: lead time, at-start, a grace period, sound, vibration, system notifications, and a
  daily digest at a time you choose.
- **A time report** — where the day actually went, from tracked hours against the blocks.
- **Trips**, planned from a template into their own folder.
- **Cross-plugin backlog.** Overdue and slipped tasks are published to a shared folder that the
  sibling Brewin Habits and Brewin Fitness plugins read, and the dashboard's Attention tab reports
  what they publish back.

## The notes it reads

Tasks and routines are notes tagged `task`, in an items folder and a routines folder; completing one
moves it to a done folder. Events live in a calendar folder with their own archive. Project tasks are
read from the projects folder, so a project note's next actions appear on the same calendar without
being duplicated. A task note joins a project with `project: "[[Project name]]"` in its frontmatter
(set from the task's ⋯ menu, the task form, or by dragging it onto the project in the menu), and the
project's page in the dashboard shows both: its task notes, then the checkbox lines in its note.

Everything is plain frontmatter, which is the point: the same data is queryable with Dataview and
readable with the plugin switched off.

## Views, commands, settings

Three views — dashboard, calendar and time report — on the `checkmark`, `calendar` and `plus-circle`
ribbon icons. The dashboard's menu folds to a rail of icons with « at its foot (or the *Toggle the
dashboard menu* command, which opens the drawer on a phone). **✎ Edit menu** turns on ↑ ↓ and show/hide
for every entry; **Save this view…** keeps the current view, project, context and search under a name. Commands cover quick capture, opening each view, editing and scheduling the active
task, archiving done tasks and past events, rescheduling everything overdue, auto-scheduling today,
searching tasks, creating an event, and inserting a week's task summary into a review note.

For notes, a read-only `api.day("YYYY-MM-DD")` returns what that day holds — the calendar's items
(events with their repeats, training, birthdays, project steps), the weekly review's done / missed / open
verdicts over that one day, and on today's date what is overdue and which projects have stalled. The
vault's day note calls it from dataviewjs. `api.range("YYYY-MM-DD", "YYYY-MM-DD")` gives the same done /
missed / open verdicts over any stretch of days, with its one-off events and birthdays, for the weekly
and monthly review notes. Tasks carrying one of your own statuses include it as `flag`.

Settings are extensive — the seven folders, the hub note, contexts and categories, what the calendar
shows, the working window and slot size for auto-scheduling, layout choices, the whole reminder
system, and the shared backlog folder.

## Installing

Not in the community directory. Install from this repository with
[BRAT](https://github.com/TfTHacker/obsidian42-brat), or copy `main.js`, `manifest.json` and
`styles.css` into `<vault>/.obsidian/plugins/brewin-tasks/` and enable it.

## Building

```bash
npm install
npm run dev      # watch
npm run build    # type-check, then bundle
npm test
```

Dates, RRULE, the task model, buckets, slots, auto-scheduling, dependencies, estimates, calendar
layout and natural-language parsing are pure modules with no Obsidian imports; the stores, views and
modals are not unit-tested.

## Caveats

This is the oldest and largest of the set and it shows: the settings surface is wide and the defaults
match one vault's folder layout. It replaced a pile of Dataview queries, and the migration notes are
not in this repository. No support is promised.

MIT licensed.
