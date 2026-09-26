// Shared "Repeat" presets for the task + event modals. The RRULE strings anchor on the
// item's own date (WEEKLY with no BYDAY = the anchor's weekday; MONTHLY = its day-of-month).

export interface RecurPreset {
  label: string;
  value: string; // RRULE, or "" for one-off
}

export const RECUR_PRESETS: RecurPreset[] = [
  { label: "Does not repeat", value: "" },
  { label: "Every day", value: "FREQ=DAILY" },
  { label: "Weekdays (Mon–Fri)", value: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
  { label: "Weekly", value: "FREQ=WEEKLY" },
  { label: "Every 2 weeks", value: "FREQ=WEEKLY;INTERVAL=2" },
  { label: "Monthly", value: "FREQ=MONTHLY" },
  { label: "Yearly", value: "FREQ=YEARLY" },
];
