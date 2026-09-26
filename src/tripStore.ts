import { App, normalizePath, TFile, TFolder } from "obsidian";
import { BrewinSettings } from "./settings";
import { todayISO } from "./dates";
import { tripNoteContent, tripNoteFolder, tripNoteName } from "./trip";

export interface NewTripFields {
  destination: string;
  start: string; // ISO
  end: string; // ISO
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const norm = normalizePath(path);
  if (app.vault.getAbstractFileByPath(norm) instanceof TFolder) return;
  if (app.vault.getAbstractFileByPath(norm)) return;
  try {
    await app.vault.createFolder(norm);
  } catch {
    /* ignore */
  }
}

function avoidCollision(app: App, dest: string): string {
  if (!app.vault.getAbstractFileByPath(dest)) return dest;
  const dot = dest.lastIndexOf(".");
  const base = dest.slice(0, dot);
  const ext = dest.slice(dot);
  let n = 2;
  let cand = `${base} ${n}${ext}`;
  while (app.vault.getAbstractFileByPath(cand)) cand = `${base} ${++n}${ext}`;
  return cand;
}

/**
 * Create a new trip note under `settings.tripsFolder`, following the vault's existing
 * "Trips - <year>/<name>/<name>.md" convention (see trip.ts). Returns the created file
 * so the caller (e.g. the event modal's "New trip…" button) can link straight to it.
 */
export async function createTrip(app: App, settings: BrewinSettings, f: NewTripFields): Promise<TFile> {
  const destination = f.destination.trim() || "Trip";
  const start = f.start;
  const end = f.end >= start ? f.end : start;
  const name = tripNoteName(start, end, destination);
  const folder = normalizePath(tripNoteFolder(settings.tripsFolder, start, name));
  await ensureFolder(app, folder);
  const path = avoidCollision(app, normalizePath(`${folder}/${name}.md`));
  const content = tripNoteContent(destination, start, end, todayISO());
  return app.vault.create(path, content);
}
