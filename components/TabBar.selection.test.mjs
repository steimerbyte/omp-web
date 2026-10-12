import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";

/**
 * Ziehen eines Tabs markiert keinen Text.
 *
 * Gemessen wird nicht die Klasse, sondern das Ergebnis: `getSelection()` ist
 * waehrend des Zugs leer. Der Test legt vorher absichtlich eine Markierung an
 * — sie entspricht dem realistischen Fall, in dem der Nutzer zuerst Text im
 * Fenster markiert hat und dann einen Tab zieht. Eine Markierung, die den
 * Zug ueberlebt, ist genau der Fehler, der hier behoben wurde.
 *
 * linkedom kennt keine Selection-API, deshalb wird eine gebaut, die das
 * Verhalten nachbildet: `toString()` liefert den Markierungstext,
 * `removeAllRanges()` leert ihn. Ohne diese Attrappe koennte der Test nicht
 * unterscheiden zwischen "keine Markierung" und "Markierung entfernt".
 *
 * Der zweite Teil des Verhaltens wird gegengeprueft: das Ziehen muss weiterhin
 * funktionieren. Ein Fix, der `onReorder` kappt, macht die Auswahl auch leer.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

// linkedom baut `window.navigator` bei jedem Zugriff neu; die i18n-Schicht liest
// `languages` beim Mounten. Deshalb der Proxy statt einer einfachen Zuweisung.
globalThis.window = new Proxy(dom.window, {
  get(target, prop, receiver) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = dom.document;
globalThis.navigator = fakeNavigator;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// motion liest nur den Startwert einer Property; alles wird inline gesetzt.
const computed = () => new Proxy({}, {
  get: (target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
});
globalThis.getComputedStyle = computed;
dom.window.getComputedStyle = computed;

for (const name of Object.keys(dom.window)) {
  if (name === "window") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = dom.window[name];
}
globalThis.Event = dom.window.Event;
globalThis.EventTarget = dom.window.EventTarget;

dom.window.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent() { return false; },
});
globalThis.matchMedia = dom.window.matchMedia;

// Ohne `scrollIntoView` bricht der Effekt, der den aktiven Tab sichtbar haelt.
dom.window.HTMLElement.prototype.scrollIntoView = function () {};

// Die Leiste vermisst ihre Kacheln ueber `getBoundingClientRect`; die Kacheln
// stehen gleich breit nebeneinander, 100px je Index.
const rects = new WeakMap();
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  const index = rects.get(this) ?? 0;
  const left = index * 100;
  return { left, right: left + 100, top: 0, bottom: 30, width: 100, height: 30, x: left, y: 0 };
};

const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
globalThis.localStorage = localStorage;
dom.window.localStorage = localStorage;

const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { TabBar } = await jiti.import("./TabBar.tsx");
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

/**
 * Die Selection-Attrappe. `text` ist, was der Nutzer markiert haette;
 * `removeAllRanges` leert es, so wie es der Browser tut.
 */
function installSelection(initialText) {
  const state = { text: initialText, cleared: 0 };
  const selection = {
    toString: () => state.text,
    rangeCount: state.text ? 1 : 0,
    removeAllRanges() { state.cleared += 1; state.text = ""; },
    empty: () => state.text === "",
  };
  dom.document.getSelection = () => selection;
  dom.window.getSelection = () => selection;
  globalThis.document.getSelection = () => selection;
  return state;
}

const TABS = [
  { kind: "file", id: "a", label: "alpha.ts", filePath: "/x/alpha.ts" },
  { kind: "file", id: "b", label: "beta.ts", filePath: "/x/beta.ts" },
  { kind: "file", id: "c", label: "gamma.ts", filePath: "/x/gamma.ts" },
];

async function mountTabBar({ onReorder } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const reordered = [];
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(TabBar, {
      tabs: TABS,
      activeTabId: "a",
      onSelectTab() {},
      onCloseTab() {},
      onReorder: onReorder ?? ((id, before) => reordered.push([id, before])),
    })));
  });
  // Die Kacheln sind die Wrapper um den Schliessen-Knopf; sie tragen die
  // Zeiger-Handler des Zugs.
  const tiles = [...host.querySelectorAll("[data-tab-close]")].map((button) => {
    const tile = button.parentElement;
    rects.set(tile, tiles_index(tile));
    return tile;
  });
  return { host, tiles, reordered };
}

let tileCounter = new WeakMap();
function tiles_index(tile) {
  const current = tileCounter.get(tile) ?? 0;
  tileCounter.set(tile, current + 1);
  return current;
}

/** Ein Zeigerzug von `fromX` nach `toX` ueber die erste Kachel. */
async function drag(tile, fromX, toX) {
  const pointer = (type, x) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { button: 0, pointerId: 1, clientX: x, clientY: 15 });
    return event;
  };
  await act(async () => { tile.dispatchEvent(pointer("pointerdown", fromX)); });
  await act(async () => { tile.dispatchEvent(pointer("pointermove", toX)); });
  return tile;
}

test("Ziehen loescht eine bestehende Textmarkierung", async () => {
  const selection = installSelection("alpha.ts beta.ts");
  const { tiles, reordered } = await mountTabBar();
  assert.equal(tiles.length, 3, "die drei Tabs wurden gerendert");

  await drag(tiles[0], 10, 90);
  await act(async () => {
    const up = new dom.window.Event("pointerup", { bubbles: true, cancelable: true });
    Object.assign(up, { button: 0, pointerId: 1, clientX: 90, clientY: 15 });
    tiles[0].dispatchEvent(up);
  });

  assert.equal(document.getSelection().toString(), "", "es ist noch Text markiert, waehrend gezogen wurde");
  assert.ok(selection.cleared > 0, "removeAllRanges wurde gar nicht aufgerufen");
  // Gegenprobe: der Zug hat wirklich stattgefunden. Ohne diese Zeile wuerde ein
  // Fix bestehen, der einfach jeden Zeigerzug verwirft.
  assert.deepEqual(reordered, [["a", ""]], "das Ziehen hat keine Umordnung gemeldet");
});

test("Die Griffkachel traegt select-none, solange sie einen Griff ist", async () => {
  // Ohne `select-none` beginnt `pointerdown` auf dem Beschriftungstext eine
  // Markierung, und `select-none` allein hilft nur gegen den Anfang.
  const { tiles } = await mountTabBar();
  assert.match(tiles[0].getAttribute("class"), /select-none/, "die ziehbare Kachel ist ohne select-none ausgeliefert");
});

test("Ohne onReorder bleibt die Leiste unveraendert", async () => {
  // `select-none` gehoert an den Griff. Ohne `onReorder` wird nicht gezogen,
  // und die Kachel soll ihre Markierbarkeit nicht verlieren.
  installSelection("");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(TabBar, {
      tabs: TABS,
      activeTabId: "a",
      onSelectTab() {},
      onCloseTab() {},
    })));
  });
  const tile = host.querySelector("[data-tab-close]").parentElement;
  assert.doesNotMatch(tile.getAttribute("class"), /select-none/, "eine Kachel ohne Griff ist nicht mehr markierbar");
});