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
- **A board in every view.** Today, Week, Inbox, Attention and All each switch between **≡ List** and
  **▦ Board**, and a board's columns are whichever field you pick: status (your own statuses get columns
  beside the one they stand for), context, priority, project, or one of your attributes (choice, yes/no,
  text or link) — Week can still be by day. Dragging a card into another column changes that field:
  status (Done completes it), context (the one it came from is swapped for the new one), priority,
  project, or the attribute's value. Each view remembers its own layout and columns.
- **Today's ✅ Completed.** Below the day, a collapsible section lists what was finished today — untick a
  one-off to reopen it; a repeating task shows as done with its next date.
- **Attributes of your own.** "＋ Add attribute…" in any task's window (or Settings → *Attributes*) makes
  a field every task then offers: text, a number (with a unit such as £ or km), a date, a choice from your
  own list, yes/no, or a link to a note. Values are filled in from the task window and saved as a property
  on the task's note under a key fixed when the attribute is made. A new attribute is first checked
  against the properties your notes already have: one of the same name is adopted (its spelling kept,
  its kind guessed from Obsidian's type or its values), so existing values show at once. A task's window
  shows only the attributes its note has; "＋ Add attribute…" puts another on it, ✕ takes one off. Each can show as a chip on task rows, has
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

## Your own views with Bases

Task notes are written so that Obsidian's core **Bases** can read them, and edits made in a Base are
finished off by the Planner's rules:

- **Property types.** On first load the Planner gives its properties their Obsidian types where the
  vault has none (dates for `scheduled`, `due`, `completed`…, a number for `estimate`, a list for
  `contexts`), so a Base can compare `due < today()` and the Properties panel shows a date picker. A type
  you set yourself is left alone and reported. The exception is `completed`, which Obsidian sometimes
  guesses as yes/no: the Planner writes a date there, so it is made a date. Your attributes get a type
  when you create them. *Set task property types for Bases* runs this again.
- **No date is empty.** An unset `scheduled` or `due` is written as an empty property, not `""`, so
  Bases reads it as "no date".
- **Edits in a Base follow the rules.** Set `status` to `done` in a table and the Planner adds today's
  `completed`; set it back and `completed` goes. Mark a *repeating* task done and that occurrence is
  ticked and the task moves on to its next date, instead of the whole series staying done. Pick a `flag`
  (one of your own statuses) and its built-in `status` comes with it; move the status from under a flag
  and the flag goes. Only changes are acted on, so an untouched note is never rewritten.
- **A starter Base.** *Create a Base of your tasks* writes `Tasks.base` beside the task folders — Open,
  Today, By status, Cards, Done this week and Time focused — to change or copy. It is never overwritten.
- **The task window from any task note.** *Open task window for this note* (the old *Edit task*), a
  button in the note's header, and *Open task window* / *Focus timer* on the right-click menu of any task
  note — in the file list, a link, or a Base row.

| Property | Type | Holds |
| --- | --- | --- |
| `status` | text | `todo`, `hold`, `someday` or `done` |
| `flag` | text | one of your own statuses (its id); `status` holds the built-in one it acts as |
| `scheduled`, `due`, `endDate` | date | planned day, deadline, last day of a multi-day task |
| `startTime`, `endTime` | text | `HH:mm` |
| `priority` | text | `low`, `normal` or `high` |
| `contexts` | list | `@home`, `@shopping`… |
| `estimate`, `time_spent` | number | minutes |
| `created`, `modified`, `completed` | date | |
| `project`, `parent` | text | a link to the project note / the parent task |
| `depends_on` | list | links to the tasks this one waits on |
| `recurrence` | text | an RRULE (`FREQ=WEEKLY;BYDAY=SU`); with `recurrence_anchor`, `complete_instances`, `recurrence_exdates`, `times`, `on_completion` |
| `remind`, `remind_start` | text, yes/no | reminder lead time, remind at the start |
| `time_log`, `timer_started` | list, date & time | focus sessions, a running clock |
| your attributes | by kind | number, date, yes/no, or text (choice, link and text) |

A repeating task is one note: Bases shows its next occurrence, not every date it repeats on — the
Planner's calendar does that.

## Views, commands, settings

Three views — dashboard, calendar and time report — on the `checkmark`, `calendar` and `plus-circle`
ribbon icons. The dashboard's menu folds to a rail of icons with « at its foot (or the *Toggle the
dashboard menu* command, which opens the drawer on a phone). **✎ Edit menu** turns on ↑ ↓ and show/hide
for every entry; **Save this view…** keeps the current view, project, context and search under a name. Commands cover quick capture, opening each view, editing and scheduling the active
task, archiving done tasks and past events, rescheduling everything overdue, auto-scheduling today,
searching tasks, creating an event, and inserting a week's task summary into a review note. *Open task
window for this note* opens the task window for the task note in front of you.

For notes, a read-only `api.day("YYYY-MM-DD")` returns what that day holds — the calendar's items
(events with their repeats, training, birthdays, project steps), the weekly review's done / missed / open
verdicts over that one day, and on today's date what is overdue and which projects have stalled. The
vault's day note calls it from dataviewjs. `api.range("YYYY-MM-DD", "YYYY-MM-DD")` gives the same done /
missed / open verdicts over any stretch of days, with its one-off events and birthdays, for the weekly
and monthly review notes. Tasks carrying one of your own statuses include it as `flag`.

Settings are extensive — the seven folders, the hub note, contexts and categories, what the calendar
shows, the working window and slot size for auto-scheduling, layout choices, the whole reminder
system, and the shared backlog folder.

## Planning the day

- **Plan my day** (a command, ☀️ in Today, and a button on the morning summary) walks four steps:
  answer what's left over from days gone (today, tomorrow, next week, Someday or done); see the day's
  shape — events, training and the free time they leave against the work planned; bring in tasks from
  the inbox and the next seven days, with an estimate for each; and star the day's **top three**, then
  auto-schedule the rest or place them on the calendar yourself.
- **Shut down** (a command, 🌙 in Today, and an evening notice at the time set under Reminders) shows
  what got done and how the top three went, gives everything still open an answer — tomorrow, Someday
  or leave it — and opens the day note.
- **Top three:** `top: <date>` on a task note. They head Today, carry a ⭐ on their rows (⋯ stars and
  unstars them; a fourth is refused), and the day note and the weekly and monthly reviews count them.
- **Time blocking:** beside the Day, 3-day and Week calendars, a **To plan** panel lists the day's top
  three and what it holds without a time, what's overdue or carried over, this week's bucket and the
  inbox. Drag a row onto the clock and its estimate becomes the block's length; drag a block onto Inbox
  to take its date off. Drag the bottom edge of a task or event to change when it ends (a repeating one
  asks which occurrences). With a mouse, drag down an empty column to mark a span and choose a task or
  an event for it.

## Tasks in your notes

- Checkbox lines in other notes are tasks too:
  - every open box in a **day note** (`YYYY-MM-DD` in the day-notes folder), on that day unless its
    line gives another date;
  - anywhere else, an open box **with a date** — Dataview fields (`[due:: 2026-11-02]`,
    `[scheduled:: …]`) or Tasks emoji (`📅`, `⏳`) — or tagged `#task`.
- They show in Today (planned or due by today), Week, Needs attention (past their date), All (by
  note), the Review page, the calendar and the day note, each saying which note it is in.
- Tick, date, reword or delete one from its row or the window it opens: the change is made on its
  line, in the line's own style, and can be undone.
- Never read this way: task notes (their boxes are checklists), projects (their boxes are steps),
  templates, and the folders listed in Settings → *Tasks in your notes*. A box that is only a link to
  a task note is that task, which is shown already.

## Checklists

- The `- [ ]` lines in a task note's body are its checklist. Its row shows **☑ 2/5**: tap it to tick
  items beneath the row, in place, with Undo.
- In the task window the checklist sits above the notes: tick items, or add one with Enter. The notes
  box stays the one source and is written with Save.

## Capture from anywhere

- **Links** from outside Obsidian — an iOS Shortcut, an Android launcher, a bookmark:
  - `obsidian://brewin-planner?vault=MyVault&add=Call%20the%20bank%20tomorrow%202pm` makes a task,
    reading the words the way the capture box does (dates, times, repeats, `@context`, `!high`,
    `~30m`). Add `&window` to open the task window with them instead; `add` alone opens it empty.
  - `&view=` `today`, `week`, `inbox`, `attention`, `projects`, `review`, `all`, `birthdays`,
    `calendar`, `time`, `plan` or `shutdown`; `&edit=<task note>` opens its window and
    `&focus=<task note>` its focus timer.
  - *iOS Shortcut:* Ask for Input → URL Encode → Open URL
    `obsidian://brewin-planner?vault=MyVault&add=` followed by the encoded text.
  - *Android:* any launcher or automation app that opens a URL; a home-screen shortcut to
    `obsidian://brewin-planner?vault=MyVault&add` is a one-tap new-task button.
- **Editor commands:**
  - *Make this line a Planner task:* the line's words and dates become a task note that links back
    to the note, and the line becomes a link to it (its box dropped: the task note is where it's
    ticked now). One Undo puts both back.
  - *New task linked to this note:* the task window, its notes starting "From [[the note]]"; a
    selected phrase becomes the title.

## Repeats

- **Counted from when it's done:** "every 3 days after done" (or `every! 3 days`) in the capture box,
  or *Counted from → When it's done* in the task window. The next date counts from the day it was
  ticked, however late — stored as `recurrence_from: completion`. The calendar shows only its next
  date, and the reviews never count the dates in between as missed.
- **Skip this time** (⋯ menu, a calendar chip's right-click, the task window): the date is let go —
  not done, not missed — and the task moves on to its next one.
- **Postpone** (⋯ menu, a calendar chip's right-click): tomorrow, this weekend, next week or a picked
  day. A repeating task moves this occurrence only. A deadline stays put; the message says when the
  new day is past it.

## Project templates

- A note in the templates folder with `planner_template: project`, whose steps carry an offset:
  `- [ ] Book the van [offset:: -14d]` (`-4w`, `0`, `+3d`…). Offsets count from the deadline, or from
  the day it starts with `from: start`; `area:` and `goal:` pass to the project.
- *New project from template…* asks for a name and a deadline, then writes the project note (status
  active, started today, the deadline as `due`, the first `#next` step as `next`) with each step
  dated — `[scheduled:: …]` — and opens it. Undo takes it away again.

## Goals

- Goal notes (tagged `#goal`, with `status`, `area`, `period` and `target_date`) live in the goals
  folder (Settings → Goals folder). A project serves one with `goal: [[Goal]]`.
- **🎯 Goals** in the menu: each goal being worked towards — the days left, a progress bar over its
  projects' steps and task notes, and each project's status, progress, deadline and next action —
  then active projects serving no goal, then goals parked or finished. A project's page shows its
  goal as a chip.
- `app.plugins.plugins["brewin-tasks"].api.goals()` gives the same for the review notes.

## Other calendars

- Settings → *Other calendars* → ＋ *Add a calendar*, then paste its secret .ics address (Google:
  *Secret address in iCal format*; Outlook: *Publish a calendar* → ICS; iCloud: *Public calendar*;
  `webcal://` links work too). Its events show read-only beside your own — in the calendar (in its
  colour, with a dashed edge), Today and the day note — in this device's time zone.
- The address stays **on this device**: it's kept in the vault's local storage, never in the
  Planner's synced settings, so give it on each device you want the calendar on. Calendars are
  fetched when Obsidian starts, every half hour while it's open, and with *Refresh other calendars*.
- *Counts as busy* (on by default): its timed events take up time in Today's free time,
  auto-schedule and Plan my day.
- Tap an event for its details and *Copy as a Planner event*. Repeats, exceptions, moved and
  cancelled occurrences are followed; a repeat rule the Planner can't follow (BYSETPOS, BYHOUR…)
  shows its first date and says so. Time zones: any IANA name, and Outlook's common Windows names.

## Project timeline

- Projects → **▬ Timeline**: each active or waiting project as a bar from its `started:` to its
  `due:` (an end without a date fades), its dated steps and task notes as marks, multi-day tasks as
  thin bars, overdue in red, and a line for today. Scroll sideways; the names stay put. A bar's name
  opens the project; a mark opens the step or task.

## Search

- The search box narrows by what a task **is** as well as what it says. Mix them with words:
  `@home due:week bins`.
  - `@home`, `-@work`; `!high`, `!normal`, `!low`
  - `due:` and `sched:` — `today`, `tomorrow`, `week` (the next 7 days), `overdue`, `none`, `any`, a
    date, `<date`, `>date`
  - `is:recurring`, `someday`, `hold`, `done`, `open`, `blocked`, `timed`, `top`, `overdue`
  - `has:estimate`, `time` (focus time logged), `due`, `date`, `project`, `checklist`, `flag`
  - `project:ccnp`, `flag:waiting`, and your own attributes: `energy:high`
  - `-word`, `"a phrase"`, `-"a phrase"`; `-` before any of the above leaves it out
- Type `?` alone for the list. An operator it can't read is said back, not silently dropped; a word
  with a colon it doesn't know ("Re: dentist") is just a word. Saved filters keep their operators.

## Keyboard

- On the dashboard: `j`/`k` or `↓`/`↑` move between tasks; `x` tick, `e` open, `s` schedule, `d`
  deadline, `p` postpone, `t` top 3, `Delete` delete; `n` new task, `/` search, `1`–`9` the menu's
  views, `Ctrl/⌘ Z` undo, `?` the list.
- On the calendar: `t` today, `←`/`→` back and on, `m` `w` `d` month, week (3 days on a phone), day,
  `n` new event, `Ctrl/⌘ Z` undo, `?` the list.
- They work while that view is the active pane, never while typing in a box, and Obsidian's own
  hotkeys (Ctrl+P…) keep working.

## Pomodoro

- Settings → Focus timer → *Pomodoro*: the clock runs in rounds — work (25 minutes), a short break
  (5), and a long one (15) every 4 rounds; all four are settings. A chime and a note at each change;
  the floating timer and the focus window show the round and the time left.
- Only the work is logged: a session paused after 62 minutes logs 25 + 25 + 2. The phase is worked
  out from the running clock, so it survives Obsidian closing and agrees across devices.

## Insights

- The Time report (week, month or year) has three more tabs:
  - **Estimates** — time logged against estimates on tasks finished in the period: the typical
    ratio, the furthest over, by context.
  - **Completion** — what got done, by week and weekday, on time or late against deadlines, by
    context and by project.
  - **Focus** — focus time by day (by week for a year), the streak of days in a row, and the tasks
    with the most.

## Undo

Ticking, dragging, the bulk bar, triage buttons, the ⋯ menu's changes, Project HQ's changes and
deleting all show what they did on a toast with **Undo**; *Undo the last Planner change* is a command
too. One action is one step back — a bulk move or an auto-schedule comes back whole, a deleted note
comes back with its text. Only the properties an action changed are put back, so anything written to
the note since (a sync, a Base, the focus timer) stays; a note whose text has changed since is left as
it is now, and the toast says so. Saving a task's window is not offered back — that's a deliberate act.

## Project steps

A project note's checkbox lines are its steps. They show beside the task notes on the project's page,
in All and on the calendar, dated either way the vault writes it — Dataview fields
(`[scheduled:: 2026-11-02] [due:: 2026-11-06]`) or the Tasks plugin's emoji (`⏳ 📅`). Tapping one opens
its own window: change its words, its dates and whether it is a `#next` step, tick it, open the note at
its line, or take it out. Ticking writes the completion date the same way the line writes its dates
(`[completion:: …]` or `✅ …`). Every change is one atomic edit of that line.

## Keyboard, screen readers and phones

- **Everything clickable is reachable with Tab** and pressed with Enter or Space: task titles, chips,
  folding headings, and every chip, block and bar on the calendar. Checkboxes say what they do
  ("Complete “Buy milk”"), and icon buttons have names.
- **Focus stays put.** The views redraw after every change; the keyboard comes back to the control it
  was on, or the one that took its place (tick a task, and the next row's box has the focus).
- **Menus opened from the keyboard** (⋯, a project's status) open at the button. On a phone the menu
  drawer takes the focus as it opens and gives it back to ☰ as it shuts (Escape shuts it); shut, it is
  out of the tab order.
- **The date picker:** arrow keys move a day or a week, Page Up/Down a month, Home/End to the week's ends.
- **Typing in Japanese, Chinese or Korean:** Enter chooses the word; it doesn't save half a title.
- **On touch screens** the row actions are always shown and sized for a finger, and a long press is a
  drag, never iOS's text selection or Android's context menu.

**Across platforms.** Folder settings are kept the way Obsidian writes paths: a trailing slash,
Windows backslashes or other capitals than the folder on disk are tidied, and decomposed accents (from
macOS) composed. A task's title becomes its note's name, so it loses characters no file system allows,
a leading dot (Obsidian hides such files), a Windows device name (`Con`, `Nul`…) and anything past 150
characters — the note's heading keeps the whole title. Titles, contexts and places that YAML would
misread (`Call: dentist`, `Dinner #2`) are quoted in new notes' frontmatter. Drag and drop works in
pop-out windows on desktop.

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
