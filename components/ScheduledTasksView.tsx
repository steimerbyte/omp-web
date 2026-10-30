"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useScheduledTasks, type ScheduledTaskView } from "@/hooks/useScheduledTasks";
import { describeSchedule, parseSchedule, SCHEDULE_PRESETS, ScheduleError, type ScheduleDescription } from "@/lib/schedule";
import { MAX_TASK_NAME_LENGTH, MAX_TASK_PROMPT_LENGTH } from "@/lib/scheduled-task-limits";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Die Ansicht der geplanten Aufgaben.
 *
 * ### Was hier bewusst nicht steht
 *
 * Kein Zeitplan-Builder mit Wochenraster und keiner mit Ziehen. Ein Cron-
 * Ausdruck mit fuenf Feldern ist die einzige Form, die der Speicher kennt, und
 * die Voreinstellungen plus ein Feld dafuer sind der ganze Editor. Eine
 * aufwendigere Oberflaeche muesste die Ausdruecke *erzeugen*, die sie spaeter
 * wieder *liest* — und dann gaebe es zwei Wahrheiten ueber denselben Lauf.
 *
 * Die relative Zeit ("in 12 Min.") wird *im Browser* aus dem serverseitigen
 * `nextRun` gerechnet: die absolute Zeit kommt vom Server (dessen Zone gilt),
 * die relative ist eine Anzeige, die ohnehin jede Sekunde anders lautet.
 */

/** Der Zustand des Dialogs: `null` heisst geschlossen. */
type DialogState = { mode: "create" } | { mode: "edit"; task: ScheduledTaskView } | null;

/**
 * Ein Eintrag aus `modelList` — der Liste mit Provider-Angabe.
 *
 * `models` in derselben Antwort ist ein `Record<string, string>`
 * (`"provider:id" → Anzeigename`) und **keine** Liste; wer es als Liste
 * behandelt, bekommt `.map is not a function` beim Rendern. Dieselbe
 * Aufteilung wie in `components/ChatInput.tsx` und
 * `components/ModelRolesPanel.tsx`.
 */
interface ModelsResponse {
  modelList?: { id: string; name: string; provider: string }[];
}

/** Ein Modell, wie die Auswahl im Dialog es braucht. */
interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

/**
 * "in 12 Min." / "vor 3 Std." / "gleich".
 *
 * `null` heisst nicht "unbekannt", sondern "es gibt keinen naechsten Lauf" —
 * und das sagt der Aufrufer anders.
 */
function relativeTime(targetMs: number, nowMs: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const deltaMs = targetMs - nowMs;
  const future = deltaMs >= 0;
  const minutes = Math.round(Math.abs(deltaMs) / 60_000);
  if (minutes < 1) return future ? t("scheduled.timeNow") : t("scheduled.timePastMinutes", { count: 0 });
  if (minutes < 60) return future ? t("scheduled.timeMinutes", { count: minutes }) : t("scheduled.timePastMinutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return future ? t("scheduled.timeHours", { count: hours }) : t("scheduled.timePastHours", { count: hours });
  const days = Math.round(hours / 24);
  return future ? t("scheduled.timeDays", { count: days }) : t("scheduled.timePastDays", { count: days });
}

/**
 * Ein `ScheduleDescription` in der Sprache der Oberflaeche.
 *
 * `lib/schedule.ts` ist sprachlos und liefert nur die Form; die Woerter stehen
 * im Katalog. Die Uhrzeit bleibt `HH:MM` — sie ist eine Zeit, kein Satz, und
 * wird in jeder Sprache gleich gelesen. `weekday` ist `Date#getDay`, also
 * `0` = Sonntag, und wird ueber dieselbe Tabelle benannt wie das Auswahlfeld.
 */
function describeIn(
  description: ScheduleDescription | null,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  if (description === null) return null;
  const clock = (hour: number, minute: number) =>
    `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  switch (description.kind) {
    case "everyMinute": return t("scheduled.describeEveryMinute");
    case "everyMinutes": return t("scheduled.describeEveryMinutes", { count: description.step });
    // Minute 0 heisst "jede Stunde"; jede andere Minute ist eine eigene Zeile,
    // weil "stuendlich" sie nicht nennt.
    case "hourly": return description.minute === 0
      ? t("scheduled.describeHourly")
      : t("scheduled.describeHourlyAtMinute", { count: description.minute });
    case "daily": return t("scheduled.describeDaily", { time: clock(description.hour, description.minute) });
    case "weekdays": return t("scheduled.describeWeekdays", { time: clock(description.hour, description.minute) });
    case "weekly": return t("scheduled.describeWeekly", {
      weekday: t(WEEKDAY_KEYS[description.weekday]),
      time: clock(description.hour, description.minute),
    });
    case "custom": return description.expression;
  }
}

/** Eine absolute Zeit in der Zone des Browsers — dieselbe Form wie im Kalender. */
function absoluteTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const inputStyle = {
  width: "100%",
  minWidth: 0,
  padding: "6px 8px",
  fontSize: 13,
  fontFamily: "inherit",
  color: "var(--text)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 7,
  boxSizing: "border-box" as const,
};

const labelStyle = {
  display: "block",
  fontSize: 11,
  color: "var(--text-muted)",
  marginBottom: 4,
};

export function ScheduledTasksView({ onOpenSession }: {
  /**
   * Eine Sitzung im normalen Chat oeffnen.
   *
   * Der Link "Sitzung oeffnen" fuehrt in die Ansicht, in der der Lauf
   * tatsaechlich steht — es gibt keinen zweiten Ort, an dem man eine Sitzung
   * ansieht.
   */
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const { tasks, error, reload, create, update, remove } = useScheduledTasks();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * Der Fehler eines Schreibvorgangs in der Sprache der Oberflaeche.
   *
   * `409` und `503` sind keine gewoehnlichen Fehlschläge, sondern Zustaende:
   * die Datei stammt aus einer anderen Schemafassung, oder ein anderer Prozess
   * haelt gerade die Sperre. Fuer beide gibt es einen uebersetzten Satz, weil
   * der Servertext eine Entwicklerzeile ist ("written by another version and
   * this build writes 1") und dem Nutzer nicht sagt, was er tun kann.
   *
   * Alles andere — ein unbekanntes Modell, ein zu langer Prompt — behaelt den
   * Servertext: er nennt das Feld, und `docs/i18n.md` verbietet, ihn ueber
   * seine Formulierung zu uebersetzen. Diese Funktion bildet deshalb den
   * Status ab und sucht nicht im Text.
   */
  const failureText = useCallback((cause: unknown): string => {
    const status = (cause as { status?: number } | null)?.status;
    if (status === 409) return t("scheduled.saveFailedVersion");
    if (status === 503) return t("scheduled.saveFailedLock");
    const detail = cause instanceof Error ? cause.message : String(cause);
    return status === undefined ? t("scheduled.saveFailed") : `${t("scheduled.saveFailed")} ${detail}`;
  }, [t]);

  /**
   * "Jetzt" fuer die relativen Zeiten, jede halbe Minute neu.
   *
   * Ohne diesen Takt stuende "in 1 Min." auch noch eine Stunde spaeter da.
   * Ein Intervall und nicht ein Timer pro Zeile: die Anzeige ist eine
   * Eigenschaft der Ansicht, nicht der einzelnen Aufgabe.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const toggleEnabled = useCallback(async (task: ScheduledTaskView) => {
    setActionError(null);
    try {
      await update(task.id, { enabled: !task.enabled });
    } catch (cause) {
      setActionError(failureText(cause));
    }
  }, [update, failureText]);

  const handleDelete = useCallback(async (task: ScheduledTaskView) => {
    setActionError(null);
    setBusy(true);
    try {
      await remove(task.id);
      setDialog(null);
    } catch (cause) {
      setActionError(failureText(cause));
    } finally {
      setBusy(false);
    }
  }, [remove, failureText]);

  /** Die Aufgabenliste — `null` heisst "noch nicht geladen". */
  const list = tasks;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t("scheduled.title")}</h1>
        <button
          type="button"
          onClick={() => { setActionError(null); setDialog({ mode: "create" }); }}
          style={{
            marginLeft: "auto",
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 550,
            fontFamily: "inherit",
            cursor: "pointer",
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "var(--bg)",
            borderRadius: 7,
          }}
        >
          {t("scheduled.newTask")}
        </button>
      </header>

      {actionError ? (
        <p style={{ margin: 0, padding: "8px 16px", fontSize: 12, color: "var(--danger)" }} role="alert">
          {actionError}
        </p>
      ) : null}

      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 16 }}>
        {error && list === null ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--danger)" }} role="alert">
              {t("scheduled.loadFailed")}
            </p>
            <button
              type="button"
              onClick={() => void reload()}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                fontFamily: "inherit",
                cursor: "pointer",
                border: "1px solid var(--border)",
                background: "none",
                color: "var(--text)",
                borderRadius: 6,
              }}
            >
              {t("scheduled.retry")}
            </button>
          </div>
        ) : list === null ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>{t("scheduled.loading")}</p>
        ) : list.length === 0 ? (
          <>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 550 }}>{t("scheduled.empty")}</p>
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)", maxWidth: "60ch", lineHeight: 1.5 }}>
              {t("scheduled.emptyHint")}
            </p>
          </>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {list.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                nowMs={nowMs}
                onToggle={() => void toggleEnabled(task)}
                onEdit={() => { setActionError(null); setDialog({ mode: "edit", task }); }}
                onOpenSession={onOpenSession}
              />
            ))}
          </ul>
        )}
      </div>

      {dialog ? (
        <TaskDialog
          task={dialog.mode === "edit" ? dialog.task : null}
          busy={busy}
          error={actionError}
          onCancel={() => { setActionError(null); setDialog(null); }}
          onSave={async (input, id) => {
            setActionError(null);
            setBusy(true);
            try {
              if (id === null) await create(input);
              else await update(id, input);
              setDialog(null);
            } catch (cause) {
              setActionError(failureText(cause));
            } finally {
              setBusy(false);
            }
          }}
          onDelete={async (id) => {
            const task = list?.find((entry) => entry.id === id);
            if (task) await handleDelete(task);
          }}
        />
      ) : null}
    </div>
  );
}

/** Eine Zeile der Liste. */
function TaskRow({ task, nowMs, onToggle, onEdit, onOpenSession }: {
  task: ScheduledTaskView;
  nowMs: number;
  onToggle: () => void;
  onEdit: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const nextRun = typeof task.nextRun === "number" ? task.nextRun : null;
  const lastRunMs = task.lastRunAt ? Date.parse(task.lastRunAt) : null;

  return (
    <li
      style={{
        border: "1px solid var(--border)",
        borderRadius: 9,
        padding: "10px 12px",
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{task.name}</span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{describeIn(describeSchedule(task.cron), t)}</span>
        {!task.enabled ? (
          <span
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--text-dim)",
              border: "1px solid var(--border)",
              borderRadius: 999,
              padding: "1px 7px",
            }}
          >
            {t("scheduled.disable")}
          </span>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "var(--text-muted)" }}>
        <span>
          {t("scheduled.nextRun")}:{" "}
          {nextRun === null
            ? t("scheduled.noNextRun")
            : `${relativeTime(nextRun, nowMs, t)} · ${absoluteTime(nextRun)}`}
        </span>
        <span>
          {t("scheduled.lastRun")}:{" "}
          {lastRunMs === null ? t("scheduled.neverRun") : `${relativeTime(lastRunMs, nowMs, t)} · ${absoluteTime(lastRunMs)}`}
          {task.lastRunStatus === "ok"
            ? ` · ${t("scheduled.statusOk")}`
            : task.lastRunStatus === "error"
              ? ` · ${t("scheduled.statusError")}`
              : ""}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          role="switch"
          aria-checked={task.enabled}
          aria-label={`${t("scheduled.enabled")}: ${task.name}`}
          onClick={onToggle}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 9px",
            fontSize: 11,
            fontFamily: "inherit",
            cursor: "pointer",
            border: "1px solid var(--border)",
            background: task.enabled ? "color-mix(in srgb, var(--accent) 18%, transparent)" : "none",
            color: task.enabled ? "var(--text)" : "var(--text-muted)",
            borderRadius: 999,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: task.enabled ? "var(--accent)" : "var(--text-dim)",
            }}
          />
          {task.enabled ? t("scheduled.enabled") : t("scheduled.enable")}
        </button>

        <button
          type="button"
          onClick={onEdit}
          style={{
            padding: "3px 9px",
            fontSize: 11,
            fontFamily: "inherit",
            cursor: "pointer",
            border: "1px solid var(--border)",
            background: "none",
            color: "var(--text-muted)",
            borderRadius: 6,
          }}
        >
          {t("scheduled.edit")}
        </button>

        {task.lastRunSessionId && onOpenSession ? (
          <button
            type="button"
            onClick={() => onOpenSession(task.lastRunSessionId!)}
            style={{
              padding: "3px 9px",
              fontSize: 11,
              fontFamily: "inherit",
              cursor: "pointer",
              border: "1px solid var(--border)",
              background: "none",
              color: "var(--color-blue, var(--accent))",
              borderRadius: 6,
            }}
          >
            {t("scheduled.openLastRun")}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** Die Vorbelegung fuer eine Minute/Stunde/Regel — was ein Preset in Felder schreibt. */
interface EditorValue {
  minute: string;
  hour: string;
  /** `*` (taeglich), `1-5` (werktags) oder ein einzelner Wochentag. */
  weekday: string;
}

/**
 * Zerlegt einen Cron in die drei Felder des Editors — oder `null`.
 *
 * Der Editor kann nur darstellen, was die Presets erzeugen: eine feste Minute,
 * eine feste Stunde und ein Wochentagsfeld. Alles andere (`*` in der Minute,
 * Schritte, Listen im Monat) ist im Rohfeld besser aufgehoben als in einem
 * Formular, das den Ausdruck umschreiben muesste.
 *
 * Das Wochentagsfeld wird **unveraendert** uebernommen, auch `7`: beide
 * Schreibweisen fuer Sonntag stehen in {@link WEEKDAY_VALUES}, damit ein
 * gelesener Ausdruck beim Speichern derselbe bleibt. Ein Editor, der `7` auf
 * `0` normalisiert, aendert einen Zeitplan, den niemand angefasst hat.
 */
function toEditorValue(cron: string): EditorValue | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, weekday] = parts;
  if (dayOfMonth !== "*" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  return { minute, hour, weekday };
}

/** Aus den drei Feldern wieder einen Cron. */
function toCron(value: EditorValue): string {
  return `${value.minute} ${value.hour} * * ${value.weekday}`;
}

/**
 * Die Namen der Wochentage, Index = `Date#getDay` (`0` = Sonntag).
 *
 * Dieselbe Tabelle benennt das Auswahlfeld und die Beschreibung, damit
 * "Montags um 08:00" und `value="1"` nie zwei verschiedene Tage meinen.
 */
const WEEKDAY_KEYS: readonly string[] = [
  "scheduled.weekdaySun",
  "scheduled.weekdayMon",
  "scheduled.weekdayTue",
  "scheduled.weekdayWed",
  "scheduled.weekdayThu",
  "scheduled.weekdayFri",
  "scheduled.weekdaySat",
];

/**
 * Die Werte des Wochentagsfeldes.
 *
 * `0` und `7` sind beide Sonntag, und beide stehen deshalb zur Wahl: ein
 * gespeicherter Ausdruck `0 8 * * 7` landet beim Bearbeiten als `7` im Feld,
 * und ein `<select>` ohne passende `<option>` zeigt sonst stillschweigend den
 * ersten Eintrag — ein Sonntag wuerde beim naechsten Speichern zu "taeglich".
 */
const WEEKDAY_VALUES: readonly string[] = ["*", "1-5", "1", "2", "3", "4", "5", "6", "0", "7"];

/** Der Katalogschluessel zu einem Feldwert; `7` ist Sonntag wie `0`. */
function weekdayLabelKey(value: string): string {
  if (value === "*") return "scheduled.weekdayEveryDay";
  if (value === "1-5") return "scheduled.weekdayWeekdays";
  return WEEKDAY_KEYS[Number(value) % 7];
}

/**
 * Der Dialog zum Anlegen und Bearbeiten.
 *
 * ### Warum die Loesch-Rueckfrage im Dialog steht
 *
 * Wie beim Kalender: `window.confirm()` liefert im Desktop-Shell der Anwendung
 * immer `false` (die Webansicht implementiert `runJavaScriptConfirmPanel`
 * nicht und verhaelt sich laut Apple wie "Abbrechen"), und im Browser blockiert
 * sie den Hauptthread. Der erste Klick schaltet deshalb in einen
 * Bestaetigungszustand, der zweite loescht.
 */
function TaskDialog({ task, busy, error, onCancel, onSave, onDelete }: {
  task: ScheduledTaskView | null;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onSave: (input: {
    name: string;
    cron: string;
    prompt: string;
    provider: string;
    modelId: string;
    enabled: boolean;
  }, id: string | null) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const { t } = useI18n();

  const [name, setName] = useState(task?.name ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [cron, setCron] = useState(task?.cron ?? "0 8 * * *");
  const [provider, setProvider] = useState(task?.provider ?? "");
  const [modelId, setModelId] = useState(task?.modelId ?? "");
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  /**
   * Warum die Modellliste leer ist — oder `null`, wenn sie geladen wurde.
   *
   * `null` und `[]` sind nicht dasselbe: eine geladene Liste ohne Eintraege
   * heisst "es ist kein Modell konfiguriert", eine gescheiterte heisst "wir
   * wissen es nicht". Ohne diesen Zustand sahen beide gleich aus, und der
   * Grund war unsichtbar — dieselbe Anzeige wie `ModelErrorBanner` im
   * Composer (`components/ChatInput.tsx`).
   */
  const [modelsError, setModelsError] = useState<string | null>(null);

  /**
   * Die Modellliste — dieselbe Quelle wie der Composer.
   *
   * Sie wird erst beim Oeffnen des Dialogs geladen: wer nie eine Aufgabe
   * anlegt, soll die Registrierung nicht anfassen.
   *
   * Gelesen wird `modelList`, nicht `models`: letzteres ist in der Antwort
   * von `/api/models` eine Zuordnung `"provider:id" → Name`, und `.map`
   * darauf ist ein TypeError mitten im Rendern — der Dialog ersetzt dann die
   * ganze App durch Next' Fehlerseite. Die Form steht in
   * `lib/models-cache.ts:ModelsData`.
   *
   * Ein Fehlschlag wird **angezeigt** und nicht verschluckt: `modelError` aus
   * einer 200-Antwort (die Registrierung konnte nicht geladen werden), `error`
   * aus einer Fehlerantwort (400 fremdes `cwd`, 403 ausserhalb der erlaubten
   * Wurzel, 401/503 der Sperre). Beide sind Servertext und bleiben als Detail
   * stehen; davor steht der uebersetzte Satz aus dem Katalog.
   */
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/models")
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as ModelsResponse & { error?: string; modelError?: string };
        if (cancelled) return;
        if (!response.ok) {
          setModels([]);
          setModelsError(`${t("scheduled.modelsFailed")} ${body.error ?? `HTTP ${response.status}`}`);
          return;
        }
        setModels((body.modelList ?? []).map((model) => ({ provider: model.provider, modelId: model.id, name: model.name })));
        setModelsError(body.modelError ? `${t("scheduled.modelsFailed")} ${body.modelError}` : null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setModels([]);
        setModelsError(`${t("scheduled.modelsFailed")} ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  /** Die drei Felder des einfachen Editors — `null`, wenn der Ausdruck sie nicht hergibt. */
  const [editor, setEditor] = useState<EditorValue | null>(() => toEditorValue(task?.cron ?? "0 8 * * *"));

  /** Ein Preset fuellt die drei Felder; das Rohfeld zeigt das Ergebnis. */
  const applyPreset = (presetCron: string) => {
    setCron(presetCron);
    setEditor(toEditorValue(presetCron));
  };

  /**
   * Der gepruefte Ausdruck — oder der Grund, warum er nicht geht.
   *
   * Die Pruefung laeuft live beim Tippen: wer `0 8 L * *` eingibt, sieht den
   * Fehler, bevor er speichert. Der Server prueft denselben Ausdruck noch
   * einmal — die Pruefung hier ist die Rueckmeldung, nicht die Absicherung.
   *
   * Gemeldet wird `scheduled.invalidCron` und **nicht** der Satz aus
   * `ScheduleError.message`: der ist englisch, nennt interne Feldnamen
   * (`dayOfMonth`) und wuerde in einer deutschen Oberflaeche als fremder Text
   * stehen (`docs/i18n.md`, "Do not translate an API error"). Das abgelehnte
   * Feld und der Token bleiben trotzdem sichtbar, weil sie die eigentliche
   * Auskunft sind: sie sagen, *wo* der Ausdruck klemmt.
   *
   * `describeSchedule` **wirft nicht** — es liefert `null` fuer einen
   * ungueltigen Ausdruck. Feld und Token kommen deshalb aus `parseSchedule`,
   * das `ScheduleError` wirft. Ein `try`/`catch` nur um `describeSchedule`
   * ginge nie in den `catch`, `ok` bliebe immer `true`, und Speichern waere
   * fuer `0 8 L * *` freigegeben: die Rueckmeldung, fuer die es diese Pruefung
   * gibt, waere still verschwunden.
   */
  const parsed = useMemo(() => {
    try {
      const schedule = parseSchedule(cron);
      return { ok: true as const, description: describeSchedule(schedule.expression) };
    } catch (cause) {
      if (cause instanceof ScheduleError) {
        return { ok: false as const, field: cause.field, token: cause.token };
      }
      return { ok: false as const, field: null, token: String(cause) };
    }
  }, [cron]);

  const modelValue = provider && modelId ? `${provider}\u0000${modelId}` : "";
  const nameInvalid = name.trim() === "" || name.trim().length > MAX_TASK_NAME_LENGTH;
  const promptInvalid = prompt.trim() === "" || prompt.length > MAX_TASK_PROMPT_LENGTH;
  const canSave = !busy && parsed.ok && !nameInvalid && !promptInvalid && modelValue !== "";

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const [nextProvider, nextModelId] = modelValue.split("\u0000");
    void onSave({ name: name.trim(), cron: cron.trim(), prompt, provider: nextProvider, modelId: nextModelId, enabled }, task?.id ?? null);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        showCloseButton={false}
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          color: "var(--text)",
          maxWidth: 520,
          width: "calc(100% - 32px)",
          maxHeight: "calc(100dvh - 32px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <form
          onSubmit={handleSubmit}
          noValidate
          style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" }}
        >
          <DialogHeader style={{ flexShrink: 0 }}>
            <DialogTitle style={{ fontSize: 15, color: "var(--text)" }}>
              {task ? t("scheduled.editTask") : t("scheduled.newTask")}
            </DialogTitle>
            <DialogDescription style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {t("scheduled.emptyHint")}
            </DialogDescription>
          </DialogHeader>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              marginTop: 4,
              flex: "1 1 auto",
              minHeight: 0,
              overflowY: "auto",
              overflowX: "hidden",
              overscrollBehavior: "contain",
            }}
          >
            <div>
              <label style={labelStyle} htmlFor="scheduled-name">{t("scheduled.name")}</label>
              <input
                id="scheduled-name"
                type="text"
                autoFocus
                value={name}
                maxLength={MAX_TASK_NAME_LENGTH}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("scheduled.namePlaceholder")}
                style={inputStyle}
              />
            </div>

            <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
              <legend style={{ ...labelStyle, padding: 0 }}>{t("scheduled.schedule")}</legend>
              {/* Ein Klick auf ein Preset fuellt die Felder darunter. Die
                  Beschriftung ist die deutsche Beschreibung des Ausdrucks —
                  dieselbe, die die Liste zeigt. */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                {SCHEDULE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset.cron)}
                    aria-pressed={cron.trim() === preset.cron}
                    style={{
                      padding: "3px 9px",
                      fontSize: 11,
                      fontFamily: "inherit",
                      cursor: "pointer",
                      border: "1px solid var(--border)",
                      background: cron.trim() === preset.cron ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "none",
                      color: "var(--text)",
                      borderRadius: 999,
                    }}
                  >
                    {t(`scheduled.${preset.labelKey}`)}
                  </button>
                ))}
              </div>

              {/* Die drei Felder des einfachen Editors. Sie schreiben in
                  dasselbe `cron`-Feld wie das Rohfeld — es gibt keinen zweiten
                  Zustand, der auseinanderlaufen koennte. */}
              {editor ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
                  <div style={{ width: 64 }}>
                    <label style={labelStyle} htmlFor="scheduled-minute">{t("scheduled.minute")}</label>
                    <input
                      id="scheduled-minute"
                      type="number"
                      min={0}
                      max={59}
                      value={editor.minute}
                      onChange={(event) => {
                        const next = { ...editor, minute: event.target.value };
                        setEditor(next);
                        setCron(toCron(next));
                      }}
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ width: 64 }}>
                    <label style={labelStyle} htmlFor="scheduled-hour">{t("scheduled.hour")}</label>
                    <input
                      id="scheduled-hour"
                      type="number"
                      min={0}
                      max={23}
                      value={editor.hour}
                      onChange={(event) => {
                        const next = { ...editor, hour: event.target.value };
                        setEditor(next);
                        setCron(toCron(next));
                      }}
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ minWidth: 120 }}>
                    <label style={labelStyle} htmlFor="scheduled-weekday">{t("scheduled.weekday")}</label>
                    <select
                      id="scheduled-weekday"
                      value={editor.weekday}
                      onChange={(event) => {
                        const next = { ...editor, weekday: event.target.value };
                        setEditor(next);
                        setCron(toCron(next));
                      }}
                      style={inputStyle}
                    >
                      {WEEKDAY_VALUES.map((value) => (
                        <option key={value} value={value}>{t(weekdayLabelKey(value))}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}

              <label style={labelStyle} htmlFor="scheduled-cron">{t("scheduled.cron")}</label>
              <input
                id="scheduled-cron"
                type="text"
                value={cron}
                spellCheck={false}
                onChange={(event) => {
                  setCron(event.target.value);
                  setEditor(toEditorValue(event.target.value));
                }}
                placeholder={t("scheduled.cronPlaceholder")}
                aria-invalid={!parsed.ok}
                aria-describedby="scheduled-cron-help"
                style={{
                  ...inputStyle,
                  fontFamily: "var(--font-mono, monospace)",
                  borderColor: parsed.ok ? "var(--border)" : "var(--danger)",
                }}
              />
              <p
                id="scheduled-cron-help"
                style={{
                  margin: "4px 0 0",
                  fontSize: 11,
                  color: parsed.ok ? "var(--text-muted)" : "var(--danger)",
                }}
                role={parsed.ok ? undefined : "alert"}
              >
                {parsed.ok
                  ? describeIn(parsed.description, t)
                  : `${t("scheduled.invalidCron")}${parsed.field ? ` (${parsed.field}: ${parsed.token})` : ""}`}
              </p>
              <p style={{ margin: "2px 0 0", fontSize: 10, color: "var(--text-dim)" }}>
                {t("scheduled.cronHint")}
              </p>
            </fieldset>

            <div>
              <label style={labelStyle} htmlFor="scheduled-model">{t("scheduled.model")}</label>
              <select
                id="scheduled-model"
                value={modelValue}
                onChange={(event) => {
                  const [nextProvider, nextModelId] = event.target.value.split("\u0000");
                  setProvider(nextProvider);
                  setModelId(nextModelId);
                }}
                style={inputStyle}
              >
                <option value="">{t("scheduled.modelPlaceholder")}</option>
                {(models ?? []).map((model) => (
                  <option key={`${model.provider}\u0000${model.modelId}`} value={`${model.provider}\u0000${model.modelId}`}>
                    {model.name}
                  </option>
                ))}
                {/* Das gespeicherte Modell bleibt waehlbar, auch wenn die
                    Registrierung es gerade nicht fuehrt: sonst wuerde ein
                    Oeffnen des Dialogs das Modell stillschweigend leeren. */}
                {provider && modelId && !(models ?? []).some((model) => model.provider === provider && model.modelId === modelId) ? (
                  <option value={`${provider}\u0000${modelId}`}>{`${provider}/${modelId}`}</option>
                ) : null}
              </select>
              {/* Der Grund steht unter dem Feld, nicht in der Meldungsleiste
                  der Ansicht: die liegt hinter dem Overlay und waere von hier
                  aus unerreichbar. */}
              {modelsError ? (
                <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--warning, #ffb347)" }} role="alert">
                  {modelsError}
                </p>
              ) : null}
            </div>

            <div>
              <label style={labelStyle} htmlFor="scheduled-prompt">{t("scheduled.prompt")}</label>
              <textarea
                id="scheduled-prompt"
                value={prompt}
                rows={5}
                maxLength={MAX_TASK_PROMPT_LENGTH}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={t("scheduled.promptPlaceholder")}
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
              />
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                style={{ accentColor: "var(--accent)" }}
              />
              {t("scheduled.enabled")}
            </label>

            {/* Der Fehler des Servers steht im Dialog, nicht in der Ansicht:
                eine Meldungsleiste hinter dem Overlay waere unerreichbar. */}
            {error ? (
              <p style={{ margin: 0, fontSize: 11, color: "var(--danger)" }} role="alert">{error}</p>
            ) : null}
          </div>

          <DialogFooter
            style={{
              marginTop: 16,
              gap: 8,
              display: "flex",
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "flex-start",
              flexShrink: 0,
              ...(confirmingDelete
                ? {
                  background: "color-mix(in srgb, var(--danger) 9%, transparent)",
                  borderTop: "1px solid color-mix(in srgb, var(--danger) 45%, transparent)",
                }
                : {}),
            }}
          >
            {confirmingDelete ? (
              <>
                <div style={{ flexBasis: "100%", marginBottom: 2, fontSize: 12, fontWeight: 550, color: "var(--danger)" }}>
                  {t("scheduled.deleteConfirm", { name: task?.name?.trim() || t("scheduled.title") })}
                </div>
                <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={busy}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      fontFamily: "inherit",
                      cursor: busy ? "not-allowed" : "pointer",
                      border: "1px solid var(--border)",
                      background: "none",
                      color: "var(--text-muted)",
                      borderRadius: 7,
                    }}
                  >
                    {t("scheduled.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setConfirmingDelete(false); if (task) void onDelete(task.id); }}
                    disabled={busy}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      fontWeight: 550,
                      fontFamily: "inherit",
                      cursor: busy ? "not-allowed" : "pointer",
                      border: "1px solid var(--danger)",
                      background: "var(--danger)",
                      color: "var(--bg)",
                      borderRadius: 7,
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {t("scheduled.deleteTask")}
                  </button>
                </div>
              </>
            ) : (
              <>
                {task ? (
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={busy}
                    style={{
                      flexShrink: 0,
                      padding: "6px 12px",
                      fontSize: 12,
                      fontFamily: "inherit",
                      cursor: busy ? "not-allowed" : "pointer",
                      border: "1px solid var(--danger)",
                      background: "none",
                      color: "var(--danger)",
                      borderRadius: 7,
                    }}
                  >
                    {t("scheduled.deleteTask")}
                  </button>
                ) : null}

                <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={onCancel}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      fontFamily: "inherit",
                      cursor: "pointer",
                      border: "1px solid var(--border)",
                      background: "none",
                      color: "var(--text-muted)",
                      borderRadius: 7,
                    }}
                  >
                    {t("scheduled.cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={!canSave}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      fontWeight: 550,
                      fontFamily: "inherit",
                      cursor: canSave ? "pointer" : "not-allowed",
                      border: "1px solid var(--accent)",
                      background: "var(--accent)",
                      color: "var(--bg)",
                      borderRadius: 7,
                      opacity: canSave ? 1 : 0.6,
                    }}
                  >
                    {busy ? t("scheduled.saving") : t("scheduled.save")}
                  </button>
                </div>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
