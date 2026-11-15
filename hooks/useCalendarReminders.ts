"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CalendarEvent } from "@/lib/calendar";
import { dueReminders, nextReminderAt, type ReminderEvent } from "@/lib/calendar-reminders";

/**
 * Die Erinnerungen des Kalenders im offenen Tab — als Browser-Notifications.
 *
 * ### Warum hier nur Verdrahtung steht
 *
 * Welche Erinnerung wann faellig ist, rechnet `lib/calendar-reminders.ts`.
 * Dieser Hook beantwortet die drei Fragen, die nur der Browser beantworten
 * kann: Darf ich benachrichtigen (Erlaubnis)? Wann muss ich aufwachen
 * (`setTimeout` auf den naechsten Zeitpunkt)? Und was habe ich schon gezeigt
 * (`localStorage`, damit ein Neuladen nicht doppelt feuert)?
 *
 * ### Warum `setTimeout` und kein Polling
 *
 * Der Zeitpunkt der naechsten Erinnerung steht fest, sobald die Termine da
 * sind. Eine Schleife, die jede Sekunde nachsieht, rechnet dieselbe Antwort
 * sechzigmal pro Minute — und ein Kalender hat an einem ruhigen Tag genau
 * zwei Ereignisse. Nur ein Tab-Wechsel oder ein Fokus kann die Lage
 * aendern, und dafuer gibt es `visibilitychange`.
 *
 * ### Warum die Erlaubnis aus einem Klick kommt
 *
 * `Notification.requestPermission()` ohne Nutzerinteraktion blockt Chrome
 * still weg — der Nutzer sieht eine Anfrage, die er nie angefordert hat,
 * oder gar keine. Der Hook fordert deshalb **nie** von selbst; die
 * Oberflaeche zeigt einen Knopf, und der ruft `requestPermission`.
 *
 * ### Was bei geschlossenem Tab passiert
 *
 * Nichts. Es gibt keinen Service Worker und kein Push: die Benachrichtigung
 * entsteht im Client, also nur, solange der Tab offen ist. Das ist die
 * Grenze dieses Wegs, und sie steht so auch in `docs/calendar.md`.
 */

/** Der Speicher, in dem die schon gefeuerten Schluessel stehen. */
const FIRED_STORAGE_KEY = "omp-calendar-fired";

/**
 * Wie lange ein gefeuerter Schluessel gemerkt wird.
 *
 * Ein Tag reicht: `REMINDER_GRACE_MS` betraegt zehn Minuten, also kann kein
 * Schluessel laenger als zehn Minuten nach seinem Zeitpunkt noch einmal
 * faellig werden. Der Tag ist Luft fuer eine Uhr, die waehrend des Schlafs
 * stehengeblieben ist.
 */
const FIRED_RETENTION_MS = 86_400_000;

/** Das groesste Intervall, das `setTimeout` kennt (2^31 − 1 ms ≈ 24,8 Tage). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Die Erlaubnis des Browsers — oder `unsupported`, wo es keine Notifications gibt. */
export type ReminderPermission = NotificationPermission | "unsupported";

/** Was die Oberflaeche vom Hook braucht. */
export interface CalendarReminderBinding {
  /** Die Erlaubnis; `unsupported` auf Servern und in Browsern ohne Notifications. */
  permission: ReminderPermission;
  /** Fragt die Erlaubnis an — **nur** aus einer Nutzerinteraktion aufrufen. */
  requestPermission: () => void;
  /** `true`, wenn es ueberhaupt eine kuenftige Erinnerung gibt. */
  hasUpcoming: boolean;
}

/** Die Erlaubnis, wie der Browser sie gerade meldet. */
function readPermission(): ReminderPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

/**
 * Die Schluessel, die dieser Browser schon gezeigt hat.
 *
 * Bei jedem Firing frisch gelesen statt im Ref gehalten: zwei Tabs, die
 * denselben Kalender zeigen, sollen sich nicht gegenseitig ergaenzen muessen.
 * Ist der Speicher gesperrt (privater Modus), gibt es eben keinen Verlauf —
 * dann dedupliziert nur noch `tag` der Notification-API.
 */
function readFired(): Set<string> {
  const keys = new Set<string>();
  try {
    const raw = window.localStorage.getItem(FIRED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const entry of parsed) if (typeof entry === "string") keys.add(entry);
    }
  } catch {
    // Kein lesbarer Speicher: als haette der Nutzer noch keine Erinnerung gesehen.
  }
  return keys;
}

/** Schreibt die Schluessel zurueck und vergisst die alten. */
function writeFired(fired: Set<string>, nowMs: number): void {
  const keep: string[] = [];
  for (const key of fired) {
    // Der Zeitpunkt steht hinter dem letzten `@`; ein Tag danach ist der
    // Schluessel wertlos, weil die Erinnerung nicht mehr faellig werden kann.
    if (Number(key.slice(key.lastIndexOf("@") + 1)) > nowMs - FIRED_RETENTION_MS) keep.push(key);
  }
  try {
    window.localStorage.setItem(FIRED_STORAGE_KEY, JSON.stringify(keep));
  } catch {
    // Kein Schreibrecht: die Dedupe gilt dann nur fuer diesen Lauf.
  }
}

/**
 * Die Erinnerungen des Kalenders im Browser.
 *
 * `events` sind die Termine aus `useCalendar`; `null` heisst „noch nicht
 * geladen" und wird wie „keine" behandelt.
 */
export function useCalendarReminders(events: CalendarEvent[] | null): CalendarReminderBinding {
  // Der Server kennt kein `Notification`; die echte Erlaubnis kommt erst nach
  // dem Mount aus dem Browser. Als Startwert `unsupported`, sonst waere die
  // Hydration ein Widerspruch (Server: „keine Erlaubnis", Browser: „granted").
  const [permission, setPermission] = useState<ReminderPermission>("unsupported");

  useEffect(() => {
    const sync = () => setPermission(readPermission());
    sync();
    // Die Erlaubnis kann sich ausserhalb des Tabs aendern (Browsereinstellungen).
    // Beim Zurueckkommen wird sie neu gelesen.
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
  }, []);

  const hasUpcoming = useMemo(
    () => nextReminderAt(events ?? [], Date.now()) !== null,
    [events],
  );

  useEffect(() => {
    // Ohne Erlaubnis gibt es nichts zu tun — und ohne Termine auch nicht.
    if (permission !== "granted" || !events || events.length === 0) return;
    const list: readonly ReminderEvent[] = events;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const arm = (next: number | null) => {
      if (next === null) return;
      // `Math.max(0, …)`: ein Zeitpunkt, der beim Rechnen vorbeigezogen ist,
      // feuert sofort statt in der Vergangenheit zu warten. `MAX_TIMER_MS`
      // ist die Grenze von `setTimeout`; ein Termin in drei Wochen weckt den
      // Tab spaetestens nach 24,8 Tagen und stellt sich neu.
      timer = setTimeout(tick, Math.min(Math.max(next - Date.now(), 0), MAX_TIMER_MS));
    };

    const tick = () => {
      if (stopped) return;
      clearTimeout(timer);
      const now = Date.now();
      const fired = readFired();
      let changed = false;
      for (const reminder of dueReminders(list, now)) {
        if (fired.has(reminder.key)) continue;
        try {
          // `tag` ist derselbe Schluessel: zwei Tabs, die dieselbe Erinnerung
          // zeigen, ersetzen sich in der Mitteilungszentrale statt zu doppeln.
          new window.Notification(reminder.title, { body: reminder.body, tag: reminder.key });
        } catch {
          // Mobiles Chrome verweigert `new Notification` ohne Service Worker.
          // Der Schluessel gilt trotzdem als gefeuert, sonst versuchte es der
          // naechste Tick endlos.
        }
        fired.add(reminder.key);
        changed = true;
      }
      if (changed) writeFired(fired, now);
      arm(nextReminderAt(list, now));
    };

    tick();

    // Ein Hintergrund-Tab bekommt Timer in einer Genauigkeit, die ein Kalender
    // nicht braucht — aber ein Tab, der geschlafen hat, hat womoeglich eine
    // Erinnerung verpasst. Beim Zurueckkommen wird die Uhr neu gestellt.
    const rearm = () => {
      clearTimeout(timer);
      tick();
    };
    document.addEventListener("visibilitychange", rearm);
    window.addEventListener("focus", rearm);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", rearm);
      window.removeEventListener("focus", rearm);
    };
  }, [events, permission]);

  const requestPermission = useCallback(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    void window.Notification.requestPermission().then((result) => setPermission(result));
  }, []);

  return { permission, requestPermission, hasUpcoming };
}
