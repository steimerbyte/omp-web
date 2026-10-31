"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { UserSkill, UserSkillResponse, UserSkillsResponse } from "@/lib/api-types";
import { buildSkillCreationPrompt, buildSkillEditPrompt } from "@/lib/skill-prompts";

function shortenPath(value: string): string {
  // Not `~`: a tenant's home is not the process home the browser runs as, and
  // a `~` there would name the wrong directory. Keep the tail, which is what
  // distinguishes one skill store from another.
  const parts = value.split("/").filter(Boolean);
  return parts.length > 4 ? `…/${parts.slice(-3).join("/")}` : value;
}

function formatModified(locale: string, mtimeMs: number | null): string {
  if (mtimeMs === null) return "";
  return new Date(mtimeMs).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

/**
 * The skills manager: the caller's own store, one folder per skill.
 *
 * It deliberately does not reuse `SkillsConfig`: that panel answers "what does
 * a session see from every source" and is read-only by design. This view
 * answers "which skills are mine" and writes them. The vocabulary (list on the
 * left, detail on the right, an accent dot per row, `var(--bg-panel)` behind
 * the list) is the same, so the two read as one product.
 */
export function SkillsManagerView({
  cwd,
  onNewSkill,
  onEditWithAi,
}: {
  cwd: string | null;
  onNewSkill: (prompt: string) => void;
  onEditWithAi: (prompt: string) => void;
}) {
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();

  const [data, setData] = useState<UserSkillsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserSkillResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailKey, setDetailKey] = useState(0);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const dirty = detail !== null && content !== savedContent;

  const loadList = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/skills/user", { cache: "no-store" });
      const body = (await response.json()) as UserSkillsResponse & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      setData(body);
      setSelected((current) => {
        if (current && body.skills.some((skill) => skill.name === current)) return current;
        return body.skills[0]?.name ?? null;
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    setSaveError(null);
    setSavedNotice(false);
    fetch(`/api/skills/user/${encodeURIComponent(selected)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as UserSkillResponse & { error?: string };
        if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (seq !== requestSeq.current) return;
        setDetail(body);
        setContent(body.content);
        setSavedContent(body.content);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (seq !== requestSeq.current) return;
        setDetail(null);
        setDetailError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (seq === requestSeq.current) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selected, detailKey]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const selectSkill = (name: string) => {
    if (name === selected) return;
    if (dirty) {
      setPendingName(name);
      return;
    }
    setSelected(name);
  };

  const confirmSwitch = () => {
    if (!pendingName) return;
    setSelected(pendingName);
    setPendingName(null);
  };

  const save = async () => {
    if (!detail || saving) return;
    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      const response = await fetch(`/api/skills/user/${encodeURIComponent(detail.skill.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, expectedMtimeMs: detail.skill.mtimeMs }),
      });
      const body = (await response.json()) as {
        skill?: UserSkill;
        error?: string;
      };
      if (!response.ok || !body.skill) {
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const saved = body.skill;
      setDetail({ skill: saved, content });
      setSavedContent(content);
      setSavedNotice(true);
      setData((current) => current && {
        ...current,
        skills: current.skills.map((skill) => (skill.name === saved.name ? saved : skill)),
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!detail || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/skills/user/${encodeURIComponent(detail.skill.name)}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      setDeleteOpen(false);
      setSelected(null);
      setDetail(null);
      setContent("");
      setSavedContent("");
      await loadList();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  const canStartChat = Boolean(cwd);
  const newSkillPrompt = useMemo(
    () => (data ? buildSkillCreationPrompt(locale, data.directory) : ""),
    [data, locale],
  );
  const skills = data?.skills ?? [];
  const problems = detail?.skill.diagnostics ?? [];

  const listRow = (skill: UserSkill) => {
    const active = skill.name === selected;
    const badge = skill.diagnostics.length;
    return (
      <button
        key={skill.name}
        type="button"
        onClick={() => selectSkill(skill.name)}
        title={skill.diagnostics.map((diagnostic) => diagnostic.message).join("\n") || undefined}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 7,
          width: "100%",
          padding: "8px",
          borderRadius: 5,
          border: "none",
          textAlign: "left",
          cursor: "pointer",
          background: active ? "var(--bg-selected)" : "none",
          color: "var(--text)",
          fontFamily: "inherit",
        }}
        onMouseEnter={(event) => {
          if (!active) event.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(event) => {
          if (!active) event.currentTarget.style.background = "none";
        }}
      >
        <span
          aria-hidden="true"
          style={{
            flexShrink: 0,
            marginTop: 5,
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: badge > 0 ? "#d97706" : "var(--accent)",
            boxShadow: badge > 0 ? "none" : "0 0 4px var(--accent)",
          }}
        />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 12,
              fontWeight: active ? 600 : 400,
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {skill.name}
            {badge > 0 && (
              <span
                aria-label={`${t("skills.problem")}: ${badge}`}
                style={{ color: "#d97706", fontSize: 11, flexShrink: 0 }}
              >
                ⚠
              </span>
            )}
          </span>
          <span
            style={{
              marginTop: 2,
              fontSize: 11,
              lineHeight: 1.35,
              color: "var(--text-dim)",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {skill.description || (skill.hasSkillFile ? t("skills.noDescription") : t("skills.emptyFolder"))}
          </span>
          <span
            style={{
              display: "block",
              marginTop: 3,
              fontSize: 10,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {skill.source === "native:user" ? "user" : "custom"}
            {skill.mtimeMs !== null ? ` · ${formatModified(locale, skill.mtimeMs)}` : ""}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 18px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
            {t("skills.title")}
          </span>
          {data && (
            <code
              title={data.directory}
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                maxWidth: 320,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {shortenPath(data.directory)}
            </code>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setDetailKey((key) => key + 1)}
            title={dirty ? t("skills.dirty") : t("skills.reload")}
            aria-label={t("skills.reload")}
            style={{
              width: 30,
              height: 30,
              borderRadius: 7,
              border: "1px solid var(--border)",
              background: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            ↻
          </button>
          <button
            type="button"
            onClick={() => onNewSkill(newSkillPrompt)}
            disabled={!data || !canStartChat}
            title={canStartChat ? t("skills.new") : t("skills.needProject")}
            style={{
              padding: "6px 12px",
              borderRadius: 7,
              border: "1px solid var(--border)",
              background: "none",
              color: canStartChat ? "var(--text)" : "var(--text-dim)",
              cursor: canStartChat ? "pointer" : "not-allowed",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            + {t("skills.new")}
          </button>
        </div>
      </div>

      {data && data.diagnostics.length > 0 && (
        <div
          role="status"
          style={{
            padding: "8px 18px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <strong style={{ color: "#d97706" }}>{t("skills.storeProblem")}: </strong>
          {data.diagnostics.map((diagnostic) => diagnostic.message).join(" · ")}
        </div>
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", minHeight: 0 }}>
        <div
          style={{
            width: isMobile ? "100%" : 270,
            maxHeight: isMobile ? "38vh" : undefined,
            borderRight: isMobile ? "none" : "1px solid var(--border)",
            borderBottom: isMobile ? "1px solid var(--border)" : "none",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
            background: "var(--bg-panel)",
            overflowY: "auto",
          }}
        >
          <div style={{ padding: "8px 6px" }}>
            {loading ? (
              <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                {t("i18n.loading")}
              </div>
            ) : loadError ? (
              <div role="alert" style={{ padding: "10px 8px", fontSize: 11, color: "#f87171" }}>
                {t("skills.loadFailed")} {loadError}
              </div>
            ) : skills.length === 0 ? (
              <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                {t("i18n.noSkills")}
              </div>
            ) : (
              skills.map(listRow)
            )}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: isMobile ? 14 : 20 }}>
          {pendingName !== null && (
            <div
              role="alert"
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 10,
                marginBottom: 14,
                padding: "10px 12px",
                borderRadius: 7,
                border: "1px solid rgba(217,119,6,0.5)",
                background: "rgba(217,119,6,0.08)",
                fontSize: 12,
              }}
            >
              <span style={{ flex: 1 }}>{t("skills.discardSwitch")}</span>
              <button type="button" onClick={confirmSwitch} style={smallButton}>
                {t("skills.switchConfirm")}
              </button>
              <button type="button" onClick={() => setPendingName(null)} style={smallButton}>
                {t("common.cancel")}
              </button>
            </div>
          )}

          {!loading && skills.length === 0 && !detailError && !loadError ? (
            <div
              style={{
                maxWidth: 560,
                margin: "8vh auto 0",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{t("skills.emptyTitle")}</h2>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--text-muted)" }}>
                {t("skills.emptyBody")}
              </p>
              <button
                type="button"
                onClick={() => onNewSkill(newSkillPrompt)}
                disabled={!data || !canStartChat}
                title={canStartChat ? t("skills.new") : t("skills.needProject")}
                style={{
                  padding: "8px 14px",
                  borderRadius: 7,
                  border: "1px solid var(--accent)",
                  background: "var(--bg-selected)",
                  color: "var(--accent)",
                  cursor: canStartChat ? "pointer" : "not-allowed",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                + {t("skills.new")}
              </button>
              <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)" }}>
                {t("skills.emptyHint")} {t("skills.reloadHint")}
              </p>
            </div>
          ) : detailError ? (
            <div role="alert" style={{ fontSize: 12, color: "#f87171" }}>
              {detailError}
            </div>
          ) : detailLoading ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
          ) : detail ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: 17,
                      fontWeight: 700,
                      fontFamily: "var(--font-mono)",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {detail.skill.name}
                  </h2>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      marginTop: 4,
                      fontSize: 11,
                      color: "var(--text-dim)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    <span>{detail.skill.source}</span>
                    <span title={detail.skill.filePath}>{shortenPath(detail.skill.filePath)}</span>
                    {detail.skill.mtimeMs !== null && (
                      <span>{formatModified(locale, detail.skill.mtimeMs)}</span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => onEditWithAi(buildSkillEditPrompt(locale, detail.skill.filePath))}
                    disabled={!canStartChat}
                    title={canStartChat ? t("skills.editWithAi") : t("skills.needProject")}
                    style={{
                      ...smallButton,
                      color: canStartChat ? "var(--accent)" : "var(--text-dim)",
                      cursor: canStartChat ? "pointer" : "not-allowed",
                    }}
                  >
                    {t("skills.editWithAi")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteError(null);
                      setDeleteOpen(true);
                    }}
                    style={{ ...smallButton, color: "#f87171" }}
                  >
                    {t("skills.delete")}
                  </button>
                </div>
              </div>

              {problems.length > 0 && (
                <div
                  role="status"
                  style={{
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid rgba(217,119,6,0.45)",
                    background: "rgba(217,119,6,0.07)",
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  <strong style={{ color: "#d97706" }}>{t("skills.problem")}: </strong>
                  {problems.map((diagnostic) => diagnostic.message).join(" · ")}
                </div>
              )}

              {!detail.skill.hasSkillFile && (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("skills.emptyFolder")}</div>
              )}

              <textarea
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  setSavedNotice(false);
                }}
                spellCheck={false}
                aria-label="SKILL.md"
                style={{
                  width: "100%",
                  minHeight: 420,
                  resize: "vertical",
                  padding: 12,
                  borderRadius: 7,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  lineHeight: 1.55,
                }}
              />

              {saveError && (
                <div role="alert" style={{ fontSize: 12, color: "#f87171" }}>
                  {t("skills.saveFailed")} {saveError}{" "}
                  {saveError.includes("changed on disk") && (
                    <button type="button" onClick={() => setDetailKey((key) => key + 1)} style={linkButton}>
                      {t("skills.reload")}
                    </button>
                  )}
                </div>
              )}
              {savedNotice && (
                <div role="status" style={{ fontSize: 12, color: "var(--accent)" }}>
                  {t("skills.saved")}
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!dirty || saving}
                  style={{
                    ...primaryButton,
                    opacity: !dirty || saving ? 0.5 : 1,
                    cursor: !dirty || saving ? "not-allowed" : "pointer",
                  }}
                >
                  {saving ? t("skills.saving") : t("skills.save")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setContent(savedContent);
                    setSaveError(null);
                    setSavedNotice(false);
                  }}
                  disabled={!dirty || saving}
                  style={{
                    ...smallButton,
                    opacity: !dirty || saving ? 0.5 : 1,
                    cursor: !dirty || saving ? "not-allowed" : "pointer",
                  }}
                >
                  {t("skills.discard")}
                </button>
                {dirty && (
                  <span style={{ fontSize: 11, color: "#d97706" }}>{t("skills.dirty")}</span>
                )}
              </div>
            </div>
          ) : (
            <div
              style={{
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-dim)",
                fontSize: 13,
              }}
            >
              {t("skills.select")}
            </div>
          )}
        </div>
      </div>

      {deleteOpen && detail && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("skills.deleteTitle", { name: detail.skill.name })}
          onClick={(event) => {
            if (event.target === event.currentTarget && !deleting) setDeleteOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.45)",
            padding: 16,
          }}
        >
          <div
            style={{
              width: 420,
              maxWidth: "100%",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              boxShadow: "0 8px 32px rgba(0,0,0,0.28)",
            }}
          >
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
              {t("skills.deleteTitle", { name: detail.skill.name })}
            </h3>
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: "var(--text-muted)" }}>
              {t("skills.deleteBody")}
            </p>
            {deleteError && (
              <div role="alert" style={{ fontSize: 12, color: "#f87171" }}>
                {t("skills.deleteFailed")} {deleteError}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                autoFocus
                onClick={() => setDeleteOpen(false)}
                disabled={deleting}
                style={smallButton}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                style={{
                  padding: "6px 12px",
                  borderRadius: 7,
                  border: "1px solid rgba(248,113,113,0.6)",
                  background: "rgba(248,113,113,0.12)",
                  color: "#f87171",
                  cursor: deleting ? "wait" : "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {deleting ? t("skills.deleting") : t("skills.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const smallButton: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
};

const primaryButton: CSSProperties = {
  padding: "7px 16px",
  borderRadius: 7,
  border: "1px solid var(--accent)",
  background: "var(--bg-selected)",
  color: "var(--accent)",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
};

const linkButton: CSSProperties = {
  padding: 0,
  border: "none",
  background: "none",
  color: "var(--accent)",
  cursor: "pointer",
  fontSize: 12,
  textDecoration: "underline",
};
