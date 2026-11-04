import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * `BranchNavigator` ist ein Baum aus Divs: die Zeilen tragen ihren Klick auf
 * einem `<div onClick>`, nicht auf einem Knopf, und der Inline-Modus misst
 * seinen Anker per `getBoundingClientRect`. Beides braucht ein gemountetes
 * DOM. Die Geometrie wird gestubbt (linkedom hat kein Layout) und ueber
 * `restoreLinkedomPrototypesOnExit` wieder abgegeben — linkedom teilt die
 * Prototypen prozessweit.
 *
 * Damit laufen die drei bisher ungedeckten Funktionen: `update` (der
 * Positions-Effekt), `TreeNodeView` und `getLabel`.
 */
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);
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
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null });
globalThis.matchMedia = win.matchMedia;
for (const [key, value] of Object.entries(linkedom)) {
  if (key !== "parseHTML" && key !== "default" && typeof value === "function" && /^[A-Z]/.test(key)) {
    globalThis[key] = value;
  }
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};
win.localStorage = globalThis.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { BranchNavigator } = await jiti.import("./BranchNavigator.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

const message = (id, role, content) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role, content },
});
const node = (entry, children = [], extra = {}) => ({ entry, children, ...extra });

const TREE = [
  node(message("u1", "user", "First question"), [
    node(message("a1", "assistant", [{ type: "text", text: "Answer one" }]), [
      node(message("u2", "user", "Branch A"), [
        node(message("a2", "assistant", "Answer A")),
      ]),
      node(message("u2b", "user", "Branch B"), [
        node(message("a2b", "assistant", "Answer B")),
      ]),
    ]),
  ]),
];

function reactProps(element) {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps"));
  assert.ok(key, "kein React-Props-Objekt am Knoten");
  return element[key];
}

async function mount(props) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(BranchNavigator, {
      tree: TREE,
      activeLeafId: null,
      onLeafChange() {},
      ...props,
    })));
  });
  return { container, root };
}

test("the inline dropdown positions itself on the anchor and lists both branches", async () => {
  // linkedom liefert 0x0; die Messung selbst ist gestubbt, damit die
  // Positionswerte unterscheidbar sind (top === bottom waere ein Fehler).
  win.Element.prototype.getBoundingClientRect = () => ({
    top: 40,
    bottom: 64,
    left: 12,
    right: 112,
    width: 100,
    height: 24,
    x: 12,
    y: 40,
    toJSON() { return this; },
  });
  const changes = [];
  const { container, root } = await mount({
    inline: true,
    open: true,
    hasSession: true,
    onLeafChange: (leafId) => changes.push(leafId),
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  const panel = container.querySelector('div[style*="position:fixed"]');
  assert.ok(panel, "der Inline-Dropdown ist absolut positioniert");
  assert.match(panel.getAttribute("style"), /top:64px/);
  assert.match(panel.getAttribute("style"), /left:12px/);
  assert.match(panel.getAttribute("style"), /width:100px/);

  assert.match(container.textContent, /Branch A/);
  assert.match(container.textContent, /Branch B/);
  // The assistant answer of the first arm is the representative that carries
  // the branch preview text; the user label is the preview, not the answer.
  assert.match(container.textContent, /U/);
  assert.match(container.textContent, /A/);

  // Eine Zeile ist ein div mit onClick — der Klick waehlt den Repraesentanten.
  const rows = [...container.querySelectorAll("div")].filter((element) => typeof reactProps(element).onClick === "function");
  assert.ok(rows.length >= 2, "mindestens eine Zeile je Wurzelast");
  await act(async () => {
    reactProps(rows[rows.length - 1]).onClick();
  });
  assert.equal(changes.length, 1);
  assert.ok(["a2b", "u2b"].includes(changes[0]), `leaf change ${changes[0]}`);
  await act(async () => { root.unmount(); });
});

test("the inline button toggles and reports its state", async () => {
  const toggles = [];
  const { container, root } = await mount({ inline: true, onToggle: () => toggles.push(1) });
  const button = container.querySelector("button");
  assert.ok(button);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  await act(async () => { reactProps(button).onClick(); });
  assert.equal(toggles.length, 1);

  const compact = await mount({ inline: true, compact: true, open: true });
  assert.doesNotMatch(compact.container.querySelector("button").textContent, /Branches/);
  await act(async () => { compact.root.unmount(); });
  await act(async () => { root.unmount(); });
});

test("without a session the panel explains why there is no branch", async () => {
  const { container, root } = await mount({ hasSession: false });
  const toggle = container.querySelector("button");
  await act(async () => { reactProps(toggle).onClick(); });
  assert.match(container.textContent, /No active session/);
  await act(async () => { root.unmount(); });
});

test("a linear session reports that there are no branches", async () => {
  const linear = [node(message("u1", "user", "Only"), [node(message("a1", "assistant", "One"))])];
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(BranchNavigator, {
      tree: linear,
      activeLeafId: "a1",
      onLeafChange() {},
      hasSession: true,
    })));
  });
  await act(async () => { reactProps(container.querySelector("button")).onClick(); });
  assert.match(container.textContent, /This session has no branches/);
  await act(async () => { root.unmount(); });
});

test("a compressed chain shows the skipped count and a non-message fallback label", async () => {
  const compressed = [
    node(message("u1", "user", "Root"), [
      node(message("a1", "assistant", "Answer"), [
        // First branch point: its children are the top-level rows.
        node(message("u2", "user", "A"), [
          node(message("a2", "assistant", "A2"), [
            node(message("a2b", "assistant", "A3")),
          ]),
        ]),
        node(message("u2b", "user", "B")),
      ]),
    ]),
  ];
  const { container, root } = await mount({ inline: true, open: true, tree: compressed, hasSession: true });
  assert.match(container.textContent, /\+2/); // u2 -> a2 -> a2b are two skipped links
  assert.match(container.textContent, /B/);

  // A chain with no message at all falls back to the entry type as label.
  const metadataOnly = [
    node(
      { type: "session_info", id: "s1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", name: "S" },
      [
        node(
          { type: "session_info", id: "s2", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", name: "S2" },
          [
            node({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "p", modelId: "m" }),
            node(message("u9", "user", "N")),
          ],
          { compressedEntryIds: [] },
        ),
      ],
    ),
  ];
  await act(async () => { root.unmount(); });
  const second = await mount({ inline: true, open: true, tree: metadataOnly, hasSession: true });
  assert.match(second.container.textContent, /model_change/);
  await act(async () => { second.root.unmount(); });
});
