"use client";

import { ModalBackdrop, ModalPanel } from "@/components/motion/Enter";
import { Pressable } from "@/components/motion/Pressable";
import { useI18n } from "@/hooks/useI18n";
import type { ProjectView } from "@/lib/projects-schema";

/**
 * The delete confirmation.
 *
 * ### This is the convenience, not the protection
 *
 * The protection is `isProtectedProjectRoot`, enforced server-side in
 * `DELETE /api/projects/[...root]` *before* a single chat is touched. A protected
 * folder cannot be deleted from here even if this dialog were removed, bypassed
 * or never rendered — the request comes back with `code: "protected"` and
 * nothing happens.
 *
 * So the dialog is not asked "may I?". It is asked "are you sure?", and it
 * exists because a one-click recursive delete deserves a pause, not because the
 * code needs permission.
 */
export function ConfirmDialog({
  project,
  busy,
  onConfirm,
  onCancel,
}: {
  project: ProjectView;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();

  return (
    <ModalBackdrop
      onClick={busy ? undefined : onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, var(--bg-panel) 74%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 200,
      }}
    >
      <ModalPanel
        // Must not bubble to the backdrop, or pressing the confirm button
        // would also close the dialog it belongs to.
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-label={t("projects.delete.title")}
        style={{
          width: "100%",
          maxWidth: 430,
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
          {t("projects.delete.title")}
        </h2>

        <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t("projects.delete.body", { n: project.chatCount })}
        </div>

        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-dim)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "7px 9px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {project.root}
        </div>

        <div style={{ display: "flex", gap: 9, justifyContent: "flex-end" }}>
          <Pressable
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "7px 13px",
              fontSize: 12,
              borderRadius: 7,
              cursor: busy ? "default" : "pointer",
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontFamily: "inherit",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {t("common.cancel")}
          </Pressable>
          <Pressable
            onClick={onConfirm}
            disabled={busy}
            style={{
              padding: "7px 13px",
              fontSize: 12,
              fontWeight: 550,
              borderRadius: 7,
              cursor: busy ? "default" : "pointer",
              border: "1px solid var(--danger)",
              background: "var(--danger)",
              color: "var(--bg)",
              fontFamily: "inherit",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? t("projects.delete.working") : t("projects.delete.confirm")}
          </Pressable>
        </div>
      </ModalPanel>
    </ModalBackdrop>
  );
}