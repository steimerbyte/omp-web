"use client";

import { useMemo } from "react";
import { getLocalePlugin } from "@/lib/i18n/registry";
import { translateMessage } from "@/lib/i18n/format";
import type { TranslationParams } from "@/lib/i18n/types";

/**
 * Die Texte des Kalenders — **immer auf Deutsch**.
 *
 * ### Warum der Kalender nicht der Oberflaechensprache folgt
 *
 * Der Kalender ist ein *deutsches* Kalendersystem, und das betrifft mehr als
 * die Oberflaechensprache:
 *
 * - Die Woche beginnt am Montag, die Kalenderwoche ist die ISO-Woche (KW).
 * - Die Feiertage sind die neun bundesweit geltenden deutschen Feiertage. Ihr
 *   Name ist kein übersetzbarer Begriff, sondern der Name eines deutschen
 *   Feiertages: "Tag der Arbeit" heisst in jedem Land "Tag der Arbeit".
 * - Das Datumsformat ist `14.03.2026`, die Wochentagsnamen sind "Montag",
 *   "Dienstag", …, und die Monatsnamen "Januar", "Februar", …
 *
 * Eine Oberflaeche, in der der Kalender "Oktober 2026" und "Tag der Deutschen
 * Einheit" zeigt, aber die Knöpfe "Month" und "Week" beschriftet, ist halb
 * übersetzt. Und eine Oberflaeche, in der der Kalender englische Monatsnamen
 * zeigte, wäre kein deutscher Kalender mehr, sondern ein englischer Kalender
 * mit deutschen Feiertagen — das gibt es nicht.
 *
 * Deshalb liest der Kalender seine Texte aus dem **deutschen** Sprachpaket,
 * unabhaengig davon, in welcher Sprache die restliche Oberflaeche laeuft. Der
 * Kalender ist ein deutsches Kalendersystem; die Oberflaeche darum herum
 * kann Englisch sein.
 *
 * ### Warum die Texte trotzdem im i18n-Katalog stehen
 *
 * Weil dort *alle* Texte stehen. Der Kalender benutzt den Katalog, er
 * benutzt nur ein anderes Sprachpaket daraus. Ein deutscher Text, der
 * direkt in einer Komponente steht, waere an zwei Orten: im Katalog fuer
 * niemanden und in der Komponente fuer alle.
 */
export function useCalendarText(): (key: string, params?: TranslationParams) => string {
  return useMemo(() => {
    const german = getLocalePlugin("de")?.messages ?? {};
    return (key: string, params?: TranslationParams) =>
      translateMessage("de", key, { de: german }, params);
  }, []);
}
