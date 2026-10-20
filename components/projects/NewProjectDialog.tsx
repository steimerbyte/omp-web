"use client";

import { useState } from "react";
import { ModalBackdrop, ModalPanel } from "@/components/motion/Enter";
import { Pressable } from "@/components/motion/Pressable";
import { useI18n } from "@/hooks/useI18n";
import { PRIORITY_IDS, type PriorityDef, type PriorityColorValue, type PriorityId } from "@/lib/projects-schema";

/**
 * Create a project: a name, a category, and nothing else.
 *
 * ### The folder is the project
 *
 * That is the decision this dialog exists to express. Creating a project
 * creates a folder under `<home>/workspace/<name>`, and deleting it removes
 * that folder. The dialog says so in as many words, because the alternative —
 * a registry entry pointing at a folder that already existed — cannot make that
 * promise.
 *
 * ### The name is validated before it is sent
 *
 * The folder name becomes a path segment, so anything that could escape
 * `<home>/workspace` is refused here: a slash, a `..`, a leading dash, and
 * anything outside kebab-case. The server normalizes and re-checks regardless;
 * this is about telling the user *now* rather than after a round trip.
 *
 * `~/workspace` and not a free-chosen parent: one rule is one thing to explain
 * and one thing to audit.
 */
export function NewProjectDialog({
  home,
  priorities,
  busy,
  onSubmit,
  onCancel,
}: {
  home: string;
  priorities: readonly PriorityDef[];
  busy: boolean;
  onSubmit: (input: { name: string; priority: PriorityId; initGit: boolean }) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [priority, setPriority] = useState<PriorityId>("later");
  const [initGit, setInitGit] = useState(true);

  const trimmed = name.trim();
  const invalid = trimmed !== "" && !isValidFolderName(trimmed);
  const canSubmit = !busy && trimmed !== "" && !invalid;

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
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("projects.new")}
        style={{
          width: "100%",
          maxWidth: 430,
          borderRadius: 12,
          border: "1px solid var(--border)",
          background: "var(--bg)",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 620, color: "var(--text)" }}>
          {t("projects.new")}
        </h2>

        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("projects.create.lede")}{" "}
          <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
            {home}/workspace/
          </code>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <label htmlFor="omp-project-name" style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {t("projects.create.name")}
          </label>
          <input
            id="omp-project-name"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            placeholder={t("projects.create.namePlaceholder")}
            style={{
              padding: "8px 10px",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              color: "var(--text)",
              background: "var(--bg-panel)",
              border: `1px solid ${invalid ? "var(--danger)" : "var(--border)"}`,
              borderRadius: 7,
              outline: "none",
            }}
          />
          {invalid ? (
            <span style={{ fontSize: 11, color: "var(--danger)" }}>{t("projects.create.nameInvalid")}</span>
          ) : (
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("projects.create.nameHelp")}</span>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("projects.create.priority")}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PRIORITY_IDS.map((id) => {
              const def = priorities.find((entry) => entry.id === id);
              const selected = priority === id;
              return (
                <Pressable
                  key={id}
                  onClick={() => setPriority(id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px",
                    fontSize: 12,
                    borderRadius: 999,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                    background: selected ? "var(--bg-hover)" : "var(--bg)",
                    color: selected ? "var(--text)" : "var(--text-muted)",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: (def?.colorValue ?? "var(--text-dim)") as PriorityColorValue,
                    }}
                  />
                  {def?.name ?? id}
                </Pressable>
              );
            })}
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>
          <input type="checkbox" checked={initGit} onChange={(event) => setInitGit(event.target.checked)} />
          {t("projects.create.initGit")}
        </label>

        <div
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--text-muted)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            padding: "9px 11px",
          }}
        >
          {t("projects.create.deleteNote")}
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
            onClick={() => onSubmit({ name: trimmed, priority, initGit })}
            disabled={!canSubmit}
            style={{
              padding: "7px 13px",
              fontSize: 12,
              fontWeight: 550,
              borderRadius: 7,
              cursor: canSubmit ? "pointer" : "default",
              border: "1px solid var(--accent)",
              background: "var(--accent)",
              color: "var(--bg)",
              fontFamily: "inherit",
              opacity: canSubmit ? 1 : 0.5,
            }}
          >
            {busy ? t("projects.create.working") : t("projects.create.submit")}
          </Pressable>
        </div>
      </ModalPanel>
    </ModalBackdrop>
  );
}

/**
 * Kebab-case, no traversal, no leading dash.
 *
 * The name becomes a directory name under `<home>/workspace`, so `/`, `\`, `.`
 * and a leading `-` are all refused. The check is deliberately strict: a
 * project folder has no legitimate reason to contain a slash, and refusing the
 * whole class here is cheaper than sanitising the names that slip through.
 */
export function isValidFolderName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false;
  if (name.startsWith("-")) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}