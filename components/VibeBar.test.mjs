import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Warum hier Quelltext gelesen wird.
 *
 * Die Leiste ist reine Darstellung: sie haengt an `vibeStatus`, das der Server
 * ueber `get_state.vibe` liefert, und es gibt keine Geometrie zu messen. Was
 * schiefgehen kann, ist die Verdrahtung — eine Leiste, die auch im
 * ausgeschalteten Zustand steht, ein Composer, der das Tool-Preset waehrend
 * des Vibe-Modus trotzdem ueberschreibt. Genau das steht im Quelltext, und
 * fuenf andere Tests dieses Ordners lesen ihn aus demselben Grund
 * (`SubagentPanel.test.mjs`, `ChatWindow.process-details.test.mjs`, …).
 */

const windowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const inputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, { root: process.cwd() });
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const { deLocale } = await jiti.import("../lib/i18n/messages/de.ts");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");

/** Der Rumpf einer Funktion, von `function name` bis zur naechsten Top-Level-Definition. */
function bodyOf(source, name, until) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} nicht gefunden`);
  const end = source.indexOf(until, start);
  assert.notEqual(end, -1, `Ende von ${name} nicht gefunden`);
  return source.slice(start, end);
}

const vibeBar = bodyOf(windowSource, "VibeBar", "function ExtensionWidgets");

test("the bar renders only while vibe mode is enabled", () => {
  assert.match(vibeBar, /if \(!vibe\?\.enabled\) return null;/);
  assert.match(vibeBar, /t\("chat\.vibeLabel"\)/);
  assert.match(vibeBar, /\{vibe\.workers === 1 \? t\("chat\.vibeWorkerOne"\) : t\("chat\.vibeWorkers", \{ count: vibe\.workers \}\)\}/);
  assert.match(vibeBar, /t\("chat\.vibeReadOnly"\)/);
  // Kein eigenes CSS, keine Animation: die Leiste ist Chrome, nicht Bewegung.
  assert.doesNotMatch(vibeBar, /className=/);
  assert.doesNotMatch(vibeBar, /motion|animate/);
});

test("one worker is not rendered as \"1 workers\"", () => {
  // Die Zahl ist ein Platzhalter und kann im Deutschen wie im Chinesischen
  // hinter dem Nomen stehen; die Einzahl deshalb als eigener Schluessel.
  for (const [name, locale] of Object.entries({ en: enLocale, de: deLocale, "zh-CN": zhCNLocale })) {
    const one = locale.messages["chat.vibeWorkerOne"];
    const many = locale.messages["chat.vibeWorkers"];
    assert.ok(one, `${name} fehlt chat.vibeWorkerOne`);
    assert.doesNotMatch(one, /\{/, `${name}: die Einzahl traegt keinen Platzhalter`);
    assert.deepEqual(
      [...many.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]),
      ["count"],
      `${name}: die Mehrzahl traegt genau {count}`,
    );
  }
});

test("the width fight on a phone goes to the live worker count", () => {
  // The count is the live information: it keeps its width and still absorbs
  // the free space on desktop, so only the static hint can ellipsize.
  assert.match(vibeBar, /<span style=\{\{ flexGrow: 1, flexShrink: 0, whiteSpace: "nowrap", color: "var\(--text\)" \}\}>/);
  assert.match(vibeBar, /<span style=\{\{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var\(--text-dim\)" \}\}>/);
});

test("the chat window renders the bar beside the goal bar and tells the composer", () => {
  const goal = windowSource.indexOf("<GoalBar goal={goalStatus} t={t} />");
  const vibe = windowSource.indexOf("<VibeBar vibe={vibeStatus} t={t} />", goal);
  const widgets = windowSource.indexOf("<ExtensionWidgets widgets={belowEditorWidgets} />", vibe);
  assert.ok(goal !== -1 && vibe > goal && widgets > vibe, "GoalBar, VibeBar, ExtensionWidgets in dieser Reihenfolge");
  assert.match(windowSource, /vibeEnabled=\{Boolean\(vibeStatus\?\.enabled\)\}/);
  assert.match(windowSource, /vibeStatus,/);
});

test("the tool preset control is locked while vibe mode runs", () => {
  assert.match(inputSource, /vibeEnabled\?: boolean;/);
  assert.match(inputSource, /const toolPresetLocked = Boolean\(vibeEnabled\);/);
  assert.match(inputSource, /const toolPresetLabel = toolPresetLocked\s*\?\s*t\("chat\.vibeLabel"\)/);
  assert.match(inputSource, /disabled=\{isStreaming \|\| toolPresetLocked\}/);
  assert.match(inputSource, /onClick=\{\(\) => !toolPresetLocked && !isStreaming && setToolDropdownOpen/);
  // Ein bereits offenes Menue darf das Preset nicht mehr anbieten.
  assert.match(inputSource, /\{toolDropdownOpen && !toolPresetLocked && \(/);
});

test("the palette carries /vibe even before the server advertises it", () => {
  assert.match(inputSource, /\{ name: "vibe", descriptionKey: "chat\.commandVibe", source: "builtin" \}/);
});
