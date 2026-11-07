"use client";
import { useI18n } from "@/hooks/useI18n";
import type { ReactNode } from "react";

/**
 * Eine Ausgabe im Transkript als einzeilige Offenlegung. `children` wird nur
 * gemountet, wenn die Zeile offen ist — der ganze Punkt der Uebung: ein
 * zugeklapptes Transkript kostet kein Layout und kein Markdown-Rendering.
 * Der Auf-/Zu-Zustand gehoert dem Aufrufer (ChatWindow), damit er weder einen
 * Stream-Neurender noch das Nachladen alter Seiten verliert.
 */
export function CollapsibleMessage({ id, open, onToggle, label, preview, meta = [], timestamp, children }: {
  id: string;
  open: boolean;
  onToggle: () => void;
  label: string;
  preview: string;
  /** Kleine Meta-Teile rechts an der Zeile, mit " · " verbunden. */
  meta?: string[];
  timestamp?: number;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const parts = [...meta];
  if (timestamp) parts.push(new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        title={open ? t("chat.collapseOutput") : t("chat.expandOutput")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          minWidth: 0,
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ flexShrink: 0, color: "var(--text)" }}>{label}</span>
        {!open && preview && (
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)" }}>
            {preview}
          </span>
        )}
        {parts.length > 0 && (
          <span style={{ marginLeft: "auto", flexShrink: 0, color: "var(--text-dim)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
            {parts.join(" · ")}
          </span>
        )}
      </button>
      <div id={id} style={{ marginTop: open ? 8 : 0 }}>
        {open && children}
      </div>
    </div>
  );
}
