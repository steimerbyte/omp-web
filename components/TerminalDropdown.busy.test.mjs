import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";

/**
 * Der "+"-Knopf muss melden, dass er arbeitet.
 *
 * Gemessen an der echten Oberflaeche: der Klick auf "New terminal" loest einen
 * Server-Roundtrip aus (POST /api/terminal), und bis dessen Antwort da ist gibt
 * es keine Terminal-Id, keinen Tab und kein geoeffnetes Panel — das Panel stand
 * in allen Messungen bei 0 px und sprang erst nach der Antwort auf 573,3 px.
 * Ohne sichtbaren Zwischenzustand sieht der Klick fuer die Dauer des Spawns
 * aus, als passiere nichts; gemessen waren 5,8 s im warmen und 55 s im kalten
 * Dev-Server. Der Test haelt den Spawn offen und verlangt, dass die Zeile in
 * dieser Zeit ihren Zustand meldet und nicht mehr klickbar ist.
 *
 * Der zweite Teil ist die Gegenprobe: ein Fix, der nur einen dauerhaften
 * Busy-Zustand einbaut, wuerde hier durchfallen, weil die Zeile nach der
 * Antwort nicht wieder auf ihren Ruhezustand zurueckkehrt.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

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
// motion prueft beim Aufloesen der Keyframes `instanceof HTMLElement`; ohne das
// globale Fenster bricht die Messphase des Spinners ab.
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;

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
dom.window.HTMLElement.prototype.scrollIntoView = function () {};

const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { TerminalDropdown } = await jiti.import("./TerminalDropdown.tsx");
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

/**
 * Der Spawn laeuft unter Kontrolle: `resolve` gibt die Antwort frei, und
 * `calls` zaehlt die Zugriffe auf `/api/terminal`.
 */
function installFetch() {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if (init?.method === "POST") {
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ terminal: { id: "t-1", cwd: "/x", pid: 7, status: "running", shell: "bash", createdAt: 0, sandboxed: false } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ terminals: [] }) };
  };
  globalThis.fetch = fetchImpl;
  dom.window.fetch = fetchImpl;
  return { calls, release: () => release() };
}

function row(container) {
  return [...container.querySelectorAll('[role="menuitem"]')].find((el) => el.tagName === "BUTTON");
}

async function openMenu(container) {
  const trigger = container.querySelector("button");
  await act(async () => { trigger.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
}

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const opened = [];
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(TerminalDropdown, {
      cwd: "/x",
      onOpenTerminal: (id) => opened.push(id),
    })));
  });
  return { host, opened, root };
}

test('der "+"-Knopf meldet den Spawn, statt reglos zu bleiben', async () => {
  const fetchState = installFetch();
  const { host, opened, root } = await mount();
  try {
    await openMenu(host);
    const before = row(host);
    assert.ok(before, "die Zeile 'New terminal' fehlt");
    assert.match(before.textContent ?? "", /New terminal/);
    assert.equal(before.getAttribute("aria-busy"), null);

    await act(async () => { before.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });

    const during = row(host);
    assert.ok(during, "die Zeile verschwindet waehrend des Spawns");
    assert.match(during.textContent ?? "", /Starting/,
      "während des Spawns steht kein Fortschritt in der Zeile — der Klick sieht damit aus, als tue er nichts");
    assert.equal(during.getAttribute("aria-busy"), "true");
    assert.equal(during.disabled, true, "die Zeile bleibt waehrend des Spawns klickbar");
    assert.deepEqual(opened, [], "es wird eine Terminal-Id gemeldet, bevor der Server sie kennt");

    await act(async () => { fetchState.release(); await new Promise((r) => setTimeout(r, 20)); });

    assert.deepEqual(opened, ["t-1"], "nach der Antwort wird das Terminal nicht geoeffnet");
    assert.equal(
      fetchState.calls.filter((c) => c.method === "POST").length,
      1,
      "der Spawn wird nicht mehrfach ausgeloest",
    );
    // Das Menue schliesst sich mit dem Terminal; die Zeile ist danach weg.
    assert.equal(row(host), undefined, "das Menue bleibt nach dem Terminal offen");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});