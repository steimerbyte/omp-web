import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * `DiffView` reicht einen Patch an `@pierre/diffs` weiter. Die Bibliothek misst
 * Zeilenhoehen, also ist ohne Layout kein Pixel zu erwarten — aber der
 * Vertrag der Komponente ist pruefbar: leere oder unlesbare Patches ergeben
 * die "keine Aenderungen"-Meldung, ein lesbarer Patch ergibt die
 * Diff-Oberflaeche statt dieser Meldung. `parsePatchFiles` und der
 * `catch`-Zweig laufen dabei beide.
 */
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { DiffView } = await jiti.import("./DiffView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function render(patch) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(DiffView, { patch })),
  );
}

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
 const b = 3;
`;

test("an empty patch reports that there is nothing to show", () => {
  const html = render("");
  assert.match(html, /No changes/);
});

test("a malformed patch is not thrown out of the component", () => {
  const html = render("this is not a unified diff at all");
  assert.match(html, /No changes/);
});

test("a parsable patch renders the diff surface instead of the empty message", () => {
  const html = render(PATCH);
  assert.doesNotMatch(html, /No changes/);
  // The library renders into a host element; the file name is its identifier.
  assert.match(html, /data-|diffs-container|file-diff|<div/i);
});
