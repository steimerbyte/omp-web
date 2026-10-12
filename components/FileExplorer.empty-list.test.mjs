import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Der Befund: `GET /api/files/<cwd>?type=list` liefert eine gefuellte
 * `entries`-Liste, die Oberflaeche zeigt trotzdem "No files found".
 *
 * Der Test fuettert `FileExplorer` mit DER Antwort, die die Route wirklich
 * liefert — eingefroren unter `REAL_API_RESPONSE`. Die Datei, die sie erzeugt,
 * steht im Kopf des Objekts; sie ist bewusst nicht von Hand gebaut, denn eine
 * handgebaute Antwort geht an dem Fehler vorbei, der genau hier zuschlaegt:
 * die Filterung greift auf ein Feld, das in einer handgebauten Minimalantwort
 * stillschweigend `undefined` ist und deshalb nichts entfernt.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

const computed = () => new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
});
win.getComputedStyle = computed;
win.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
  onchange: null,
  dispatchEvent() { return false; },
});

globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
for (const name of Object.keys(win)) {
  if (name === "window") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = win[name];
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.matchMedia = win.matchMedia;

// `react-dnd-html5-backend` (ueber `react-arborist`) baut beim Mount ein
// 1x1-`Image` fuer den Drag-Bereich. linkedom hat keins.
globalThis.Image = class {
  constructor() { this.src = ""; this.width = 1; this.height = 1; }
  set src(value) { this._src = value; }
  get src() { return this._src ?? ""; }
};

// linkedom kennt keine Custom Elements. `@pierre/diffs`, ueber
// `MarkdownBody` im Import-Graph des Explorers, registriert seine Elemente
// beim Laden und braucht dafuer `customElements.get`.
if (!globalThis.customElements) {
  globalThis.customElements = {
    registry: new Map(),
    get: (name) => globalThis.customElements.registry.get(name),
    define: (name, ctor) => { globalThis.customElements.registry.set(name, ctor); },
    whenDefined: () => Promise.resolve(),
    upgrade: () => {},
  };
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
win.localStorage = globalThis.localStorage;

// linkedom fuehrt kein Layout aus. `ExplorerTree` misst seine Hoehe und
// `react-window` virtualisiert danach; ohne diese Masse rendert der Baum null
// Zeilen — und der Test wuerde den Produktfehler mit dem Harness-Fehler
// verwechseln.
win.HTMLElement.prototype.getBoundingClientRect = function rect() {
  return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
};
Object.defineProperty(win.Element.prototype, "clientHeight", { get: () => 600, configurable: true });
Object.defineProperty(win.Element.prototype, "scrollHeight", { get: () => 600, configurable: true });
Object.defineProperty(win.Element.prototype, "scrollTop", { get: () => 0, set: () => {}, configurable: true });

/**
 * Die Antwort von `app/api/files/[...path]/route.ts`, unveraendert kopiert aus
 * `GET /api/files/home/steimerbyte/workspace?type=list` (HTTP 200). Erzeugt
 * von der Route aus `fs.readdirSync` mit `withFileTypes: true`, gefiltert ueber
 * `IGNORED_NAMES`/`IGNORED_SUFFIXES` und sortiert mit "Ordner zuerst, dann
 * alphabetisch".
 *
 * Die Zahlen stehen hier, weil sie den Befund erklaeren: 37 Eintraege
 * insgesamt, davon 9 mit fuehrendem Punkt, also 28 ohne. "28 sichtbar von 37"
 * ist keine Zaehlung der Oberflaeche, sondern diese Liste.
 */
const REAL_API_RESPONSE = {
  entries: [
    { name: ".atl", isDir: true, size: 0, modified: "" },
    { name: ".auto", isDir: true, size: 0, modified: "" },
    { name: ".omp", isDir: true, size: 0, modified: "" },
    { name: ".pi", isDir: true, size: 0, modified: "" },
    { name: ".playwright-cli", isDir: true, size: 0, modified: "" },
    { name: ".remnic", isDir: true, size: 0, modified: "" },
    { name: ".ruff_cache", isDir: true, size: 0, modified: "" },
    { name: "01_PROJEKTE", isDir: true, size: 0, modified: "" },
    { name: "A1_NEWS", isDir: true, size: 0, modified: "" },
    { name: "AGENT", isDir: true, size: 0, modified: "" },
    { name: "agentlock", isDir: true, size: 0, modified: "" },
    { name: "archive", isDir: true, size: 0, modified: "" },
    { name: "cancom-typst-template", isDir: true, size: 0, modified: "" },
    { name: "deep-research", isDir: true, size: 0, modified: "" },
    { name: "dgx-b300", isDir: true, size: 0, modified: "" },
    { name: "downloads", isDir: true, size: 0, modified: "" },
    { name: "dr-revalith", isDir: true, size: 0, modified: "" },
    { name: "forks", isDir: true, size: 0, modified: "" },
    { name: "google-cloud-sdk", isDir: true, size: 0, modified: "" },
    { name: "jupyter", isDir: true, size: 0, modified: "" },
    { name: "ki-hardware-research", isDir: true, size: 0, modified: "" },
    { name: "ki-workshop-html", isDir: true, size: 0, modified: "" },
    { name: "langflow", isDir: true, size: 0, modified: "" },
    { name: "moeve", isDir: true, size: 0, modified: "" },
    { name: "NV-TR", isDir: true, size: 0, modified: "" },
    { name: "pi-chrome", isDir: true, size: 0, modified: "" },
    { name: "shots", isDir: true, size: 0, modified: "" },
    { name: ".gitignore", isDir: false, size: 0, modified: "" },
    { name: ".zedignore", isDir: false, size: 0, modified: "" },
    { name: "benchmark_40toks.py", isDir: false, size: 0, modified: "" },
    { name: "confl.md", isDir: false, size: 0, modified: "" },
    { name: "confluence-api-research.md", isDir: false, size: 0, modified: "" },
    { name: "helm-kube-prometheus-stack.sh", isDir: false, size: 0, modified: "" },
    { name: "ki-workshop-html.zip", isDir: false, size: 0, modified: "" },
    { name: "LIVING-PROJECT.md", isDir: false, size: 0, modified: "" },
    { name: "lksjfdgh.md", isDir: false, size: 0, modified: "" },
    { name: "svs.txt", isDir: false, size: 0, modified: "" },
  ],
  path: "/home/steimerbyte/workspace",
};

// Sanity: die Fixture muss die Zahlen des Befundes tragen, sonst prueft der
// Test eine andere Liste als die gemeldete.
assert.equal(REAL_API_RESPONSE.entries.length, 37);
assert.equal(REAL_API_RESPONSE.entries.filter((e) => e.name.startsWith(".")).length, 9);
assert.equal(REAL_API_RESPONSE.entries.filter((e) => !e.name.startsWith(".")).length, 28);

/** Alles, was `FileExplorer` anfragt, wird beantwortet — nur die Liste zaehlt. */
const requestedUrls = [];
globalThis.fetch = async (url) => {
  const href = String(url);
  requestedUrls.push(href);
  if (href.includes("/type=list") || href.includes("?type=list")) {
    return { ok: true, status: 200, json: async () => REAL_API_RESPONSE };
  }
  if (href.includes("/api/git/status")) {
    return { ok: true, status: 200, json: async () => ({ isGitRepository: false, files: [] }) };
  }
  if (href.includes("/api/home")) {
    return { ok: true, status: 200, json: async () => ({ home: "/home/steimerbyte" }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { FileExplorer } = await jiti.import("./FileExplorer.tsx");

const ReactDOM = await import("react-dom/client");
const { act } = await import("react");

const CWD = "/home/steimerbyte/workspace";

/**
 * Baut den Explorer im DOM auf und wartet, bis der Ladeeffekt durch ist.
 * Der Rueckgabewert ist der gerenderte Text des Panels.
 */
const mountedRoots = [];

/**
 * Baut den Explorer im DOM auf und wartet, bis der Ladeeffekt durch ist.
 * Der Rueckgabewert ist der gerenderte Text des Panels.
 */
async function mountExplorer() {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(I18nProvider, null,
        React.createElement(FileExplorer, {
          cwd: CWD,
          onOpenFile: () => {},
          changesCollapsed: true,
        }),
      ),
    );
  });
  // Der Ladeeffekt laeuft ueber `useEffect`; zwei Runden reichen fuer
  // Mount -> Fetch -> setRoots -> Render des Baums.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  return container;
}

/**
 * `bun test` laesst alle Dateien in einem Prozess laufen. Ein nicht
 * abgemeldeter Explorer behaelt sein 5-Sekunden-Intervall, und dessen
 * `setState` landet nach `test.after`-Ende in einem Fenster, das der naechste
 * Test schon abgebaut hat — das erzeugt `window is not defined` in fremden
 * Dateien. Deshalb wird jeder Root am Ende seines Tests abgemeldet.
 */
test.after(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
});

test("a filled list response must produce rows, not \"No files found\"", async () => {
  const container = await mountExplorer();
  const text = container.textContent ?? "";

  assert.ok(
    !text.includes("No files found"),
    `Explorer showed "No files found" although the API delivered ${REAL_API_RESPONSE.entries.length} entries.\n` +
    `requested: ${JSON.stringify(requestedUrls)}\n` +
    `rendered: ${JSON.stringify(text.slice(0, 400))}`,
  );

  // Nicht nur die Abwesenheit der Meldung zaehlt: im Baum muss mindestens ein
  // echter Name stehen. Sonst waere der Test gruen, wenn die Komponente den
  // Explorer gar nicht rendert. Der Baum virtualisiert, deshalb wird gegen
  // die ERSTE Zeile der Antwort geprueft (`.atl`) und nicht gegen eine beliebige
  // — die spaeteren Zeilen sind je nach Fensterhoehe gar nicht im DOM.
  assert.ok(
    text.includes(".atl"),
    `Explorer rendered no file rows from a 37-entry response.\nrendered: ${JSON.stringify(text.slice(0, 400))}`,
  );
});

/**
 * DER BEFUND, unabhaengig vom 5-Sekunden-Takt messbar gemacht.
 *
 * Gemessen wurde: `GET /api/files/...?type=list` braucht auf dieser Maschine
 * 8,2 s (`curl -w '%{time_total}'`, 211 kB Antwort von `/api/sessions` am
 * selben Lauf). Der Ladeeffekt haengt an `treeRefreshKey`, und den erhoeht ein
 * `setInterval` alle 5 s. Jeder Takt raeumt den Effekt auf und setzt dessen
 * `cancelled`-Flag — auch dann, wenn die vorige Anfrage noch unterwegs war.
 * Eine Antwort, die nach dem Raumen eintrifft, wird verworfen. Weil jede
 * Anfrage laenger als der Takt dauert, verwirft der Effekt ausnahmslos jede
 * Antwort: `roots` bleibt `[]`, und die Zeile `roots.length === 0` rendert
 * "No files found" — bei einer API-Antwort mit 37 Eintraegen.
 *
 * Der Test simuliert genau das Verhaeltnis, ohne 5 s zu warten: die
 * Verzoegerung wird kleiner gesetzt, das Verhaeltnis Antwortzeit > Takt bleibt
 * aber. Das ist der Unterschied zwischen "langsam" und "kaputt": ein Geraet,
 * auf dem die Antwort in 400 ms kommt, zeigt Dateien und den Fehler nie.
 */
test("a list response slower than the refresh interval still reaches the tree", async () => {
  // Takt und Antwortzeit so veraendern, dass die Antwort garantiert nach dem
  // naechsten Takt eintrifft. 25 ms Takt, 90 ms Antwort. Klein genug, dass der
  // Test den Prozess nicht lange genug haelt, dass eine fremde, ungemeldete
  // React-Wurzel (`animationModeGating.test.mjs` raeumt seine Roots nicht ab)
  // ihren `setState` in eine andere Testdatei legt.
  const TICK_MS = 25;
  const RESPONSE_MS = 90;
  const realSetInterval = globalThis.setInterval;
  const realFetch = globalThis.fetch;
  globalThis.setInterval = (fn, ms, ...rest) =>
    (ms === 5000 ? realSetInterval(fn, TICK_MS, ...rest) : realSetInterval(fn, ms, ...rest));

  let listCalls = 0;
  let listSettled = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("type=list")) {
      listCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, RESPONSE_MS));
      // Gezaehlt wird die ANTWORT, nicht der Aufruf: gewartet wird unten auf
      // eingetroffene Antworten, sonst laeuft die Schleife schon weiter,
      // waehrend die dritte noch unterwegs ist.
      listSettled += 1;
      return { ok: true, status: 200, json: async () => REAL_API_RESPONSE };
    }
    if (href.includes("/api/git/status")) {
      return { ok: true, status: 200, json: async () => ({ isGitRepository: false, files: [] }) };
    }
    if (href.includes("/api/home")) {
      return { ok: true, status: 200, json: async () => ({ home: "/home/steimerbyte" }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  try {
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        React.createElement(I18nProvider, null,
          React.createElement(FileExplorer, { cwd: CWD, onOpenFile: () => {}, changesCollapsed: true })),
      );
    });

    // Statt fester Wartezeiten wird auf eine BEDINGUNG gewartet: mehrere
    // Listenantworten muessen eingetroffen sein, und danach muss der Baum
    // noch einmal rendern duerfen. Feste `setTimeout`-Runden sind unter
    // Last im Gesamtlauf zu kurz und machen den Test zu einem
    // Timing-Zufall — genau die Art Test, die gruen ist, bis es nicht mehr ist.
    const deadline = Date.now() + 15_000;
    while (listSettled < 3 && Date.now() < deadline) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    // Nach der letzten Antwort noch Zeit fuer `setRoots` und den Render.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });

    assert.ok(
      listSettled >= 3,
      `expected several settled list responses, got ${listSettled} within 15s`,
    );

    const text = container.textContent ?? "";
    assert.ok(
      !text.includes("No files found"),
      `Explorer showed "No files found" although the list resolved ${listCalls} times ` +
      `(every response slower than the ${TICK_MS}ms refresh tick).\n` +
      `rendered: ${JSON.stringify(text.slice(0, 300))}`,
    );
    assert.ok(
      text.includes(".atl"),
      `Explorer never rendered a row despite ${listCalls} successful list responses.\n` +
      `rendered: ${JSON.stringify(text.slice(0, 300))}`,
    );
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.fetch = realFetch;
  }
});