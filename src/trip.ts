// Pure trip-note naming/content logic. No Obsidian imports → unit-testable.
//
// Mirrors the vault's existing hand-written convention under 04_Areas/Leisure/Trips/:
// "<tripsFolder>/Trips - <year>/<start> - <end> <Destination>/<start> - <end> <Destination>.md"

import { sanitizeFilename } from "./task";
import { shiftISO } from "./dates";

/**
 * Trip note name: "YYYY-MM-DD - <end> Destination". `<end>` is just the end day-of-month
 * when the trip stays within one month, else "MM-DD" once it crosses a month boundary —
 * e.g. "2025-09-28 - 10-03 Haarlam" (28 Sept → 3 Oct).
 */
export function tripNoteName(startISO: string, endISO: string, destination: string): string {
  const [sy, sm] = startISO.split("-");
  const [ey, em, ed] = endISO.split("-");
  const endSuffix = sy === ey && sm === em ? ed : `${em}-${ed}`;
  return sanitizeFilename(`${startISO} - ${endSuffix} ${destination}`);
}

/** Vault-relative folder a new trip note belongs in: <tripsFolder>/Trips - <year>/<name> */
export function tripNoteFolder(tripsFolder: string, startISO: string, name: string): string {
  const year = startISO.slice(0, 4);
  return `${tripsFolder}/Trips - ${year}/${name}`;
}

/**
 * Frontmatter + body for a freshly created trip note, matching the structure of
 * `_Template/Plan Trip Template.md` (Trip Details / Accommodation / Transportation /
 * Itinerary-by-day / Activities / Food / Packing List / Pre-Trip Checklist / Notes).
 */
export function tripNoteContent(destination: string, startISO: string, endISO: string, createdISO: string): string {
  const days: string[] = [];
  let d: string | null = startISO;
  while (d && d <= endISO) {
    days.push(`## ${d}`);
    d = shiftISO(d, 1);
  }

  return [
    "---",
    'up: "[[Trips]]"',
    "type: trip",
    "status: planning",
    `created: ${createdISO}`,
    `modified: ${createdISO}`,
    "tags:",
    "  - trip",
    `destination: ${destination}`,
    `start_date: ${startISO}`,
    `end_date: ${endISO}`,
    "budget_estimated: ",
    "budget_actual: ",
    "currency: GBP",
    "aliases: ",
    "related: ",
    "with: ",
    "---",
    "",
    `# ${destination} Trip`,
    "",
    "## Trip Details",
    "- **Dates:** `= this.start_date` → `= this.end_date`",
    "- **Budget:** `= this.budget_estimated` `= this.currency`",
    "",
    "## Accommodation",
    "| Name | Address | Check-in | Check-out | Contact | Confirmation # |",
    "|------|---------|----------|-----------|---------|----------------|",
    "|      |         |          |           |         |                |",
    "",
    "## Transportation",
    "### Outbound",
    "- Flight/train: ",
    "- Departure: ",
    "- Confirmation #: ",
    "",
    "### Return",
    "- ",
    "",
    "### Local transport",
    "- ",
    "",
    "# Itinerary",
    ...days,
    "",
    "# Activities & Sightseeing",
    "- [ ] ",
    "",
    "# Food & Reservations",
    "- ",
    "",
    "# Packing List",
    "- [ ] **Documents:** passport, tickets, insurance, bookings",
    "- [ ] **Clothing:** ",
    "- [ ] **Electronics:** chargers, adapters, power bank",
    "- [ ] **Toiletries:** ",
    "",
    "# Pre-Trip Checklist",
    "- [ ] Book accommodation",
    "- [ ] Book transport",
    "- [ ] Travel insurance",
    "- [ ] Check passport validity / visa",
    "- [ ] Notify bank of travel",
    "- [ ] Download offline maps",
    "",
    "# Notes & Reflections",
    "",
  ].join("\n");
}
