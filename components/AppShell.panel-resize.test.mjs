import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// The unit contract of `resize()` is invisible in the type signature: it takes
// `number | string`, but the library parses the value the same way it parses
// `defaultSize`/`minSize`, and there a bare number means PIXELS. A percentage
// only survives as a `"%"` string. These tests pin that down, because the
// failure mode is silent — a wrong number is simply clamped away, and the
// symptom looks like "the arrow keys do nothing" or "my width is forgotten"
// rather than like a units bug.
const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

const resizeCalls = [...source.matchAll(/\b[a-zA-Z]+\.resize\(([\s\S]*?)\);/g)].map(
  (match) => match[1],
);

test("jeder resize()-Aufruf übergibt einen Prozent-String", () => {
  assert.ok(resizeCalls.length >= 3, `erwartet mindestens 3 resize-Aufrufe, gefunden: ${resizeCalls.length}`);
  for (const argument of resizeCalls) {
    assert.match(
      argument,
      /%`|%`|%\$/,
      `resize() bekommt "${argument}" — eine nackte Zahl bedeutet Pixel, nicht Prozent`,
    );
  }
});

test("die Pfeiltasten laufen in der Capture-Phase, nicht in der Bubble-Phase", () => {
  // The library registers a NATIVE keydown listener on the separator element
  // itself, which runs before React's bubble-phase handler at the root. In
  // bubble phase both paths fire and every press resizes twice. Capture plus
  // stopPropagation is the only way to keep the library from seeing the arrow
  // keys at all; there is no prop that disables only the keyboard.
  assert.match(source, /onKeyDownCapture: \(event: React\.KeyboardEvent<HTMLDivElement>\)/);
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(source, /onKeyDown=\{sidebarSeparatorKeys\.onKeyDown\}/);
  assert.doesNotMatch(source, /onKeyDown=\{fileSeparatorKeys\.onKeyDown\}/);
  assert.match(source, /onKeyDownCapture=\{sidebarSeparatorKeys\.onKeyDownCapture\}/);
  assert.match(source, /onKeyDownCapture=\{fileSeparatorKeys\.onKeyDownCapture\}/);
});

test("Home, End und Enter bleiben der Bibliothek überlassen", () => {
  // Only `Ot` answers them, so the capture handler must return early for
  // everything that is not one of the two arrow keys it claims.
  const handler = source.slice(
    source.indexOf("onKeyDownCapture: (event"),
    source.indexOf("function separatorArrowKeys") + 2000,
  );
  const earlyReturn = handler.indexOf("if (event.key !== growKey && event.key !== shrinkKey) return;");
  assert.ok(earlyReturn > -1, "Arrow-Key-Guard fehlt — sonst schluckt der Handler auch Home/End/Enter");
  assert.ok(earlyReturn < handler.indexOf("panel.resize"), "Der Guard muss vor dem resize stehen");
});

test("eine eingeklappte Datei-Tafel überschreibt die gemerkte Breite nicht mit 0", () => {
  // `collapse()` is a resize and reports 0. Storing that 0 makes the reopen
  // read 0 — `0 ?? 42` is 0, not 42 — so the panel comes back at nothing.
  // Measured on a 1600px row: 700px → close → reopen gives 700px only when the
  // writer guards; with the 0 stored it gives 0px.
  const writer = source.slice(
    source.indexOf("const handleFilePanelResize"),
    source.indexOf("const handleFilePanelResize") + 900,
  );
  const guardIndex = writer.indexOf("if (size.inPixels <= 0) return;");
  const storeIndex = writer.indexOf("lastPanelSizeRef.current[FILE_PANEL_ID] = size.asPercentage;");
  assert.ok(guardIndex > -1, "handleFilePanelResize muss den 0 aus collapse() abweisen");
  assert.ok(guardIndex < storeIndex, "Der Guard muss VOR dem Speichern stehen, sonst wird 0 gespeichert");
});