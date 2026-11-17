"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  useNewsletters,
  type Newsletter,
  type NewsletterInput,
  type NewsletterIssue,
  type NewsletterSchedule,
} from "@/hooks/useNewsletters";
import { formatRelativeTime } from "@/lib/i18n/format";
import { useScheduledSettings } from "@/hooks/useScheduledSettings";
import { CwdPicker } from "@/components/CwdPicker";
import { toCron, toEditorValue, WEEKDAY_VALUES, weekdayLabelKey, type EditorValue } from "@/lib/schedule-editor";
import { Skeleton } from "@/components/motion/Skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Die Newsletter-Ansicht.
 *
 * ### Was hier bewusst nicht steht
 *
 * Kein Markdown und kein HTML. Was der geplante Agent schreibt, ist Text; er
 * wird als Text gerendert (React maskiert ihn) und nicht als Auszeichnung
 * interpretiert. Eine Ausgabe ist ein Bericht, kein Dokument.
 *
 * ### Warum die Ausgaben in der Ansicht und nicht im Speicher wechseln
 *
 * Der Server liefert alle Ausgaben mit; welche gezeigt wird, ist eine
 * Anzeigeentscheidung. Ein zweiter Endpunkt fuer "eine Ausgabe" waere eine
 * zweite Wahrheit ueber die Reihenfolge.
 *
 * ### Warum der Zeitplan vom Server kommt und nie zwischengespeichert wird
 *
 * Der Cron-Ausdruck liegt auf der geplanten Aufgabe; die Newsletter-Antwort
 * joint ihn als `schedule.cron` beim Lesen. Der Editor fuellt seine Felder
 * daraus und schickt den Ausdruck bei jedem Speichern mit — auch wenn
 * `schedule` `null` ist, denn dann legt genau dieses Speichern die Aufgabe
 * neu an. Eine lokale Kopie (State, `localStorage`) waere eine zweite
 * Wahrheit ueber denselben Lauf.
 */

/** Der Zustand des Dialogs: `null` heisst geschlossen. */
type DialogState =
  | { mode: "create" }
  | { mode: "edit"; newsletter: Newsletter; confirmingDelete?: boolean }
  | null;

/** Ein Eintrag aus `modelList` — der Liste mit Provider-Angabe. */
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
 * Nur `http(s)` wird verlinkt.
 *
 * Die Adresse kommt aus einer Modellausgabe und ist damit fremder Text. Ein
 * `javascript:`- oder `data:`-Ziel waere ein Skript, das die Seite ausfuehrt.
 */
function isHttpUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

/**
 * Der Ordner mit gekuerztem Home-Praefix: `/home/alice/projekt` wird zu
 * `~/projekt`. Dieselbe Anzeige wie die Zeile der geplanten Aufgaben, damit
 * der Ort des Laufs nicht als langer Pfad die Kopfzeile sprengt.
 */
function shortenHome(path: string, home: string): string {
  if (home === "" || path === "") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Eine absolute Zeit in der Zone des Browsers — dieselbe Form wie im Kalender. */
function absoluteTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Themen: eine pro Zeile oder durch Kommas getrennt, ohne Doppel. */
function parseTopics(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,]+/)) {
    const topic = raw.trim();
    if (topic !== "") seen.add(topic);
  }
  return [...seen];
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

/**
 * Die Vorbelegung, wenn es keinen lesbaren Ausdruck gibt.
 *
 * Sie ist auch der Ausdruck, den ein Speichern schickt, waehrend `schedule`
 * `null` ist: genau dieses Speichern legt die geplante Aufgabe neu an.
 */
const DEFAULT_NEWSLETTER_CRON = "0 8 * * 1";

const labelStyle = {
  display: "block",
  fontSize: 11,
  color: "var(--text-muted)",
  marginBottom: 4,
};

const secondaryButton = {
  padding: "5px 10px",
  fontSize: 12,
  fontFamily: "inherit",
  cursor: "pointer",
  border: "1px solid var(--border)",
  background: "none",
  color: "var(--text)",
  borderRadius: 6,
} as const;

const primaryButton = {
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 550,
  fontFamily: "inherit",
  cursor: "pointer",
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "var(--bg)",
  borderRadius: 7,
} as const;

export function NewsletterView() {
  const { t, locale } = useI18n();
  const { newsletters, loading, error, refresh, create, update, remove, runNow } = useNewsletters();
  /**
   * Der Standardordner und die waehlbaren Ordner des Kontos — dieselbe Quelle
   * wie im Dialog der geplanten Aufgaben. Der Kopf zeigt damit auch ohne
   * eigenen Ordner den Ort, an dem der naechste Lauf startet.
   */
  const { settings: cwdSettings } = useScheduledSettings();
  /** Welcher Newsletter gezeigt wird — `null` heisst "der erste". */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Welche Ausgabe gezeigt wird — `null` heisst "die neueste". */
  const [issueId, setIssueId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  /** "Jetzt" fuer die relativen Zeiten, jede halbe Minute neu. */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const list = newsletters;
  const selected = list?.find((entry) => entry.id === selectedId) ?? list?.[0] ?? null;
  const issue = selected
    ? selected.issues.find((entry) => entry.id === issueId) ?? selected.issues[0] ?? null
    : null;
  const olderIssues = selected ? selected.issues.slice(1) : [];

  const failureText = useCallback((cause: unknown, fallback = "newsletters.saveFailed"): string => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const field = (cause as { field?: string } | null)?.field;
    return `${t(fallback)} ${detail}${field ? ` (${field})` : ""}`;
  }, [t]);

  const handleRunNow = useCallback(async (newsletter: Newsletter) => {
    setActionError(null);
    setRunError(null);
    setRunning(true);
    try {
      await runNow(newsletter.id);
    } catch (cause) {
      setRunError(failureText(cause, "newsletters.runFailed"));
    } finally {
      setRunning(false);
    }
  }, [runNow, failureText]);

  const scheduleLine = (schedule: NewsletterSchedule | null): string => {
    if (schedule === null) return t("newsletters.scheduleMissing");
    const parts: string[] = [];
    if (!schedule.enabled) parts.push(t("newsletters.scheduleDisabled"));
    else if (schedule.nextRun === null) parts.push(t("scheduled.noNextRun"));
    else parts.push(t("newsletters.nextRun", {
      time: absoluteTime(schedule.nextRun),
      relative: formatRelativeTime(new Date(schedule.nextRun), locale, new Date(nowMs)),
    }));
    if (schedule.lastRunStatus === null) parts.push(t("newsletters.neverRun"));
    else if (schedule.lastRunAt === null) parts.push(t(schedule.lastRunStatus === "ok" ? "scheduled.statusOk" : "scheduled.statusError"));
    else parts.push(t(schedule.lastRunStatus === "ok" ? "newsletters.lastRunOk" : "newsletters.lastRunError", {
      time: absoluteTime(Date.parse(schedule.lastRunAt)),
    }));
    return parts.join(" · ");
  };

  /** Der Ordner des Laufs: eigener, sonst Kontostandard, sonst Home. */
  const runCwd = selected?.schedule?.cwd ?? cwdSettings?.defaultCwd ?? cwdSettings?.home ?? "";
  const runCwdLabel = runCwd === "" ? "" : shortenHome(runCwd, cwdSettings?.home ?? "");

  const retryButton = (
    <button type="button" onClick={() => void refresh()} style={secondaryButton}>
      {t("newsletters.retry")}
    </button>
  );

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
          gap: 8,
          flexWrap: "wrap",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          {selected ? selected.name : t("newsletters.title")}
        </h1>
        {selected && selected.topics.length > 0 ? (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {selected.topics.map((topic) => (
              <span
                key={topic}
                style={{
                  padding: "1px 8px",
                  fontSize: 11,
                  color: "var(--text-muted)",
                  border: "1px solid var(--border)",
                  borderRadius: 999,
                }}
              >
                {topic}
              </span>
            ))}
          </div>
        ) : null}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setDialog({ mode: "create" });
            }}
            style={primaryButton}
          >
            {t("newsletters.new")}
          </button>
          {selected ? (
            <>
              <button
                type="button"
                onClick={() => void handleRunNow(selected)}
                disabled={running}
                style={{ ...secondaryButton, cursor: running ? "not-allowed" : "pointer", opacity: running ? 0.6 : 1 }}
              >
                {running ? t("newsletters.running") : t("newsletters.runNow")}
              </button>
              <button
                type="button"
                onClick={() => { setActionError(null); setDialog({ mode: "edit", newsletter: selected }); }}
                style={secondaryButton}
              >
                {t("newsletters.edit")}
              </button>
              <button
                type="button"
                onClick={() => { setActionError(null); setDialog({ mode: "edit", newsletter: selected, confirmingDelete: true }); }}
                style={{ ...secondaryButton, color: "var(--danger)", borderColor: "var(--danger)" }}
              >
                {t("newsletters.delete")}
              </button>
            </>
          ) : null}
        </div>
      </header>

      {selected ? (
        <div style={{ padding: "6px 16px", fontSize: 12, color: "var(--text-muted)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          {scheduleLine(selected.schedule)}
          {/* Der Ordner steht hier, nicht nur im Dialog: "wo laeuft das" ist
              die Frage, die man sich beim Ansehen der Liste stellt. */}
          {runCwdLabel ? (
            <span style={{ marginLeft: 8, fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}>
              {t("newsletters.cwd")}: {runCwdLabel}
            </span>
          ) : null}
        </div>
      ) : null}

      {actionError ? (
        <p style={{ margin: 0, padding: "8px 16px", fontSize: 12, color: "var(--danger)" }} role="alert">
          {actionError}
        </p>
      ) : null}
      {runError ? (
        <p style={{ margin: 0, padding: "8px 16px", fontSize: 12, color: "var(--warning, var(--danger))" }} role="alert">
          {runError}
        </p>
      ) : null}

      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 16 }}>
        {list && list.length > 1 ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {list.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => { setSelectedId(entry.id); setIssueId(null); }}
                aria-pressed={entry.id === selected?.id}
                style={{
                  ...secondaryButton,
                  background: entry.id === selected?.id ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "none",
                }}
              >
                {entry.name}
              </button>
            ))}
          </div>
        ) : null}

        {error && list === null ? (
          <div role="alert" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--danger)" }}>{t("newsletters.loadFailed")}</p>
            {retryButton}
          </div>
        ) : loading && list === null ? (
          <div aria-busy="true" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Skeleton width="45%" height={20} />
            <Skeleton width="70%" height={13} />
            <Skeleton height={110} radius={9} />
            <Skeleton height={110} radius={9} />
          </div>
        ) : list !== null && list.length === 0 ? (
          <div data-newsletter-state="empty" style={{ maxWidth: 520 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 550 }}>{t("newsletters.empty")}</p>
            <p style={{ margin: "6px 0 12px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("newsletters.emptyHint")}
            </p>
            <button
              type="button"
              onClick={() => { setActionError(null); setDialog({ mode: "create" }); }}
              style={primaryButton}
            >
              {t("newsletters.new")}
            </button>
          </div>
        ) : error && list !== null ? (
          <div role="alert" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>{t("newsletters.loadFailed")}</p>
            {retryButton}
          </div>
        ) : null}

        {selected && list !== null && list.length > 0 ? (
          <>
            {issue ? (
              <IssueCard issue={issue} nowMs={nowMs} />
            ) : (
              <div data-newsletter-state="no-issue" style={{ maxWidth: 520 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 550 }}>{t("newsletters.noIssue")}</p>
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  {t("newsletters.noIssueHint")}
                </p>
              </div>
            )}

            {olderIssues.length > 0 ? (
              <section style={{ marginTop: 20 }}>
                <h2 style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                  {t("newsletters.history")}
                </h2>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => setIssueId(null)}
                    aria-pressed={issue === selected.issues[0]}
                    style={{
                      ...secondaryButton,
                      background: issue === selected.issues[0] ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "none",
                    }}
                  >
                    {t("newsletters.newest")}
                  </button>
                  {olderIssues.map((entry) => {
                    const day = Date.parse(entry.generatedAt);
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => setIssueId(entry.id)}
                        aria-pressed={issue?.id === entry.id}
                        style={{
                          ...secondaryButton,
                          background: issue?.id === entry.id ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "none",
                        }}
                      >
                        {Number.isNaN(day) ? entry.generatedAt : absoluteTime(day).slice(0, 10)}
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </div>

      {dialog ? (
        <NewsletterDialog
          newsletter={dialog.mode === "edit" ? dialog.newsletter : null}
          startConfirmingDelete={dialog.mode === "edit" && dialog.confirmingDelete === true}
          busy={busy}
          error={actionError}
          home={cwdSettings?.home ?? ""}
          folders={cwdSettings?.folders ?? []}
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
            setActionError(null);
            setBusy(true);
            try {
              await remove(id);
              setDialog(null);
            } catch (cause) {
              setActionError(failureText(cause, "newsletters.deleteFailed"));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

/** Eine Ausgabe: Einleitung und die Abschnitte je Thema. */
function IssueCard({ issue, nowMs }: { issue: NewsletterIssue; nowMs: number }) {
  const { t } = useI18n();
  return (
    <article data-newsletter-issue={issue.id}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          {issue.title ?? t("newsletters.latest")}
        </h2>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {t("newsletters.generatedAt", { time: absoluteTime(Date.parse(issue.generatedAt) || nowMs) })}
        </span>
      </div>
      {issue.intro ? (
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5, maxWidth: "80ch" }}>
          {issue.intro}
        </p>
      ) : null}
      <div
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 10,
        }}
      >
        {issue.sections.map((section, index) => (
          <section
            key={`${section.topic}-${index}`}
            style={{
              padding: "10px 12px",
              border: "1px solid var(--border)",
              borderRadius: 9,
              background: "var(--bg-panel)",
              minWidth: 0,
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-dim)" }}>
              {section.topic}
            </div>
            {section.headline ? (
              <h3 style={{ margin: "4px 0 0", fontSize: 13, fontWeight: 600 }}>{section.headline}</h3>
            ) : null}
            {section.summary ? (
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                {section.summary}
              </p>
            ) : null}
            {section.items.length > 0 ? (
              <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {section.items.map((item, itemIndex) => (
                  <li key={`${item.title}-${itemIndex}`}>
                    <div style={{ fontSize: 12, fontWeight: 550 }}>{item.title}</div>
                    {item.summary ? (
                      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{item.summary}</div>
                    ) : null}
                    {isHttpUrl(item.url) ? (
                      <a
                        href={item.url.trim()}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 11, color: "var(--accent)" }}
                      >
                        {t("newsletters.source")}
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>
    </article>
  );
}

/** Der Dialog zum Anlegen und Bearbeiten. */
function NewsletterDialog({ newsletter, startConfirmingDelete, busy, error, home, folders, onCancel, onSave, onDelete }: {
  newsletter: Newsletter | null;
  /** Der Loeschknopf der Ansicht oeffnet denselben Dialog, nur fragend. */
  startConfirmingDelete: boolean;
  busy: boolean;
  error?: string | null;
  /** Die Home des Kontos und die waehlbaren Ordner, wie im Aufgabendialog. */
  home: string;
  folders: string[];
  onCancel: () => void;
  onSave: (input: NewsletterInput, id: string | null) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(newsletter?.name ?? "");
  const [topicsText, setTopicsText] = useState(newsletter?.topics.join("\n") ?? "");
  /**
   * Der Zeitplan des gespeicherten Newsletters, aus `schedule.cron`.
   *
   * `schedule` ist `null`, wenn die geplante Aufgabe fehlt; dann gelten die
   * Felder der Vorbelegung, und Speichern legt die Aufgabe mit genau diesem
   * Ausdruck neu an. Der Ausdruck bleibt ausserdem im Rohfeld stehen, damit
   * ein exotischer Cron (`toEditorValue` liefert `null`) beim Speichern
   * unveraendert zurueckgeht.
   */
  const initialCron = newsletter?.schedule?.cron ?? DEFAULT_NEWSLETTER_CRON;
  const initialEditor = toEditorValue(initialCron) ?? toEditorValue(DEFAULT_NEWSLETTER_CRON)!;
  const [minute, setMinute] = useState(initialEditor.minute);
  const [hour, setHour] = useState(initialEditor.hour);
  const [weekday, setWeekday] = useState(initialEditor.weekday);
  const [rawCron, setRawCron] = useState(initialCron);
  const [provider, setProvider] = useState(newsletter?.provider ?? "");
  const [modelId, setModelId] = useState(newsletter?.modelId ?? "");
  /**
   * Der Ordner des Laufs, aus `schedule.cwd` vorbelegt — wie `cron` kommt er
   * aus der Aufgabe und nicht aus dem Datensatz. `null` heisst
   * "Kontostandard", nicht "noch nichts gewaehlt".
   */
  const [cwd, setCwd] = useState<string | null>(newsletter?.schedule?.cwd ?? null);
  const [confirmingDelete, setConfirmingDelete] = useState(startConfirmingDelete);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/models")
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as ModelsResponse & { error?: string; modelError?: string };
        if (cancelled) return;
        if (!response.ok) {
          setModels([]);
          setModelsError(`${t("newsletters.modelsFailed")} ${body.error ?? `HTTP ${response.status}`}`);
          return;
        }
        setModels((body.modelList ?? []).map((model) => ({ provider: model.provider, modelId: model.id, name: model.name })));
        setModelsError(body.modelError ? `${t("newsletters.modelsFailed")} ${body.modelError}` : null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setModels([]);
        setModelsError(`${t("newsletters.modelsFailed")} ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  /** Die drei Felder schreiben in dasselbe `cron`-Feld wie das Rohfeld. */
  const applyEditor = (next: EditorValue) => {
    setMinute(next.minute);
    setHour(next.hour);
    setWeekday(next.weekday);
    setRawCron("");
  };

  /** Der Ausdruck, der gespeichert wird — er geht bei jedem Speichern mit. */
  const cron = rawCron.trim() !== ""
    ? rawCron.trim()
    : minute !== "" && hour !== "" ? toCron({ minute, hour, weekday }) : "";

  const topics = parseTopics(topicsText);
  const modelValue = provider && modelId ? `${provider}\u0000${modelId}` : "";
  const canSave = !busy
    && name.trim() !== ""
    && topics.length > 0
    && cron !== ""
    && modelValue !== "";

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const [nextProvider, nextModelId] = modelValue.split("\u0000");
    void onSave({ name: name.trim(), topics, cron, provider: nextProvider, modelId: nextModelId, cwd }, newsletter?.id ?? null);
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
              {newsletter ? t("newsletters.editTitle") : t("newsletters.new")}
            </DialogTitle>
            <DialogDescription style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {t("newsletters.emptyHint")}
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
              <label style={labelStyle} htmlFor="newsletter-name">{t("newsletters.name")}</label>
              <input
                id="newsletter-name"
                type="text"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("newsletters.namePlaceholder")}
                style={inputStyle}
              />
            </div>

            <div>
              <label style={labelStyle} htmlFor="newsletter-topics">{t("newsletters.topics")}</label>
              <textarea
                id="newsletter-topics"
                value={topicsText}
                rows={4}
                onChange={(event) => setTopicsText(event.target.value)}
                placeholder={t("newsletters.topicsPlaceholder")}
                aria-describedby="newsletter-topics-help"
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
              />
              <p id="newsletter-topics-help" style={{ margin: "2px 0 0", fontSize: 10, color: "var(--text-dim)" }}>
                {t("newsletters.topicsHint")}
              </p>
            </div>

            <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
              <legend style={{ ...labelStyle, padding: 0 }}>{t("scheduled.schedule")}</legend>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
                <div style={{ width: 64 }}>
                  <label style={labelStyle} htmlFor="newsletter-minute">{t("scheduled.minute")}</label>
                  <input
                    id="newsletter-minute"
                    type="number"
                    min={0}
                    max={59}
                    value={minute}
                    onChange={(event) => applyEditor({ minute: event.target.value, hour, weekday })}
                    style={inputStyle}
                  />
                </div>
                <div style={{ width: 64 }}>
                  <label style={labelStyle} htmlFor="newsletter-hour">{t("scheduled.hour")}</label>
                  <input
                    id="newsletter-hour"
                    type="number"
                    min={0}
                    max={23}
                    value={hour}
                    onChange={(event) => applyEditor({ minute, hour: event.target.value, weekday })}
                    style={inputStyle}
                  />
                </div>
                <div style={{ minWidth: 120 }}>
                  <label style={labelStyle} htmlFor="newsletter-weekday">{t("scheduled.weekday")}</label>
                  <select
                    id="newsletter-weekday"
                    value={weekday}
                    onChange={(event) => applyEditor({ minute, hour, weekday: event.target.value })}
                    style={inputStyle}
                  >
                    {WEEKDAY_VALUES.map((value) => (
                      <option key={value} value={value}>{t(weekdayLabelKey(value))}</option>
                    ))}
                  </select>
                </div>
              </div>

              <label style={labelStyle} htmlFor="newsletter-cron">{t("scheduled.cron")}</label>
              <input
                id="newsletter-cron"
                type="text"
                value={rawCron}
                spellCheck={false}
                onChange={(event) => {
                  setRawCron(event.target.value);
                  const parsed = toEditorValue(event.target.value);
                  if (parsed) {
                    setMinute(parsed.minute);
                    setHour(parsed.hour);
                    setWeekday(parsed.weekday);
                  }
                }}
                placeholder={t("scheduled.cronPlaceholder")}
                style={{ ...inputStyle, fontFamily: "var(--font-mono, monospace)" }}
              />
              <p style={{ margin: "2px 0 0", fontSize: 10, color: "var(--text-dim)" }}>
                {t("scheduled.cronHint")}
              </p>
            </fieldset>

            <div>
              <label style={labelStyle} htmlFor="newsletter-cwd">{t("newsletters.cwd")}</label>
              {/* Dieselbe Wahl wie im Dialog der geplanten Aufgaben: der
                  Leerwert ist "kein eigener Ordner" und geht als `null` mit. */}
              <CwdPicker
                id="newsletter-cwd"
                value={cwd}
                home={home}
                folders={folders}
                inheritLabel={t("newsletters.cwdInherit")}
                onChange={setCwd}
                disabled={busy}
              />
              <p style={{ margin: "2px 0 0", fontSize: 10, color: "var(--text-dim)" }}>
                {t("newsletters.cwdHint")}
              </p>
            </div>

            <div>
              <label style={labelStyle} htmlFor="newsletter-model">{t("newsletters.model")}</label>
              <select
                id="newsletter-model"
                value={modelValue}
                onChange={(event) => {
                  const [nextProvider, nextModelId] = event.target.value.split("\u0000");
                  setProvider(nextProvider);
                  setModelId(nextModelId);
                }}
                style={inputStyle}
              >
                <option value="">{t("newsletters.modelPlaceholder")}</option>
                {(models ?? []).map((model) => (
                  <option key={`${model.provider}\u0000${model.modelId}`} value={`${model.provider}\u0000${model.modelId}`}>
                    {model.name}
                  </option>
                ))}
                {/* Das gespeicherte Modell bleibt waehlbar, auch wenn die
                    Registrierung es gerade nicht fuehrt. */}
                {provider && modelId && !(models ?? []).some((model) => model.provider === provider && model.modelId === modelId) ? (
                  <option value={`${provider}\u0000${modelId}`}>{`${provider}/${modelId}`}</option>
                ) : null}
              </select>
              {modelsError ? (
                <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--warning, var(--danger))" }} role="alert">
                  {modelsError}
                </p>
              ) : null}
            </div>

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
                  {t("newsletters.deleteConfirm", { name: newsletter?.name?.trim() || t("newsletters.title") })}
                </div>
                <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={busy}
                    style={{ ...secondaryButton, color: "var(--text-muted)", cursor: busy ? "not-allowed" : "pointer" }}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setConfirmingDelete(false); if (newsletter) void onDelete(newsletter.id); }}
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
                    {t("newsletters.deleteNewsletter")}
                  </button>
                </div>
              </>
            ) : (
              <>
                {newsletter ? (
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
                    {t("newsletters.delete")}
                  </button>
                ) : null}

                <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexShrink: 0 }}>
                  <button type="button" onClick={onCancel} style={{ ...secondaryButton, color: "var(--text-muted)" }}>
                    {t("common.cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={!canSave}
                    style={{
                      ...primaryButton,
                      cursor: canSave ? "pointer" : "not-allowed",
                      opacity: canSave ? 1 : 0.6,
                    }}
                  >
                    {busy ? t("newsletters.saving") : t("newsletters.save")}
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
