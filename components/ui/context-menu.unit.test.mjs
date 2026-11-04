import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";

/**
 * Das Kontextmenue ist ein Radix-Menue in einem Portal. Der Test faehrt die
 * echten Ereignisse, die linkedom kann: `contextmenu` oeffnet, `click` waehlt,
 * `keydown` mit Enter waehlt ebenfalls, und die drei Spezial-Eintraege melden
 * ihren neuen Zustand ueber ihren jeweiligen Rueckruf.
 *
 * `getBoundingClientRect` liefert in linkedom Nullen; daraus folgt nur die
 * Position des Portals, nicht ob es existiert. Die Position wird deshalb nicht
 * behauptet, die Beschriftung der Seite dagegen schon.
 */

const ROOT = process.cwd();
const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

/* Die Globals, die diese Datei ersetzt, gehoeren ihr nicht: `bun test` faehrt
 * alle Dateien in einem Prozess, und was hier stehen bleibt, sieht die
 * naechste Datei. Der Schnappschuss entsteht vor dem ersten Eingriff. */
const ORIGINALS = {
  window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
  getComputedStyle: globalThis.getComputedStyle, matchMedia: globalThis.matchMedia,
  localStorage: globalThis.localStorage, Event: globalThis.Event, EventTarget: globalThis.EventTarget,
  DOMRect: globalThis.DOMRect, NodeFilter: globalThis.NodeFilter,
};
test.after(() => {
  for (const [name, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["de-DE"], language: "de-DE", platform: "linux" };
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(target, prop) { return prop === "navigator" || Reflect.has(target, prop); },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.getComputedStyle = win.getComputedStyle;
globalThis.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } });
win.matchMedia = globalThis.matchMedia;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.DOMRect = class DOMRect {
  constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }); }
  static fromRect(rect = {}) { return new DOMRect(rect.x, rect.y, rect.width, rect.height); }
};

win.document.oninput = null;
win.document.onchange = null;
const { createRoot } = await import("react-dom/client");
const {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel,
  ContextMenuGroup, ContextMenuSeparator, ContextMenuCheckboxItem, ContextMenuRadioGroup,
  ContextMenuRadioItem, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
  ContextMenuShortcut, ContextMenuPortal,
} = await jiti.import(`${ROOT}/components/ui/context-menu.tsx`);

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); }); };

const pointer = (type, init = {}) => Object.assign(new win.Event(type, { bubbles: true, cancelable: true }), init);
const bySlot = (slot) => [...win.document.querySelectorAll(`[data-slot="${slot}"]`)];
const textOf = (element) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

function menu(log) {
  return React.createElement(ContextMenu, null,
    React.createElement(ContextMenuTrigger, null, "RECHTS"),
    React.createElement(ContextMenuContent, null,
      React.createElement(ContextMenuLabel, null, "Aktionen"),
      React.createElement(ContextMenuGroup, null,
        React.createElement(ContextMenuItem, { onSelect: () => log.push("item") },
          "Eins",
          React.createElement(ContextMenuShortcut, null, "Strg+E"),
        ),
        React.createElement(ContextMenuItem, { variant: "destructive", inset: true }, "Löschen"),
      ),
      React.createElement(ContextMenuSeparator),
      React.createElement(ContextMenuCheckboxItem, { checked: true, onCheckedChange: (next) => log.push(`check:${next}`) }, "Haken"),
      React.createElement(ContextMenuRadioGroup, { value: "a", onValueChange: (next) => log.push(`radio:${next}`) },
        React.createElement(ContextMenuRadioItem, { value: "a" }, "A"),
        React.createElement(ContextMenuRadioItem, { value: "b" }, "B"),
      ),
      React.createElement(ContextMenuSub, null,
        React.createElement(ContextMenuSubTrigger, null, "Mehr"),
        React.createElement(ContextMenuSubContent, null,
          React.createElement(ContextMenuItem, { onSelect: () => log.push("sub") }, "Unterpunkt"),
        ),
      ),
    ),
    // Ausserhalb des Inhalts: das Portal haengt sein Kind direkt an `body`,
    // unabhaengig davon, ob das Menue offen ist.
    React.createElement(ContextMenuPortal, null,
      React.createElement("span", { id: "portal-kind" }, "Portal-Inhalt"),
    ),
  );
}

async function mount(log) {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(menu(log)); });
  await flush();
  return { container, root };
}

async function openMenu(container) {
  const trigger = container.querySelector('[data-slot="context-menu-trigger"]');
  assert.ok(trigger, "der Trigger wurde nicht gerendert");
  await act(async () => {
    trigger.dispatchEvent(pointer("contextmenu", { clientX: 12, clientY: 20 }));
  });
  await flush();
  return trigger;
}

test("Rechtsklick oeffnet das Menue mit allen Bausteinen", async () => {
  const log = [];
  const { container, root } = await mount(log);
  const trigger = container.querySelector('[data-slot="context-menu-trigger"]');
  assert.equal(textOf(trigger), "RECHTS");
  // `select-none`: ein Rechtsklick soll keinen Text markieren.
  assert.match(trigger.getAttribute("class") ?? "", /select-none/);
  assert.equal(bySlot("context-menu-content").length, 0, "das Menue ist ohne Oeffnen schon da");

  await openMenu(container);

  const content = bySlot("context-menu-content")[0];
  assert.ok(content, "das Menue wurde durch den Rechtsklick nicht geoeffnet");
  assert.equal(bySlot("context-menu-label").length, 1);
  assert.equal(bySlot("context-menu-group").length, 1);
  assert.equal(bySlot("context-menu-separator").length, 1);
  // Zwei normale Eintraege, dazu der Untermenue-Eintrag im noch offenen Menue.
  assert.equal(bySlot("context-menu-item").length, 2);
  assert.match(textOf(content), /Aktionen/);
  assert.match(textOf(content), /Eins/);
  assert.match(textOf(content), /Strg\+E/);
  assert.match(textOf(content), /Haken/);
  assert.match(textOf(content), /A/);
  assert.match(textOf(content), /Mehr/);
  // Die Position rechnet floating-ui aus gemessener Geometrie; linkedom liefert
  // 0x0, deshalb ist hier die *Entscheidung* pruefbar, die Radix aus dem
  // Messergebnis als Datenschluessel ausgibt, nicht der Pixelwert. Die
  // Anchor-Variablen tragen die gemessene Groesse des Ausloesers weiter.
  assert.ok(["top", "right", "bottom", "left"].includes(content.getAttribute("data-side")));
  assert.match(content.getAttribute("style") ?? "", /--radix-context-menu-content-transform-origin/);
  assert.match(content.getAttribute("style") ?? "", /--radix-context-menu-trigger-width/);
  // Der destruktive Eintrag ist als solcher markiert.
  const destructive = bySlot("context-menu-item").find((item) => textOf(item) === "Löschen");
  assert.equal(destructive.getAttribute("data-variant"), "destructive");
  assert.equal(destructive.getAttribute("data-inset"), "true");
  await act(async () => { root.unmount(); });
});

test("ein Eintrag meldet seine Auswahl und schliesst das Menue", async () => {
  const log = [];
  const { root } = await mount(log);
  await openMenu(win.document.body);
  const item = bySlot("context-menu-item").find((entry) => textOf(entry).startsWith("Eins"));
  assert.ok(item);

  await act(async () => { item.click(); });
  await flush();

  assert.deepEqual(log, ["item"]);
  assert.equal(bySlot("context-menu-content").length, 0, "das Menue blieb nach der Auswahl offen");
  await act(async () => { root.unmount(); });
});

test("Enter auf einem Eintrag waehlt ihn, wie ein Klick", async () => {
  const log = [];
  const { root } = await mount(log);
  await openMenu(win.document.body);
  const item = bySlot("context-menu-item").find((entry) => textOf(entry).startsWith("Eins"));

  await act(async () => {
    item.dispatchEvent(pointer("keydown", { key: "Enter", code: "Enter" }));
  });
  await flush();

  assert.deepEqual(log, ["item"]);
  await act(async () => { root.unmount(); });
});

test("Haken und Radiogruppe melden den neuen Zustand", async () => {
  const log = [];
  const { root } = await mount(log);
  await openMenu(win.document.body);

  const checkbox = bySlot("context-menu-checkbox-item")[0];
  assert.ok(checkbox);
  assert.equal(checkbox.getAttribute("role"), "menuitemcheckbox");
  assert.equal(checkbox.getAttribute("aria-checked"), "true");
  await act(async () => { checkbox.click(); });
  await flush();
  assert.deepEqual(log, ["check:false"]);

  // Ein Haken schliesst das Menue in dieser Radix-Version, wie eine Auswahl.
  assert.equal(bySlot("context-menu-content").length, 0);
  await openMenu(win.document.body);

  const radioB = bySlot("context-menu-radio-item").find((entry) => textOf(entry) === "B");
  assert.ok(radioB);
  assert.equal(radioB.getAttribute("role"), "menuitemradio");
  assert.equal(bySlot("context-menu-radio-item")[0].getAttribute("aria-checked"), "true");
  await act(async () => { radioB.click(); });
  await flush();
  assert.deepEqual(log, ["check:false", "radio:b"]);
  await act(async () => { root.unmount(); });
});

test("der Untermenue-Trigger oeffnet sein eigenes Menue, der Eintrag waehlt", async () => {
  const log = [];
  const { root } = await mount(log);
  await openMenu(win.document.body);
  assert.equal(bySlot("context-menu-sub-content").length, 0, "das Untermenue ist ohne Klick schon offen");

  const subTrigger = bySlot("context-menu-sub-trigger")[0];
  assert.equal(subTrigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(subTrigger.getAttribute("aria-expanded"), "false");
  await act(async () => { subTrigger.click(); });
  await flush();

  assert.equal(subTrigger.getAttribute("aria-expanded"), "true");
  const subContent = bySlot("context-menu-sub-content")[0];
  assert.ok(subContent, "das Untermenue wurde nicht geoeffnet");
  const entry = [...subContent.querySelectorAll('[data-slot="context-menu-item"]')]
    .find((item) => textOf(item).includes("Unterpunkt"));
  assert.ok(entry, "der Eintrag des Untermenues fehlt");

  await act(async () => { entry.click(); });
  await flush();
  assert.deepEqual(log, ["sub"]);
  await act(async () => { root.unmount(); });
});

test("das Portal haengt seinen Inhalt an body, solange das Menue offen ist", async () => {
  const log = [];
  const { root } = await mount(log);
  assert.equal(win.document.getElementById("portal-kind"), null, "das geschlossene Menue rendert sein Portal");
  await openMenu(win.document.body);
  const portalChild = win.document.getElementById("portal-kind");
  assert.ok(portalChild, "der Portal-Inhalt wurde nicht gerendert");
  assert.equal(textOf(portalChild), "Portal-Inhalt");
  // Er liegt ausserhalb des gerenderten Containers — das ist der Zweck.
  assert.equal(portalChild.closest("[data-slot='context-menu-content']"), null);
  await act(async () => { root.unmount(); });
});
