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
being duplicated.

Everything is plain frontmatter, which is the point: the same data is queryable with Dataview and
readable with the plugin switched off.

## Views, commands, settings

Three views — dashboard, calendar and time report — on the `checkmark`, `calendar` and `plus-circle`
ribbon icons. Commands cover quick capture, opening each view, editing and scheduling the active
task, archiving done tasks and past events, rescheduling everything overdue, auto-scheduling today,
searching tasks, creating an event, and inserting a week's task summary into a review note.

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
