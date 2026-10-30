import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Der Anlegen-Dialog ueberlebt die echte Antwort von `/api/models`.
 *
 * ### Was dieser Test gefangen haette
 *
 * `TaskDialog` las `body.models` und rief `.map` darauf. `models` ist in der
 * Antwort von `/api/models` aber eine **Zuordnung** `"provider:id" → Name`
 * (`lib/models-cache.ts:ModelsData`); die Liste mit Provider-Angabe heisst
 * `modelList`. Im echten Browser war das ein `TypeError: (S ?? []).map is not
 * a function` mitten im Commit: React verwarf den Baum, und die ganze App
 * wurde durch Next' globale Fehlerseite ersetzt ("This page couldn't load") —
 * gemessen an v0.14.0, sobald der Dialog mit einem angemeldeten Konto aufging.
 *
 * Eine Pruefung des Quelltextes faengt das nicht: `body.models ?? []` sieht
 * richtig aus, und der Fehler entsteht erst, wenn ein Objekt durch `.map`
 * laeuft. Deshalb wird hier die echte Komponente gemountet und der echte
 * Dialog geoeffnet, mit der echten Antwortform — und danach wird die
 * Modellauswahl gelesen, nicht der Zustand.
 *
 * ### Warum die Form aus dem Repo und nicht von Hand kommt
 *
 * `ModelsData` liegt hinter dem omp-SDK (`lib/models-cache.ts` importiert
 * `@oh-my-pi/*`), also wird die Nutzlast hier als Literal nachgebaut — mit
 * beiden Feldern in der Form, die der Typ nennt. Der Test prueft damit die
 * Aufteilung, die der Fehler verwechselt hat.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

// Radix fragt beim Einrasten die Scrollbar-Breite ueber `getComputedStyle` ab;
// linkedom fuehrt kein Layout aus und liefert sonst einen TypeError, bevor
// der Dialog ueberhaupt mountet.
win.getComputedStyle = () => new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
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

win.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
  onchange: null,
  dispatchEvent() { return false; },
});
globalThis.matchMedia = win.matchMedia;

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
};

/**
 * Die Antwort von `/api/models`, in der Form aus `ModelsData`.
 *
 * `models` ist die Zuordnung und `modelList` die Liste — genau die
 * Unterscheidung, die der Dialog verwechselt hat. Beide stehen hier, weil ein
 * Test mit nur einem der beiden Felder den Fehler nicht reproduziert: mit
 * fehlendem `models` lieferte `?? {}` ein Objekt, das ebenso wenig `.map`
 * hat, aber mit fehlendem `modelList` haette die kaputte Zeile `undefined`
 * gesehen und still eine leere Auswahl gezeigt.
 */
const MODELS_RESPONSE = {
  models: {
    "buds-gateway/qwen3.8-27b": "Qwen 3.8 27B",
    "buds-gateway/deepseek-v4.1-flash-1017": "DeepSeek V4.1 Flash",
  },
  modelList: [
    { id: "qwen3.8-27b", name: "Qwen 3.8 27B", provider: "buds-gateway" },
    { id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", provider: "buds-gateway" },
  ],
  defaultModel: { provider: "buds-gateway", modelId: "deepseek-v4.1-flash-1017" },
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
  roles: [],
};

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});

// Scoped and put back afterwards: `lib/http-dispatcher.ts` snapshots
// `globalThis.fetch` when it loads (see `DialogFocus.test.mjs`).
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  if (url.startsWith("/api/models")) return json(MODELS_RESPONSE);
  if (url.startsWith("/api/scheduled-tasks")) return json({ tasks: [] });
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
};
test.after(() => { globalThis.fetch = originalFetch; });

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { ScheduledTasksView } = await jiti.import("./ScheduledTasksView.tsx");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
}

async function mountView() {
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(I18nProvider, null, React.createElement(ScheduledTasksView, null))); });
  await settle();
  return { root, container };
}

/** Ein Knopf nach seinem Text; die Beschriftung kommt aus dem Sprachpaket. */
function buttonByText(text) {
  return [...win.document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text);
}

test("Der Anlegen-Dialog rendert die Modelle aus modelList", async () => {
  const { root } = await mountView();

  const open = buttonByText("New scheduled task");
  assert.ok(open, "der Knopf zum Anlegen fehlt");

  // Der Aufruf selbst ist der Befund: mit der alten Zeile
  // (`body.models ?? []` und `.map`) wirft React hier `map is not a function`,
  // und ein Throw in einem Commit nimmt den ganzen Baum mit. `act` reicht ihn
  // an den Test weiter, also scheitert der Test an derselben Stelle.
  await act(async () => { open.click(); });
  await settle();

  const dialog = win.document.querySelector('[data-slot="dialog-content"]');
  assert.ok(dialog, "der Dialog ist nicht aufgegangen");

  const select = dialog.querySelector("#scheduled-model");
  assert.ok(select, "die Modellauswahl fehlt");
  const options = [...select.querySelectorAll("option")].map((o) => (o.textContent ?? "").trim());
  assert.ok(
    options.includes("Qwen 3.8 27B"),
    `die Modelle aus modelList fehlen in der Auswahl: ${JSON.stringify(options)}`,
  );
  assert.ok(options.includes("DeepSeek V4.1 Flash"), `die zweite Modellzeile fehlt: ${JSON.stringify(options)}`);

  // Die Zuordnung `models` darf nicht als Option auftauchen — sie ist keine
  // Liste, und ihre Schluessel sind keine Auswahl.
  assert.ok(
    !options.some((label) => label.includes("[object Object]")),
    `ein Objekt ist als Beschriftung in die Auswahl gelaufen: ${JSON.stringify(options)}`,
  );

  await act(async () => { root.unmount(); });
});

test("Der Dialog bleibt benutzbar, wenn /api/models fehlschlaegt", async () => {
  const failingFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.startsWith("/api/models")) return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    return failingFetch(input);
  };
  try {
    const { root } = await mountView();
    const open = buttonByText("New scheduled task");
    assert.ok(open, "der Knopf zum Anlegen fehlt");
    await act(async () => { open.click(); });
    await settle();

    const select = win.document.querySelector("#scheduled-model");
    assert.ok(select, "der Dialog ist bei einem Modell-Fehler nicht aufgegangen");
    assert.equal(select.querySelectorAll("option").length, 1, "erwartet nur den Platzhalter");

    await act(async () => { root.unmount(); });
  } finally {
    globalThis.fetch = failingFetch;
  }
});
