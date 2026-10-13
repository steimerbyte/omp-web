"use client";

/**
 * The diff surface, in its own module.
 *
 * This file is the only place `@pierre/diffs` is imported. The library and its
 * two Shiki themes are the single largest dependency in the app, and they are
 * only ever needed once someone opens the Diff tab. Keeping them here means
 * `FileViewer.tsx` can reach this module through `next/dynamic`, so webpack
 * puts it in its own chunk that the cold start never requests.
 */

import { useMemo } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, Virtualizer, type FileDiffOptions } from "@pierre/diffs/react";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";

/**
 * @pierre/diffs renders every file surface into an open shadow root, so app
 * level CSS cannot reach it and the umbrella theme in globals.css is inert
 * there. The `unsafeCSS` option is the library's escape hatch: it is injected
 * into that shadow root inside `@layer unsafe`, which outranks the `theme` and
 * `rendered` layers the library puts its own styles in. Because omp's palette
 * is plain inherited custom properties (`--bg`, `--danger`, …), the shadow root
 * resolves them against the host and follows light/dark switches with no
 * re-render and no duplicated palette.
 *
 * Every name below is verified against the library's own stylesheet
 * (`node_modules/@pierre/diffs/dist/style.js`): the `--*-override` variables are
 * what its derived `--diffs-*-base` custom properties fall back to, so setting
 * them wins over the colors the bundled Shiki theme would otherwise contribute.
 */
const DIFFS_UNSAFE_CSS = `
:host {
  display: block;
  background-color: var(--bg);
  color: var(--text);
  font-family: var(--font-mono);
  --diffs-font-family: var(--font-mono);
  --diffs-font-size: 13px;
  --diffs-bg: var(--bg);
  --diffs-fg: var(--text);
  --diffs-fg-number: var(--text-dim);
  --diffs-bg-context: var(--bg-panel);
  --diffs-bg-context-gutter: var(--bg-panel);
  --diffs-bg-separator: var(--bg-panel);
  --diffs-addition-color-override: var(--success);
  --diffs-deletion-color-override: var(--danger);
  --diffs-modified-color-override: var(--accent);
  --diffs-bg-selection-override: var(--bg-selected);
}
/* omp marks changed lines with a 3px bar on their leading edge. */
[data-line][data-line-type=change-addition] {
  box-shadow: inset 3px 0 0 var(--diffs-addition-base);
}
[data-line][data-line-type=change-deletion] {
  box-shadow: inset 3px 0 0 var(--diffs-deletion-base);
}
`;

/** Shiki themes carrying the diff foreground colors; omp's own palette is layered on top. */
const DIFFS_SHIKI_THEMES = { dark: "dark-plus", light: "github-light" } as const;

const DIFFS_BASE_OPTIONS: FileDiffOptions<undefined, undefined> = {
  diffStyle: "unified",
  diffIndicators: "classic",
  // Word level highlighting inside a changed line pair.
  lineDiffType: "word-alt",
  // Collapsed context rows with an "expand" control, replacing the hand-rolled
  // "… N unchanged lines …" dividers.
  hunkSeparators: "line-info",
  overflow: "scroll",
  disableFileHeader: true,
  theme: DIFFS_SHIKI_THEMES,
  unsafeCSS: DIFFS_UNSAFE_CSS,
};

function DiffView({ patch }: { patch: string }) {
  const { t } = useI18n();
  const { isDark } = useTheme();

  // `PatchDiff` would parse the same string but throws unless the patch holds
  // exactly one file diff, so parse it ourselves and render one surface per file.
  const fileDiffs = useMemo(() => {
    try {
      return parsePatchFiles(patch).flatMap((parsed) => parsed.files);
    } catch {
      return [];
    }
  }, [patch]);

  // Stable across renders: a fresh options object would make the library tear
  // down and rebuild the render cache on every commit.
  const options = useMemo<FileDiffOptions<undefined, undefined>>(() => ({
    ...DIFFS_BASE_OPTIONS,
    themeType: isDark ? "dark" : "light",
  }), [isDark]);

  if (fileDiffs.length === 0) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {t("i18n.noChanges")}
      </div>
    );
  }

  return (
    // The Virtualizer owns the scroll container, which is what lets the library
    // render only the visible window of a large file instead of all of it.
    <Virtualizer style={{ height: "100%", overflow: "auto" }}>
      {fileDiffs.map((fileDiff) => (
        <FileDiff key={fileDiff.name} fileDiff={fileDiff} options={options} />
      ))}
    </Virtualizer>
  );
}

export { DiffView };
