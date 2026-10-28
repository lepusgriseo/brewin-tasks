// Other calendars, on this device. Each subscription's address and its last good copy are kept in the
// vault's local storage — never in data.json, which syncs: a calendar's secret link stays on the
// devices it was given to. Fetched with requestUrl (no CORS, works on phones) when Obsidian starts,
// every half hour while it's open, and on request; read with ics.ts into read-only calendar items.

import { requestUrl } from "obsidian";
import type BrewinTasksPlugin from "./main";
import { expandIcs, icsCalendarName, IcsEvent, parseIcs } from "./ics";
import type { CalendarItem } from "./types";
import { NEW_CALENDAR_NAME, type IcsCalendar } from "./settings";

export interface IcsStatus {
  /** When the copy shown was fetched (epoch ms), or null when there is none on this device. */
  fetched: number | null;
  events: number;
  error: string | null;
}

/** The device's own clock: events from elsewhere are shown in its time. */
const LOCAL = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export class IcsService {
  private events = new Map<string, IcsEvent[]>();
  private status = new Map<string, IcsStatus>();
  /** Items drawn lately, by path — what a tap on one of Today's rows carries. */
  private drawn = new Map<string, CalendarItem>();

  constructor(private plugin: BrewinTasksPlugin) {}

  private key(id: string, what: "url" | "copy" | "at"): string {
    return `brewin-ics-${what}-${id}`;
  }

  /**
   * The vault's own local storage — Obsidian 1.8.7 and later. Before that the plugin would have
   * failed to load on the missing method, so older apps keep the same things in the device's local
   * storage, under the vault's name.
   */
  private load(key: string): unknown {
    const app = this.plugin.app;
    if (typeof app.loadLocalStorage === "function") return app.loadLocalStorage(key);
    try {
      const v = window.localStorage.getItem(`${app.vault.getName()}-${key}`);
      return v === null ? null : (JSON.parse(v) as unknown);
    } catch {
      return null;
    }
  }

  /** Null takes it out. Throws when storage is full — the caller decides whether that matters. */
  private save(key: string, value: unknown): void {
    const app = this.plugin.app;
    if (typeof app.saveLocalStorage === "function") return app.saveLocalStorage(key, value);
    const k = `${app.vault.getName()}-${key}`;
    if (value == null) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, JSON.stringify(value));
  }

  url(id: string): string {
    const v = this.load(this.key(id, "url"));
    return typeof v === "string" ? v : "";
  }

  setUrl(id: string, url: string): void {
    this.save(this.key(id, "url"), url.trim() || null);
  }

  statusOf(id: string): IcsStatus {
    return this.status.get(id) ?? { fetched: null, events: 0, error: null };
  }

  /** A calendar taken out: its address and copy go from this device too. */
  forget(id: string): void {
    for (const what of ["url", "copy", "at"] as const) this.save(this.key(id, what), null);
    this.events.delete(id);
    this.status.delete(id);
  }

  /** The copies kept from last time, so the calendars show before the first fetch is back (or offline). */
  loadCopies(): void {
    for (const c of this.plugin.settings.icsCalendars) {
      const text = this.load(this.key(c.id, "copy"));
      if (typeof text === "string" && text) this.read(c.id, text, Number(this.load(this.key(c.id, "at"))) || null);
    }
  }

  private read(id: string, text: string, at: number | null): void {
    const events = parseIcs(text);
    this.events.set(id, events);
    this.status.set(id, { fetched: at, events: events.length, error: null });
  }

  /** Fetch every calendar with an address on this device, or just one. A failure keeps the last good copy. */
  async refresh(only?: string): Promise<void> {
    const list = this.plugin.settings.icsCalendars.filter((c) => !only || c.id === only);
    await Promise.all(list.map((c) => this.fetchOne(c)));
    this.plugin.refreshViews();
  }

  private async fetchOne(c: IcsCalendar): Promise<void> {
    const url = this.url(c.id).replace(/^webcal:/i, "https:");
    if (!url) return;
    try {
      const res = await requestUrl({ url, method: "GET", throw: false });
      if (res.status >= 400) throw new Error(`the server answered ${res.status}`);
      const text = res.text;
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("that address isn't a calendar (.ics)");
      const now = Date.now();
      this.read(c.id, text, now);
      // The copy is a convenience: one too big for local storage is simply fetched again next time.
      try {
        this.save(this.key(c.id, "copy"), text);
        this.save(this.key(c.id, "at"), String(now));
      } catch {
        this.save(this.key(c.id, "copy"), null);
      }
      // A calendar still called what it was added as takes the name it gives itself.
      const name = icsCalendarName(text);
      if (name && c.name === NEW_CALENDAR_NAME) {
        c.name = name;
        await this.plugin.saveSettings();
      }
    } catch (e) {
      this.status.set(c.id, { ...this.statusOf(c.id), error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Read-only items between two days from the calendars shown — or only those that count as busy. */
  items(fromISO: string, toISO: string, o: { busyOnly?: boolean } = {}): CalendarItem[] {
    const out: CalendarItem[] = [];
    if (this.drawn.size > 5000) this.drawn.clear();
    for (const c of this.plugin.settings.icsCalendars) {
      if (!c.show || (o.busyOnly && !c.busy)) continue;
      const events = this.events.get(c.id);
      if (!events?.length) continue;
      for (const occ of expandIcs(events, fromISO, toISO, LOCAL)) {
        const it: CalendarItem = {
          kind: "external",
          path: `ics:${c.id}:${occ.uid}:${occ.date}:${occ.start ?? ""}`,
          title: occ.title,
          date: occ.date,
          allDay: occ.allDay,
          start: occ.start,
          end: occ.end,
          done: false,
          category: c.name,
          recurring: occ.recurring,
          location: occ.location || null,
          external: { calendarId: c.id, color: c.color, description: occ.description, unsupported: occ.unsupported },
        };
        this.drawn.set(it.path, it);
        out.push(it);
      }
    }
    return out;
  }

  item(path: string): CalendarItem | undefined {
    return this.drawn.get(path);
  }
}
