"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type JSX,
} from "react";
import { createPortal } from "react-dom";
import { ModalBackdrop, ModalPanel } from "@/components/motion/Enter";
import type { CalendarEvent } from "@/lib/calendar";
import {
  MAX_ICS_BYTES,
  type CalendarIcsReport,
  type CalendarIcsSkipReason,
} from "@/lib/calendar-ics";
import { useCalendarText } from "./useCalendarText";

/**
 * Der Import einer `.ics`-Datei in den Kalender.
 *
 * ### Zwei Schritte, ein Request
 *
 * Die Route kennt ein Feld `apply`. Ohne `apply` wird **nur gelesen** — die
 * Datei wird geparst, und die Antwort sagt, was importiert wuerde. Erst mit
 * `apply: true` schreibt die Route. Das ist hier nicht eine Feinheit der API,
 * sondern die einzige Ruecknahme, die es fuer den Nutzer gibt: ein Import ist
 * nicht rueckgaengig zu machen. Wer 200 Termine importiert und sich dann
 * ueber den Inhalt wundert, hat eine Datei, die er loeschen kann — aber
 * keine, in der er Termine einzeln zurueckbauen muss. Die Vorschau macht den
 * Fehler *vor* dem Schreiben sichtbar, und ohne Vorschau gibt es keinen
 * Import-Knopf.
 *
 * ### Die Groessenpruefung passiert im Browser
 *
 * `MAX_ICS_BYTES` steht in `lib/calendar-ics.ts` — dieselbe Grenze, die der
 * Server nennt. Der Browser prueft **vor** dem Request: eine Datei ueber der
 * Grenze wird abgewiesen, ohne dass ein Byte ueber die Leitung geht. Der
 * Server prueft trotzdem noch einmal; die Grenze im Browser ist die
 * Bequemlichkeit, die Grenze im Server die Sicherheit.
 *
 * ### Der Fehler steht im Dialog
 *
 * Die Route antwortet bei einem Fehler mit `{ error: "..." }` — auf
 * **Englisch**, weil die Route sie fuer Entwickler geschrieben hat, nicht
 * fuer Nutzer. Dieser Text wird *nicht* uebersetzt: eine Uebersetzung per
 * String-Matching auf englische Saetze zerbricht, sobald der Server den
 * Satz aendert. Stattdessen nennt der Statuscode die deutsche Ueberschrift
 * ("Die Datei ist kein ICS-Kalender"), und der englische Originaltext steht
 * darunter — als Nachweis, nicht als Erklaerung.
 *
 * Und der Fehler steht **im Dialog**, nicht in einer Leiste dahinter. Ein
 * Fehler hinter einem offenen Dialog ist unsichtbar: der Dialog verdeckt
 * ihn, und der Nutzer haelt die Oberflaeche fuer kaputt, ohne zu wissen,
 * warum. Deshalb traegt der Dialog hier seinen eigenen Fehlerbereich, und
 * `role="alert"` sagt den Screenreadern, dass hier etwas passiert ist.
 */

/** Die Antwort der Import-Route. */
interface ImportResponse {
  /** `true`, wenn geschrieben wurde; `false`, wenn nur gelesen wurde. */
  applied: boolean;
  /** Die Termine, die importiert wurden (oder wuerden). */
  events: CalendarEvent[];
  /** Der Bericht des Parsers. */
  report: CalendarIcsReport;
}

/** Die Fehleranzeige im Dialog: deutsche Ueberschrift, Originaltext. */
interface ImportError {
  /** Was passiert ist — auf Deutsch, nach dem Statuscode gewaehlt. */
  headline: string;
  /** Der englische Originaltext des Servers, falls es einen gibt. */
  detail: string | null;
}

/** Die Phase des Dialogs. */
type ImportPhase = "loading" | "preview" | "applying" | "done";

/**
 * Die deutsche Ueberschrift je Statuscode.
 *
 * Der Statuscode ist die einzige Information, die die Route in ihrer
 * Antwort *maschinenlesbar* mitgibt. Der englische Text ist das nicht: er
 * ist fuer Menschen geschrieben und kann jederzeit umformuliert werden.
 *
 * Der 400er deckt zwei Faelle ab — die leere Datei und die Datei, die gar
 * kein Kalender ist — und bekommt deshalb eine Ueberschrift, die fuer beide
 * gilt. Der genaue Grund steht im englischen Originaltext darunter.
 *
 * Der 415er kommt nicht aus einer Datei, sondern aus der Anfrage selbst: die
 * Route verlangt `application/json`, und genau das schickt die Oberflaeche.
 * Er ist deshalb kein Fehler der Datei, sondern ein Fehler des Wegs — und
 * wird wie ein solcher gemeldet.
 */
const HEADLINE_BY_STATUS: Record<number, string> = {
  400: "calendar.import.errorInvalid",
  403: "calendar.import.errorForbidden",
  413: "calendar.import.errorTooLarge",
  415: "calendar.import.errorFailed",
};

/** Die deutsche Ueberschrift je Grund, warum ein Termin uebersprungen wurde. */
const SKIP_REASON_LABELS: Record<CalendarIcsSkipReason, string> = {
  "no-start-date": "calendar.import.reasonNoStartDate",
  duplicate: "calendar.import.reasonDuplicate",
  "unexpanded-recurrence": "calendar.import.reasonUnexpandedRecurrence",
  "invalid-event": "calendar.import.reasonInvalidEvent",
};

/**
 * Die deutsche Mehrzahl — als Anhang an das Wort.
 *
 * Deutsch haengt das "e" an: ein "Termin", zwei "Termine". Der Anhang ist
 * deshalb ein eigener Platzhalter und nicht im Text versteckt — sonst
 * muesste der Text an beiden Stellen unterschiedlich heissen.
 */
function pluralSuffix(count: number): string {
  return count === 1 ? "" : "e";
}

/**
 * Die deutschen Namen der verworfenen Formate.
 *
 * Die Schluessel kommen aus dem Bericht des Parsers. Ein unbekannter
 * Schluessel wird nicht versteckt, sondern mit seinem Namen gezeigt — eine
 * Luecke in dieser Liste soll auffallen, nicht stillschweigend gehen.
 */
const IGNORED_LABELS: Record<string, string> = {
  alarms: "calendar.import.ignoredAlarms",
  attendees: "calendar.import.ignoredAttendees",
  categories: "calendar.import.ignoredCategories",
  organizers: "calendar.import.ignoredOrganizers",
  urls: "calendar.import.ignoredUrls",
  statuses: "calendar.import.ignoredStatuses",
  transparencies: "calendar.import.ignoredTransparencies",
  timezones: "calendar.import.ignoredTimezones",
  otherComponents: "calendar.import.ignoredOtherComponents",
};

/**
 * Der Import-Knopf fuer die Kalender-Kopfzeile.
 *
 * Die Komponente traegt ihren Text, ihren Zustand und ihre Fehler selbst —
 * sie ist damit unabhaengig benutzbar und haengt in der Kopfzeile, ohne
 * dass die Kopfzeile etwas von ihr wissen muss.
 */
export function CalendarImportButton({
  onImported,
}: {
  /** Wird nach einem erfolgreichen Import gerufen. */
  onImported?: () => void;
}): JSX.Element {
  const t = useCalendarText();

  /** Der Datei-Eingang — der Knopf loest ihn aus. */
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Das Panel des Dialogs (fuer den Fokus). */
  const panelRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<ImportPhase>("loading");
  const [error, setError] = useState<ImportError | null>(null);
  /** Der Bericht der Vorschau. */
  const [preview, setPreview] = useState<CalendarIcsReport | null>(null);
  /** Der Bericht nach dem Schreiben. */
  const [applied, setApplied] = useState<CalendarIcsReport | null>(null);
  /** Der Text der Datei — fuer den zweiten Request noetig. */
  const [ics, setIcs] = useState<string>("");

  /**
   * Die Ueberschrift zu einem Fehlerstatus.
   *
   * `max` wird immer mitgegeben: die Grenze gehoert in die Meldung, und sie
   * kommt aus `MAX_ICS_BYTES` — nicht aus dem Kopf.
   */
  const headlineForStatus = useCallback(
    (status: number): string =>
      t(HEADLINE_BY_STATUS[status] ?? "calendar.import.errorFailed", {
        max: Math.round(MAX_ICS_BYTES / (1024 * 1024)),
      }),
    [t],
  );

  /** Eine Anfrage an die Import-Route. */
  const requestImport = useCallback(
    async (text: string, apply: boolean): Promise<ImportResponse> => {
      const response = await fetch("/api/calendar/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ics: text, apply }),
      });

      let body: (Partial<ImportResponse> & { error?: string }) | null = null;
      try {
        body = (await response.json()) as Partial<ImportResponse> & { error?: string };
      } catch {
        body = null;
      }

      if (!response.ok) {
        throw {
          status: response.status,
          detail: typeof body?.error === "string" ? body.error : null,
        } as { status: number; detail: string | null };
      }

      // Ohne Bericht gibt es nichts anzuzeigen — das ist ein Fehler, auch
      // wenn die Route mit 200 geantwortet hat.
      if (!body?.report) {
        throw { status: 500, detail: null } as { status: number; detail: string | null };
      }

      return {
        applied: body.applied === true,
        events: Array.isArray(body.events) ? body.events : [],
        report: body.report,
      };
    },
    [],
  );

  /**
   * Die Datei wurde gewaehlt: pruefen, lesen, Vorschau laden.
   */
  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Der Wert wird zurueckgesetzt: sonst loest die *gleiche* Datei beim
      // zweiten Mal kein Ereignis mehr aus, und der Nutzer kann sich nicht
      // korrigieren.
      event.target.value = "";
      if (!file) return;

      setOpen(true);
      setError(null);
      setPreview(null);
      setApplied(null);
      setPhase("loading");

      // Die Groessenpruefung im Browser — **vor** dem Request.
      if (file.size > MAX_ICS_BYTES) {
        setError({
          headline: t("calendar.import.errorTooLarge", {
            max: Math.round(MAX_ICS_BYTES / (1024 * 1024)),
          }),
          detail: null,
        });
        setPhase("preview");
        return;
      }

      let text: string;
      try {
        text = await file.text();
      } catch {
        setError({ headline: t("calendar.import.errorFailed"), detail: null });
        setPhase("preview");
        return;
      }
      setIcs(text);

      try {
        const result = await requestImport(text, false);
        setPreview(result.report);
      } catch (cause) {
        const failure = cause as { status?: number; detail?: string | null };
        setError({
          headline: headlineForStatus(failure.status ?? 500),
          detail: failure.detail ?? null,
        });
      }
      setPhase("preview");
    },
    [headlineForStatus, requestImport, t],
  );

  /**
   * Der Nutzer hat "Importieren" geklickt: jetzt wird geschrieben.
   */
  const handleApply = useCallback(async () => {
    setError(null);
    setPhase("applying");
    try {
      const result = await requestImport(ics, true);
      setApplied(result.report);
      setPhase("done");
      // Die Route loest ueber `notifyCalendarChange` den Kalender-Strom aus,
      // der Browser laedt den Kalender also von selbst nach. `onImported` ist
      // der Rueckfall: er faengt den Fall ab, in dem der Strom nicht kommt.
      onImported?.();
    } catch (cause) {
      const failure = cause as { status?: number; detail?: string | null };
      setError({
        headline: headlineForStatus(failure.status ?? 500),
        detail: failure.detail ?? null,
      });
      setPhase("preview");
    }
  }, [headlineForStatus, ics, onImported, requestImport]);

  /** Der Dialog wird geschlossen — ohne Import. */
  const handleCancel = useCallback(() => {
    setOpen(false);
    setError(null);
    setPreview(null);
    setApplied(null);
    setIcs("");
    setPhase("loading");
  }, []);

  /** Der Fokus wandert in den Dialog, sobald er aufgeht. */
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
  }, [open]);

  /** Escape schliesst den Dialog. */
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") handleCancel();
    },
    [handleCancel],
  );

  const busy = phase === "loading" || phase === "applying";
  /** Die Zahl der Termine, die importiert wuerden (0 heisst: nichts). */
  const previewCount = preview?.imported ?? 0;

  /**
   * Die verworfenen Formate — nur die, die wirklich vorkommen.
   *
   * Eine Liste voller Nullen ist Rauschen: sie sagt dem Nutzer nichts und
   * verdeckt die eine Zahl, die ihn interessiert.
   */
  const ignoredEntries = Object.entries(preview?.ignored ?? {}).filter(
    ([, count]) => typeof count === "number" && count > 0,
  );

  const dialog = open && typeof document !== "undefined"
    ? createPortal(
      <ModalBackdrop
        onClick={busy ? undefined : handleCancel}
        style={{
          position: "fixed",
          inset: 0,
          background: "color-mix(in srgb, var(--bg-panel) 74%, transparent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          zIndex: 1100,
        }}
      >
        <ModalPanel
          ref={panelRef}
          // Der Klick darf nicht zum Backdrop durchsickern: sonst schliesst
          // der Klick auf "Importieren" den Dialog, in dem er steht.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleKeyDown}
          role="dialog"
          aria-modal="true"
          aria-label={t("calendar.import.title")}
          tabIndex={-1}
          style={{
            width: "100%",
            maxWidth: 520,
            maxHeight: "80vh",
            overflowY: "auto",
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 13,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 620, color: "var(--text)" }}>
            {t("calendar.import.title")}
          </h2>

          {/*
            Der Fehlerbereich des Dialogs.

            Er steht hier, im Dialog, und nicht in einer Leiste ausserhalb:
            eine Meldung hinter einem offenen Dialog ist unsichtbar. Die
            deutsche Ueberschrift kommt aus dem Statuscode, der englische
            Originaltext steht als Nachweis darunter.
          */}
          {error ? (
            <div
              role="alert"
              data-calendar-import-error=""
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: "9px 11px",
                borderRadius: 8,
                border: "1px solid var(--danger)",
                background: "color-mix(in srgb, var(--danger) 10%, transparent)",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 550, color: "var(--danger)" }}>
                {error.headline}
              </span>
              {error.detail ? (
                <span style={{ fontSize: 11, color: "var(--text-muted)", wordBreak: "break-word" }}>
                  {error.detail}
                </span>
              ) : null}
            </div>
          ) : null}

          {phase === "loading" ? (
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {t("calendar.import.busyReading")}
            </div>
          ) : null}

          {phase === "applying" ? (
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {t("calendar.import.busyApplying")}
            </div>
          ) : null}

          {preview && phase === "preview" ? (
            <>
              <div style={{ fontSize: 13, color: "var(--text)" }}>
                {previewCount > 0
                  ? t("calendar.import.previewCount", { count: previewCount, countSuffix: pluralSuffix(previewCount) })
                  : t("calendar.import.noEvents")}
              </div>

              {preview.skipped.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 550, color: "var(--text-muted)" }}>
                    {t("calendar.import.skippedTitle", { count: preview.skipped.length, countSuffix: pluralSuffix(preview.skipped.length) })}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                    {preview.skipped.map((entry, index) => (
                      <li key={index} style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 }}>
                        <span style={{ color: "var(--text)" }}>
                          {t(SKIP_REASON_LABELS[entry.reason] ?? "calendar.import.reasonUnknown")}
                        </span>
                        {entry.detail ? ` — ${entry.detail}` : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {preview.warnings.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 550, color: "var(--text-muted)" }}>
                    {t("calendar.import.warningsTitle")}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                    {preview.warnings.map((warning, index) => (
                      <li key={index} style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 }}>
                        {warning}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {preview.unexpandedRecurrences > 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {t("calendar.import.unexpandedCount", { count: preview.unexpandedRecurrences, countSuffix: pluralSuffix(preview.unexpandedRecurrences) })}
                </div>
              ) : null}

              {ignoredEntries.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 550, color: "var(--text-muted)" }}>
                    {t("calendar.import.ignoredTitle")}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
                    {ignoredEntries.map(([key, count]) => (
                      <li key={key} style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {IGNORED_LABELS[key] ? t(IGNORED_LABELS[key]) : key}
                        {`: ${count}`}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}

          {applied && phase === "done" ? (
            <>
              <div style={{ fontSize: 13, color: "var(--text)" }}>
                {applied.imported > 0
                  ? t("calendar.import.doneCount", { count: applied.imported, countSuffix: pluralSuffix(applied.imported) })
                  : t("calendar.import.doneNone")}
              </div>

              {applied.warnings.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 550, color: "var(--text-muted)" }}>
                    {t("calendar.import.warningsTitle")}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                    {applied.warnings.map((warning, index) => (
                      <li key={index} style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 }}>
                        {warning}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {applied.skipped.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 550, color: "var(--text-muted)" }}>
                    {t("calendar.import.skippedTitle", { count: applied.skipped.length, countSuffix: pluralSuffix(applied.skipped.length) })}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                    {applied.skipped.map((entry, index) => (
                      <li key={index} style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 }}>
                        <span style={{ color: "var(--text)" }}>
                          {t(SKIP_REASON_LABELS[entry.reason] ?? "calendar.import.reasonUnknown")}
                        </span>
                        {entry.detail ? ` — ${entry.detail}` : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}

          <div style={{ display: "flex", gap: 9, justifyContent: "flex-end", marginTop: 4 }}>
            {phase === "done" ? (
              <button
                type="button"
                onClick={handleCancel}
                style={{
                  padding: "7px 13px",
                  fontSize: 12,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text-muted)",
                  borderRadius: 7,
                }}
              >
                {t("calendar.import.close")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={busy}
                  style={{
                    padding: "7px 13px",
                    fontSize: 12,
                    fontFamily: "inherit",
                    cursor: busy ? "default" : "pointer",
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text-muted)",
                    borderRadius: 7,
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  {t("calendar.import.cancel")}
                </button>
                {/*
                  Der Import-Knopf gibt es nur mit einer Vorschau.

                  Ohne Vorschau (die Datei war zu gross, der Server hat
                  abgelehnt) gibt es nichts, was importiert werden koennte —
                  ein Knopf, der nichts tut, ist eine falsche Zusage. Und ohne
                  Termine in der Vorschau gibt es nichts zu schreiben: der
                  Knopf bleibt dann sichtbar, aber tot, damit der Dialog
                  nicht nach einem Fehler aussieht.
                */}
                {preview ? (
                  <button
                    type="button"
                    onClick={() => { void handleApply(); }}
                    disabled={busy || previewCount === 0}
                    style={{
                      padding: "7px 13px",
                      fontSize: 12,
                      fontWeight: 550,
                      fontFamily: "inherit",
                      cursor: busy || previewCount === 0 ? "not-allowed" : "pointer",
                      border: "1px solid var(--accent)",
                      background: "var(--accent)",
                      color: "var(--bg)",
                      borderRadius: 7,
                      opacity: busy || previewCount === 0 ? 0.6 : 1,
                    }}
                  >
                    {phase === "applying" ? t("calendar.import.busyApplying") : t("calendar.import.apply")}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </ModalPanel>
      </ModalBackdrop>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          fontSize: 12,
          fontWeight: 550,
          borderRadius: 8,
          cursor: "pointer",
          border: "1px solid var(--border)",
          background: "none",
          color: "var(--text-muted)",
          fontFamily: "inherit",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {t("calendar.import.button")}
      </button>

      {/*
        Der Datei-Eingang selbst.

        Er ist versteckt, aber nicht unerreichbar: der Knopf oben ist die
        sichtbare, fokussierbare Alternative und loest ihn aus. Wuerde der
        Eingang nur mit `display: none` versteckt, waere er auch fuer die
        Tastatur weg — und der Weg zur Datei waere dann nur der Knopf.
      */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".ics,text/calendar"
        onChange={(event) => { void handleFileChange(event); }}
        aria-label={t("calendar.import.fileLabel")}
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      />

      {dialog}
    </>
  );
}
