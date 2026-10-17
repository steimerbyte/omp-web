"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi } from "@/lib/file-paths";
import type { TranslationParams } from "@/lib/i18n/types";
import {
  formatPresentBytes,
  type PresentFilesDetails,
  type PresentItem,
} from "@/lib/present-files";

/** The translator handed down to every card in the list. */
type Translate = (key: string, params?: TranslationParams) => string;

/**
 * The preview cards a `present_files` tool result turns into.
 *
 * Every link here is a plain `href` to the existing file routes, so each action
 * carries the request's own identity and goes through the same allow-list check
 * as the sidebar. That is the reason this component has no fetch and no
 * permission logic of its own: a card can offer an action, and the route
 * decides whether the account behind the click is allowed to have it. A tenant
 * whose card names a path it may not read gets a 403 from the route — which is
 * the correct answer, and a better one than a card that quietly hides buttons.
 *
 * Images, video and audio render inline because they can. Everything else opens
 * the preview dialog, which is served by `?type=read`, `?type=preview` (DOCX)
 * or `?type=download` depending on the kind.
 */

const INLINE_KINDS: Record<string, true> = { image: true, video: true, audio: true };

/** MIME per inline kind, for the `<video>`/`<audio>` elements. */
function inlineMime(item: PresentItem): string | undefined {
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
  const mimes: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp",
    ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
    m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac", opus: "audio/opus",
  };
  return mimes[ext];
}

/** The URL the preview button opens. DOCX has a dedicated renderer. */
function previewUrl(item: PresentItem): string {
  const base = `/api/files/${encodeFilePathForApi(item.abs)}`;
  return item.kind === "binary" || item.kind === "dir" ? `${base}?type=download` : `${base}?type=read`;
}

function downloadUrl(item: PresentItem): string {
  return `/api/files/${encodeFilePathForApi(item.abs)}?type=download`;
}

function PresentItemCard({ item, t }: { item: PresentItem; t: Translate }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const mime = inlineMime(item);
  const isInline = INLINE_KINDS[item.kind] === true && !previewFailed;

  return (
    <div
      data-present-item={item.abs}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--bg-subtle)",
      }}
    >
      <div style={{ padding: "8px 10px", display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={item.abs}
        >
          {item.name}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
          {item.kind === "dir" ? t("i18n.presentFilesDirectory") : formatPresentBytes(item.size)}
        </span>
      </div>

      {item.caption && (
        <div style={{ padding: "0 10px 6px", fontSize: 12, color: "var(--text-muted)" }}>
          {item.caption}
        </div>
      )}

      {isInline && item.kind === "image" && (
        <a href={previewUrl(item)} target="_blank" rel="noreferrer" style={{ display: "block" }}>
          {/* Dynamic local paths are served directly by the file API, which requires the
              browser's session cookie. next/image fetches server-side and anonymously. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/files/${encodeFilePathForApi(item.abs)}?type=read`}
            alt={item.caption ?? item.name}
            style={{ display: "block", width: "100%", maxHeight: 320, objectFit: "contain" }}
            onError={() => setPreviewFailed(true)}
          />
        </a>
      )}

      {isInline && item.kind === "video" && (
        <video
          controls
          src={`/api/files/${encodeFilePathForApi(item.abs)}?type=read`}
          style={{ display: "block", width: "100%", maxHeight: 320 }}
        />
      )}

      {isInline && item.kind === "audio" && (
        <audio
          controls
          src={`/api/files/${encodeFilePathForApi(item.abs)}?type=read`}
          style={{ width: "100%" }}
        />
      )}

      {!isInline && item.excerpt && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.45,
            maxHeight: 160,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--text-muted)",
          }}
        >
          {item.excerpt}
          {item.excerptTruncated && <span style={{ color: "var(--text-dim)" }}>{"\n…"}</span>}
        </pre>
      )}

      {!isInline && !item.excerpt && (
        <div style={{ padding: "0 10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
          {mime
            ? t("i18n.presentFilesNoInlinePreview")
            : t("i18n.presentFilesBinary")}
        </div>
      )}

      <div style={{ padding: "6px 10px 8px", display: "flex", gap: 6 }}>
        {!INLINE_KINDS[item.kind] && (
          <a
            href={previewUrl(item)}
            target="_blank"
            rel="noreferrer"
            style={linkStyle}
          >
            {t("i18n.presentFilesOpenPreview")}
          </a>
        )}
        <a href={downloadUrl(item)} style={linkStyle}>
          {t("i18n.presentFilesDownload")}
        </a>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(item.abs)}
          style={buttonStyle}
          title={item.abs}
        >
          {t("i18n.presentFilesCopyPath")}
        </button>
      </div>
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  color: "var(--text)",
  textDecoration: "none",
  background: "var(--bg-panel)",
  cursor: "pointer",
};

const buttonStyle: React.CSSProperties = { ...linkStyle, font: "inherit" };

export function PresentFiles({ details }: { details: PresentFilesDetails }) {
  const { t } = useI18n();
  return (
    <div data-present-files style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {details.title && (
        <div style={{ fontSize: 13, fontWeight: 600 }}>{details.title}</div>
      )}
      {details.note && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{details.note}</div>
      )}
      {details.items.map((item) => (
        <PresentItemCard key={item.abs} item={item} t={t} />
      ))}
    </div>
  );
}