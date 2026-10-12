"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import type { OmpWebUpdateResponse } from "@/lib/api-types";
import { MarkdownBody } from "./MarkdownBody";

type LoadState = "idle" | "loading" | "ready";

/**
 * Why the status fetch did not produce a status.
 *
 * The authorized routes answer with 403 when the caller lacks the permission
 * and 404 when the resource does not exist. Those are different situations and
 * they used to be flattened into one `if (!response.ok) return;`, which left
 * `loadState` parked on `"loading"` for the rest of the session — a third,
 * unnamed outcome that looked like a slow request that never arrived.
 *
 * - `unauthorized` (403): the caller may not ask. There is nothing to show and
 *   nobody to show it to, so this is terminal and renders nothing.
 * - `missing` (404): this build has no update endpoint at all. Equally
 *   terminal, but a deployment fact rather than a permission fact — the
 *   distinction is kept so the two can be told apart in a report instead of
 *   both reading as "the update check did not work".
 */
export type UpdatesFetchOutcome =
  | "ok"
  | "unauthorized"
  | "missing"
  | "unavailable";

/**
 * Classify the status code of a response from `/api/updates`.
 *
 * Pure: it reads the status code and nothing else, so a proxy that answers 403
 * with an HTML error page cannot make this throw, and no body is read on an
 * error path. Exported so the 403/404 distinction is testable on its own,
 * without mounting the component.
 */
export function classifyUpdatesResponse(status: number): UpdatesFetchOutcome {
  if (status === 403) return "unauthorized";
  if (status === 404) return "missing";
  if (status < 200 || status >= 300) return "unavailable";
  return "ok";
}

function displayVersion(version: string): string {
  return version === "unknown" ? version : `v${version}`;
}

export function OmpUpdateIndicator() {
  const { locale, t } = useI18n();
  const [status, setStatus] = useState<OmpWebUpdateResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  // How the last fetch ended when it ended without a status. `null` means the
  // request has not been classified yet. Nothing renders from this state
  // directly — it exists so 403 and 404 stay distinguishable instead of both
  // collapsing into a permanently "loading" component.
  const [outcome, setOutcome] = useState<UpdatesFetchOutcome | null>(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [panelPosition, setPanelPosition] = useState<{ left: number; bottom: number; width: number } | null>(null);

  const updatePanelPosition = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(430, window.innerWidth - 24);
    const maxLeft = Math.max(12, window.innerWidth - width - 12);
    setPanelPosition({
      left: Math.min(rect.right + 8, maxLeft),
      bottom: Math.max(12, window.innerHeight - rect.top + 8),
      width,
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setPanelPosition(null);
      return;
    }
    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open, updatePanelPosition]);


  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    try {
      const response = await fetch("/api/updates", { cache: "no-store", signal });
      const outcome = classifyUpdatesResponse(response.status);
      // 403 and 404 both settle, and both settle to a state that renders
      // nothing — but they are recorded separately, because "not allowed to
      // ask" and "this build has no update endpoint" are different facts and
      // used to be indistinguishable from a request still in flight. `ready`
      // would be wrong here: it means "a status was fetched, and it says there
      // is no update", which is a claim about a body we never received.
      if (outcome !== "ok") {
        if (!signal?.aborted) {
          setOutcome(outcome);
          setLoadState("ready");
        }
        return;
      }
      const next = await response.json() as OmpWebUpdateResponse;
      setStatus(next);
      setLoadState("ready");
    } catch {
      if (!signal?.aborted) setLoadState("ready");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus]);

  useEffect(() => () => {
    clearTimeout(copiedTimerRef.current ?? undefined);
    copiedTimerRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Nothing renders without a status that says an update exists — including
  // after a 403 or a 404. The two are told apart by `outcome`, not by the
  // markup: neither has a body to render, so the honest result for both is
  // the same empty output, reached for different and separately recorded
  // reasons.
  if (loadState !== "ready" || outcome !== null || !status?.updateAvailable) return null;

  const release = status.latestRelease;
  const releaseDate = release.publishedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(release.publishedAt))
    : null;
  const changelog = release.body.trim() || release.name;
  const copyCommand = async (command: string) => {
    try {
      await copyText(command);
      clearTimeout(copiedTimerRef.current ?? undefined);
      setCopiedCommand(command);
      copiedTimerRef.current = setTimeout(() => setCopiedCommand(null), 1600);
    } catch {
      setMessage({ kind: "error", text: t("updates.copyFailed") });
    }
  };
  const installUpdate = async () => {
    if (!status.install.canInstall || installing) return;
    setInstalling(true);
    setMessage(null);
    try {
      const response = await fetch("/api/updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json().catch(() => ({})) as { error?: string; installedVersion?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setMessage({
        kind: "success",
        text: t("updates.installed", { version: displayVersion(body.installedVersion ?? release.version) }),
      });
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div ref={rootRef} style={{ position: "relative", width: "100%" }}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((value) => !value);
          setMessage(null);
        }}
        title={t("updates.availableTitle", { version: displayVersion(release.version) })}
        style={{
          width: "100%",
          minHeight: 34,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "7px 10px",
          border: "1px solid color-mix(in srgb, var(--warning) 54%, var(--border))",
          borderRadius: 9,
          background: "color-mix(in srgb, var(--warning) 8%, transparent)",
          color: "var(--warning)",
          cursor: "pointer",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          transition: "background 0.12s, border-color 0.12s, color 0.12s",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = "color-mix(in srgb, var(--warning) 14%, var(--bg-hover))";
          event.currentTarget.style.borderColor = "var(--warning)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = "color-mix(in srgb, var(--warning) 8%, transparent)";
          event.currentTarget.style.borderColor = "color-mix(in srgb, var(--warning) 54%, var(--border))";
        }}
      >
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warning)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--warning) 14%, transparent)" }} />
        <span>{t("updates.available")}</span>
        <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{displayVersion(release.version)}</span>
      </button>

      {open && panelPosition && (
        <div
          role="dialog"
          aria-label={t("updates.dialogTitle")}
          style={{
            position: "fixed",
            left: panelPosition.left,
            bottom: panelPosition.bottom,
            zIndex: 700,
            width: panelPosition.width,
            maxHeight: "min(72vh, 620px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg-panel)",
            boxShadow: "0 18px 46px rgba(0,0,0,0.28)",
          }}
        >
          <div style={{ padding: "13px 14px 11px", borderBottom: "1px solid var(--border)", background: "linear-gradient(135deg, color-mix(in srgb, var(--warning) 10%, var(--bg-panel)), var(--bg-panel) 65%)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ color: "var(--text-dim)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>{t("updates.dialogEyebrow")}</div>
                <div style={{ marginTop: 3, color: "var(--text)", fontSize: 15, fontWeight: 650 }}>{t("updates.dialogTitle")}</div>
              </div>
              <div style={{ color: "var(--warning)", fontFamily: "var(--font-mono)", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{displayVersion(release.version)}</div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 9, color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              <span>{t("updates.current", { version: displayVersion(status.currentAppVersion) })}</span>
              {releaseDate && <span>{releaseDate}</span>}
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "11px 14px 14px" }}>
            <div style={{ marginBottom: 7, color: "var(--text-dim)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>{t("updates.changelog")}</div>
            <div className="update-changelog" style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 }}>
              <MarkdownBody>{changelog}</MarkdownBody>
            </div>

          </div>

          <div style={{ flexShrink: 0, padding: "10px 14px 12px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
              <a
                href={release.htmlUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)", fontSize: 11, textDecoration: "underline", textUnderlineOffset: 3 }}
              >
                {t("updates.viewRelease")}
              </a>
            </div>

            {status.install.canInstall ? (
              <button
                type="button"
                onClick={() => void installUpdate()}
                disabled={installing}
                style={{ width: "100%", minHeight: 34, border: "1px solid var(--accent)", borderRadius: 7, background: installing ? "var(--bg-selected)" : "var(--accent)", color: installing ? "var(--accent)" : "var(--bg)", cursor: installing ? "wait" : "pointer", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)" }}
              >
                {installing ? t("updates.installing") : t("updates.install")}
              </button>
            ) : (
              <div style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
                <div style={{ marginBottom: 7, color: "var(--text-dim)" }}>{t("updates.manual")}</div>
                {[status.install.command, status.install.alternateCommand].map((command) => (
                  <div key={command} style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, marginTop: 6, padding: "6px 7px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", fontFamily: "var(--font-mono)" }}>
                    <code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", color: "var(--text)" }}>{command}</code>
                    <button
                      type="button"
                      onClick={() => void copyCommand(command)}
                      title={copiedCommand === command ? t("updates.commandCopied") : t("updates.copyCommand")}
                      aria-label={copiedCommand === command ? t("updates.commandCopied") : t("updates.copyCommand")}
                      style={{ flex: "0 0 auto", width: 24, height: 24, padding: 0, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", color: copiedCommand === command ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
                    >
                      {copiedCommand === command ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {message && (
              <div role={message.kind === "error" ? "alert" : "status"} style={{ marginTop: 9, color: message.kind === "error" ? "var(--danger)" : "var(--success)", fontSize: 11, lineHeight: 1.45 }}>
                {message.text}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
