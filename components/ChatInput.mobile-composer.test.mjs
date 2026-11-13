import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";

/**
 * Mobil ist das Textfeld das unterste Element des Composers.
 *
 * Bei offener Tastatur sitzen die Leisten (Kontext-Anzeige, Anhaenger, Modell)
 * sonst zwischen Feld und Tastatur: ihr Abstand zum Feld ist der Versatz, den
 * der Nutzer als Springen sieht, und er aendert sich mit jeder Session-Laenge.
 * Geprueft wird die Reihenfolge, die der Browser malt (`order`), nicht die
 * Baum-Reihenfolge — die bleibt gleich, damit Desktop unberuehrt ist.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;

const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
globalThis.localStorage = localStorage;
win.localStorage = localStorage;

// Der letzte Fokus-Aufruf, den der Composer ausgeloest hat.
const focusCalls = [];
win.HTMLElement.prototype.focus = function focus(options) {
  focusCalls.push({ element: this, options });
};
win.HTMLTextAreaElement.prototype.setSelectionRange = function setSelectionRange(start, end) {
  this.selectionStart = start;
  this.selectionEnd = end;
};

// `isMobile` haengt an genau dieser Media-Query (hooks/useIsMobile.ts).
let mobile = true;
win.matchMedia = (query) => ({
  matches: mobile && query === "(max-width: 640px)",
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

globalThis.fetch = async (url) => {
  if (String(url).includes("/api/quick-phrases")) return { ok: true, json: async () => ({ phrases: [] }) };
  return { ok: true, json: async () => ({}) };
};

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");

const mounted = [];

async function mountInput(props = {}, withRef = false) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  const ref = withRef ? React.createRef() : null;
  const child = React.createElement(ChatInput, {
    ref,
    onSend() {},
    onAbort() {},
    modelList: [],
    modelNames: {},
    ...props,
  });
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, child));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return { container, ref };
}

test.afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  focusCalls.length = 0;
  mobile = true;
});

/** Die Bar ist das Element, in dem das Textfeld sitzt. */
function barOf(container) {
  const textarea = container.querySelector("textarea");
  assert.ok(textarea, "das Eingabefeld wurde gerendert");
  return textarea.parentElement;
}

/** Der Wrapper, in dem Feld und Leisten Geschwister sind. */
function stackOf(container) {
  const bar = barOf(container);
  const stack = bar.parentElement.parentElement;
  assert.ok(stack.contains(container.querySelector('[data-testid="composer-attach-file"]')));
  return stack;
}

/** Naechster Vorfahr, der eine `order` traegt (mobile) oder null. */
function orderedRowOf(from) {
  let node = from;
  while (node && !node.style?.order) node = node.parentElement;
  return node ?? null;
}

test("mobil malt der Browser das Textfeld als letztes Element", async () => {
  const { container } = await mountInput();
  const bar = barOf(container);
  const anchor = stackOf(container);

  assert.equal(anchor.style.display, "flex", "der Composer stapelt mobil");
  assert.equal(anchor.style.flexDirection, "column");
  assert.equal(bar.parentElement.style.order, "2", "das Feld wird zuletzt gemalt");

  const rows = [...anchor.children].filter((el) => el !== bar.parentElement && el.style.order !== "");
  assert.ok(rows.length >= 1, "die Leisten-Zeile steht vor dem Feld");
  for (const row of rows) {
    assert.equal(row.style.order, "1");
    assert.ok(Number(bar.parentElement.style.order) > Number(row.style.order), "keine Leiste nach dem Feld");
  }

  // Die Leisten-Zeile haengt ihre 8px jetzt unten statt oben an, damit der
  // Abstand zwischen ihr und dem Feld gleich bleibt.
  const attach = container.querySelector('[data-testid="composer-attach-file"]');
  const tools = orderedRowOf(attach);
  assert.ok(tools, "die Leisten-Zeile traegt eine order");
  assert.equal(tools.style.order, "1");
  assert.equal(tools.style.marginBottom, "8px");
  assert.equal(tools.style.marginTop, "", "kein doppelter Abstand");
});

test("mobil sind die Leisten weiterhin im Baum, nur anders geordnet", async () => {
  const { container } = await mountInput();
  const bar = barOf(container);
  const anchor = stackOf(container);
  // Baum-Reihenfolge bleibt: Feld zuerst, Leisten danach. Genau deshalb wird
  // ueber `order` gedreht statt ueber dupliziertes JSX.
  const children = [...anchor.children];
  const tools = orderedRowOf(container.querySelector('[data-testid="composer-attach-file"]'));
  assert.ok(children.indexOf(bar.parentElement) < children.indexOf(tools), "das Feld steht vor den Leisten im Baum");
});

test("desktop bleibt die Reihenfolge unveraendert", async () => {
  mobile = false;
  const { container } = await mountInput();
  const bar = barOf(container);
  const anchor = stackOf(container);
  assert.equal(bar.parentElement.style.order, "", "kein order auf dem Desktop");
  assert.equal(anchor.style.display, "", "der Composer bleibt ein Block");
  const attach = container.querySelector('[data-testid="composer-attach-file"]');
  assert.equal(orderedRowOf(attach), null, "keine order an der Leisten-Zeile");
});

test("der Fokus des Composers scrollt die Seite nicht", async () => {
  const { ref } = await mountInput({}, true);
  await act(async () => { ref.current.focus(); });
  assert.deepEqual(focusCalls.at(-1)?.options, { preventScroll: true });
});
