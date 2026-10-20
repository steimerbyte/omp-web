import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";

/**
 * Das Benutzername-Feld ist beim Laden leer.
 *
 * `app/login/page.tsx` pflegte den State mit `useState("omp")`, also stand in
 * dem gerenderten `value` des Inputs immer der Name eines anderen Kontos, und
 * das Feld war schon dann "gefuellt", wenn es niemand angefasst hatte. Die
 * Seite selbst hat den Wert nie geschrieben: es gab kein `useEffect` und kein
 * `localStorage`, der Default stand allein im State-Initialwert. Deshalb wird
 * hier die echte Komponente gemountet und der gerenderte Input gelesen —
 * eine Pruefung des Quelltexts wuerde auch ein `defaultValue` oder ein
 * nachtraegliches `setUsername` uebersehen.
 *
 * `linkedom` liefert `input.type === null` statt `"text"`, und React 19
 * feuert `onChange` an kontrollierten Feldern ueber den Value-Tracker des
 * Nodes: ein nur gesetztes `.value` loest nichts aus. Der Tippvorgang
 * schreibt deshalb `value` ueber den eigenen `HTMLInputElement.prototype.value`
 * -Setter und dispatcht danach ein `input`-Event, das ist der Weg, den ein
 * Browser nimmt. Dass dieser Weg wirklich der onChange-Pfad ist, wird nicht
 * angenommen, sondern geprueft: ohne ihn bliebe der Zustand leer und der
 * Absende-Button bliebe deaktiviert.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

// Ein blosser Proxy bricht linkedom, dessen Methoden internen Zustand ueber
// `this` lesen; deshalb wird jede Funktion an das echte Fenster gebunden. Der
// Trap existiert nur, weil linkedom `window.navigator` bei jedem Zugriff neu
// baut.
globalThis.window = new Proxy(dom.window, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = dom.document;
globalThis.navigator = fakeNavigator;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
for (const name of Object.keys(dom.window)) {
  if (name === "window") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = dom.window[name];
}
// Bun's eigenes `Event` hat ein schreibgeschuetztes `eventPhase`, dem
// `dispatchEvent` von linkedom zuweist.
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

// linkedom fuehrt kein Layout und damit kein `getComputedStyle` aus. motion
// liest nur den Startwert einer Eigenschaft, die es interpoliert, und alle
// Elemente hier setzen sie inline - eine leere Deklaration ist die ehrliche
// Antwort.
const computed = () => new Proxy({}, {
  get: (target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : ""),
});
dom.window.getComputedStyle = computed;
globalThis.getComputedStyle = computed;

const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
globalThis.localStorage = localStorage;
dom.window.localStorage = localStorage;

/** Jeder Login-Versuch, den die Seite wirklich abgesetzt hat. */
const requests = [];

globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
  return {
    ok: false,
    status: 401,
    json: async () => ({ error: "Sign-in failed. Check the password and try again." }),
  };
};

/**
 * React 19 schaltet seinen `change`-Pfad an der Existenz von `oninput` auf dem
 * `document` fest, und er fragt das beim Auswerten von `react-dom` ab - nicht
 * beim Dispatchen. linkedom hat `oninput` nicht, also fiel `isInputEventSupported`
 * in diesem Harness dauerhaft auf `false` und `onChange` an kontrollierten
 * Feldern wurde nie gerufen: `onInput` lief, der Knopf blieb `disabled`, es
 * ging nichts raus. Gemessen 2026-10-20 mit einem zweizeiligen
 * Controlled-Input gegen dieselbe linkedom-Version.
 */
dom.document.oninput = null;
dom.document.onchange = null;

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { default: LoginPage } = await import("./page.tsx");

/**
 * `useRouter()` wirft ausserhalb des App-Routers, und die Seite ruft ihn beim
 * Mount auf. Der Kontext ist Next' eigener; ein Attrappe-Router genuegt, weil
 * der Test nichts navigiert - er liest Felder und schickt Formulare ab.
 */
const routerStub = { replace() {}, refresh() {}, push() {}, back() {}, forward() {}, prefetch() {} };

// `linkedom` kennt kein `select()`, das der Fokuspfad der Seite braucht, und
// kein `attachEvent`, das Reacts alter Input-Polyfill beim `focusin` aufruft.
dom.window.HTMLElement.prototype.select = function select() {};
dom.window.HTMLElement.prototype.attachEvent = function attachEvent(type, handler) {
  this.addEventListener(type.replace(/^on/, ""), handler);
};
dom.window.HTMLElement.prototype.detachEvent = function detachEvent(type, handler) {
  this.removeEventListener(type.replace(/^on/, ""), handler);
};

const mountedRoots = [];

async function mount() {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(AppRouterContext.Provider, { value: routerStub }, React.createElement(LoginPage)),
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  return container;
}

test.after(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
});

/** Das Benutzername-Feld anhand seines Labels, nicht anhand seiner Position. */
function usernameInput(container) {
  const labels = [...container.querySelectorAll("label")];
  const label = labels.find((candidate) => /username/i.test(candidate.textContent ?? ""));
  const input = label?.querySelector("input");
  assert.ok(input, `kein Benutzername-Feld gefunden; labels=${JSON.stringify(labels.map((l) => l.textContent))}`);
  return input;
}

/**
 * Tippen, wie ein Browser es tut: den Wert ueber den nativen Setter schreiben
 * und danach ein `input`-Event senden. React laesst `onChange` an
 * kontrollierten Feldern nur fuer diese Sequenz fallen - ein bloss gesetztes
 * `.value` loest nichts aus.
 *
 * Zusaetzlich laufen `focusin` und `keyup` mit, und damit laeuft dieser Test in
 * beiden Modi, in denen `react-dom` laufen kann. Laedt eine fruehere Testdatei
 * `react-dom` zuerst, ist `isInputEventSupported` dort schon auf `false`
 * gefallen (`oninput` fehlt im linkedom-`document`), und React nimmt fuer
 * Textfelder dann den alten Polyfill-Pfad, der `onChange` ueber `keyup` auf dem
 * gerade aktiven Element ausloest - mit `attachEvent`, das linkedom ebenfalls
 * nicht kennt. Gemessen 2026-10-20: mit `input` allein blieb der Zustand leer
 * und der Absende-Knopf `disabled`, sobald eine andere Testdatei vorher lief;
 * mit `focusin` + `keyup` daneben wird der Zustand in beiden Laeufen gesetzt.
 */
async function type(input, text) {
  await act(async () => {
    input.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
  });
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    setter.call(input, text);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("keyup", { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

function submitButton(container) {
  const button = [...container.querySelectorAll("button")].find((b) => b.getAttribute("type") === "submit");
  assert.ok(button, "kein Absende-Knopf gefunden");
  return button;
}

/**
 * Absenden ueber das `submit`-Event des Formulars.
 *
 * `linkedom` fuehrt keine implizite Formular-Einreichung aus - ein Klick auf
 * einen Submit-Knopf loest hier nichts aus, im Browser dagegen genau das. Das
 * Ereignis wird deshalb direkt am `<form>` ausgeloest, das ist der Handler,
 * den `onSubmit` der Seite registriert.
 */
async function submit(container) {
  const form = container.querySelector("form");
  assert.ok(form, "kein Formular gefunden");
  await act(async () => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

test("Das Benutzername-Feld ist beim Laden leer", async () => {
  const container = await mount();
  const input = usernameInput(container);
  assert.equal(input.value, "", "das Feld war beim Laden gefuellt");
  assert.equal(input.getAttribute("value"), null, "der Wert steht als Attribut im gerenderten HTML");
});

test("Der gerenderte Wert bleibt leer, auch nachdem der Fokuspfad lief", async () => {
  // Der Fokus-Effekt der Seite laeuft nach dem Mount und schreibt nichts in
  // das Feld. Ohne den zweiten Blick nach dem Effekt waere ein Prefill, den
  // erst der Effekt setzt, unbemerkt geblieben.
  const container = await mount();
  await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
  assert.equal(usernameInput(container).value, "");
});

test("Ein leeres Feld schickt nichts ab und der Knopf bleibt zu", async () => {
  const container = await mount();
  requests.length = 0;
  assert.equal(submitButton(container).hasAttribute("disabled"), true);
  await submit(container);
  assert.deepEqual(requests, [], "ein leeres Formular hat den Server trotzdem erreicht");
});

test("Ein getippter Name erreicht den Server unveraendert", async () => {
  const container = await mount();
  requests.length = 0;
  const input = usernameInput(container);
  await type(input, "steimerbyte");
  // Beweis, dass der echte onChange-Pfad getroffen wurde: der Zustand ist
  // gefuellt. Ohne den Pfad bliebe er leer und der Knopf disabled.
  assert.equal(input.value, "steimerbyte");
  // Der Knopf haengt weiter am leeren Passwort - die Verifikation der Seite ist
  // unveraendert.
  assert.equal(submitButton(container).hasAttribute("disabled"), true);
  await type(container.querySelector('input[type="password"]'), "hunter2");
  assert.equal(submitButton(container).hasAttribute("disabled"), false);
  await submit(container);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/web-access/login");
  assert.deepEqual(requests[0].body, { username: "steimerbyte", password: "hunter2" });
});

test("Ein abgelehnter Versuch zeigt weiter die Fehlermeldung", async () => {
  const container = await mount();
  requests.length = 0;
  await type(usernameInput(container), "bob");
  await type(container.querySelector('input[type="password"]'), "wrong");
  await submit(container);
  const alert = container.querySelector('[role="alert"]');
  assert.match(alert?.textContent ?? "", /Sign-in failed/);
});
