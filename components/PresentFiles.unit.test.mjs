import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * `PresentFiles` bildet ein `present_files`-Ergebnis auf Karten ab. Reine
 * Darstellung, also `renderToStaticMarkup`; das DOM braucht es erst fuer den
 * `onError`-Zweig (Bild faellt auf die Textansicht zurueck), der hier als
 * statisches Attribut nicht messbar ist.
 *
 * Die Funktionen `inlineMime`, `previewUrl`, `downloadUrl`, `PresentItemCard`
 * und `PresentFiles` laufen alle in diesem Render: `inlineMime` fuer jede
 * Karte, die URLs fuer jeden Link.
 */
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { PresentFiles } = await jiti.import("./PresentFiles.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function render(details) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(PresentFiles, { details })),
  );
}

const item = (overrides) => ({
  path: overrides.abs,
  abs: overrides.abs,
  name: overrides.abs.split("/").pop(),
  kind: "text",
  ...overrides,
});

test("renders a title, a note and every card in order", () => {
  const html = render({
    title: "Build artifacts",
    note: "Three files",
    items: [
      item({ abs: "/work/out/a.txt", size: 2048 }),
      item({ abs: "/work/out/b.md", size: 12 }),
    ],
  });

  assert.match(html, /Build artifacts/);
  assert.match(html, /Three files/);
  assert.match(html, /data-present-item="\/work\/out\/a\.txt"/);
  assert.match(html, /data-present-item="\/work\/out\/b\.md"/);
  assert.match(html, /2\.0 KB/);
  assert.match(html, /12 B/);
});

test("inline image, video and audio cards point at the read route and the MIME table", () => {
  const html = render({
    items: [
      item({ abs: "/work/pic.PNG", kind: "image" }),
      item({ abs: "/work/clip.mp4", kind: "video" }),
      item({ abs: "/work/song.flac", kind: "audio" }),
    ],
  });

  assert.match(html, /<a href="\/api\/files\/.*pic\.PNG\?type=read" target="_blank" rel="noreferrer" style="display:block">/);
  assert.match(html, /<img src="\/api\/files\/.*pic\.PNG\?type=read" alt="pic\.PNG"/);
  assert.match(html, /<video controls="" src="\/api\/files\/.*clip\.mp4\?type=read"/);
  assert.match(html, /<audio controls="" src="\/api\/files\/.*song\.flac\?type=read"/);
  // Inline kinds carry no "Preview" link — the media is the preview.
  assert.doesNotMatch(html, />Preview<\/a>/);
});

test("a text card shows its excerpt and a truncation marker", () => {
  const html = render({
    items: [
      item({ abs: "/work/log.txt", kind: "text", excerpt: "line one\nline two", excerptTruncated: true }),
      item({ abs: "/work/readme.md", kind: "markdown", excerpt: "# Title" }),
    ],
  });

  assert.match(html, /line one\nline two/);
  assert.match(html, /…/);
  assert.match(html, /# Title/);
  assert.match(html, /href="\/api\/files\/.*log\.txt\?type=read" target="_blank" rel="noreferrer"[^>]*>Preview<\/a>/);
});

test("binary and directory cards explain themselves and download", () => {
  const html = render({
    items: [
      item({ abs: "/work/archive.zip", kind: "binary", size: 99 }),
      item({ abs: "/work/docs", kind: "dir", name: "docs" }),
    ],
  });

  assert.match(html, /Binary file/);
  assert.match(html, />directory</);
  assert.match(html, /href="\/api\/files\/.*archive\.zip\?type=download"/);
  assert.match(html, /href="\/api\/files\/.*docs\?type=download"/);
  // A binary kind has no inline preview, so the card offers the preview link too.
  assert.match(html, /href="\/api\/files\/.*archive\.zip\?type=download" target="_blank" rel="noreferrer"[^>]*>Preview<\/a>/);
});

test("a known media MIME without an inline kind says so instead of pretending", () => {
  // The wording depends on whether `inlineMime` knows the extension: a png
  // whose kind is "binary" is a type that *could* be shown, a zip is not.
  const known = render({ items: [item({ abs: "/work/scan.png", kind: "binary" })] });
  const unknown = render({ items: [item({ abs: "/work/archive.zip", kind: "text" })] });

  assert.match(known, /No inline preview for this type\./);
  assert.doesNotMatch(unknown, /No inline preview for this type\./);
  assert.match(unknown, /Binary file — download to inspect\./);
  // Neither card lies about being inline.
  assert.doesNotMatch(known, /<img /);
  assert.doesNotMatch(unknown, /<img /);
});

test("a caption is shown on the card and becomes the image alt text", () => {
  const html = render({
    items: [item({ abs: "/work/shot.webp", kind: "image", caption: "Screenshot of the bug" })],
  });

  assert.match(html, /Screenshot of the bug/);
  assert.match(html, /alt="Screenshot of the bug"/);
});

test("the copy button carries the absolute path as its title", () => {
  const html = render({ items: [item({ abs: "/work/a.txt" })] });

  assert.match(html, /<button type="button" style="[^"]*" title="\/work\/a\.txt"/);
  assert.match(html, /Copy path/);
});
