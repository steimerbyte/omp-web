import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { createJiti } from "jiti";

/**
 * `app/recover/page.tsx` — Passwort-Wiederherstellung ohne Anmeldung.
 *
 * Der statische Render zeigt, dass die Seite ohne Code, ohne Netz und ohne
 * Zustand auskommt: der Absende-Knopf ist deaktiviert, bis Code und zwei
 * gleiche Passwoerter da sind. Der gemountete Baum zeigt, dass der Knopf
 * wirklich an `/api/web-access/recovery` geht — die Seite kann nur ueber
 * diesen Endpunkt etwas bewirken.
 *
 * Getippte Feldwerte werden hier bewusst nicht simuliert: linkedom liefert
 * React 19 kein `input`-Ereignis, an dem der Change-Plugin haengt (gemessen:
 * `onChange` bleibt aus, das Feld behaelt nur den direkt gesetzten DOM-Wert).
 * Eine Behauptung ueber `canSubmit` nach dem Tippen waere damit eine Aussage
 * ueber den Harness, nicht ueber die Seite.
 */

const INSTALLED = [
  "window", "document", "navigator", "HTMLElement", "Element", "Node", "Event",
  "KeyboardEvent", "getComputedStyle", "location", "localStorage", "matchMedia",
  "requestAnimationFrame", "cancelAnimationFrame", "fetch",
];
const previousGlobals = new Map();

/**
 * Baut die minimale Browserumgebung fuer den gemounteten Baum.
 *
 * `bun test` faehrt alle Testdateien im selben Prozess; ein globales
 * `document` oder ein `fetch`-Stub, der stehen bleibt, wuerde die naechste
 * Datei mit einer fremden Umgebung testen. Deshalb wird jeder belegte Name
 * gemerkt und in `after` zurueckgegeben.
 */
function installDom() {
  const { window } = parseHTML("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  const storage = new Map();
  const values = {
    window,
    document: window.document,
    navigator: { language: "en-US", languages: ["en-US"], userAgent: "test" },
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: () => ({}),
    location: new URL("http://localhost/recover"),
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, String(value)),
      removeItem: (key) => void storage.delete(key),
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
  };
  // React 19 fragt beim Laden von `react-dom` nach `oninput` auf dem Dokument.
  // linkedom hat das nicht, also faellt die Antwort dauerhaft auf `false`, und
  // `onChange` liefe ueber den alten Polyfill-Pfad (der `attachEvent` braucht).
  window.document.oninput = null;
  window.document.onchange = null;
  window.HTMLElement.prototype.attachEvent = function attachEvent(type, handler) {
    this.addEventListener(type.replace(/^on/, ""), handler);
  };
  window.HTMLElement.prototype.detachEvent = function detachEvent(type, handler) {
    this.removeEventListener(type.replace(/^on/, ""), handler);
  };

  for (const name of INSTALLED) {
    if (name in values) {
      if (!previousGlobals.has(name)) previousGlobals.set(name, globalThis[name]);
      globalThis[name] = values[name];
    }
  }
  return values;
}

function restoreDom() {
  for (const name of INSTALLED) {
    if (!previousGlobals.has(name)) continue;
    const value = previousGlobals.get(name);
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
  previousGlobals.clear();
}

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
let RecoverPage;
let createRoot;

test.before(async () => {
  installDom();
  // Erst nach dem DOM laden: React entscheidet beim Import, ob es einen
  // Browser sieht.
  ({ createRoot } = await import("react-dom/client"));
  ({ default: RecoverPage } = await jiti.import("./page.tsx"));
});

test.after(async () => {
  // Dem Scheduler einen Task Zeit geben, solange `window` noch existiert.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  restoreDom();
});



/** Antwortet wie die Route: `{ ok: true }` oder ein Fehler. */
function installFetch(results) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    const result = results.shift() ?? { ok: true };
    if (result.error) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: result.status ?? 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  };
  return calls;
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(RecoverPage));
  });
  return {
    container,
    unmount: async () => {
      // Innerhalb von `act`, damit der naechste Scheduler-Task nicht nach dem
      // Abbau des DOM laeuft.
      await act(async () => {
        root.unmount();
      });
    },
  };
}

/** Der React-Prop-Container eines DOM-Knotens (linkedom + React 19). */
function reactProps(node) {
  const key = Object.keys(node).find((entry) => entry.startsWith("__reactProps$"));
  assert.ok(key, "React hat keine Props am Knoten hinterlegt");
  return node[key];
}

/**
 * Setzt ein Feld ueber seinen `onChange`-Handler.
 *
 * Ein `input`-Ereignis erreicht React in linkedom nicht (gemessen: `onChange`
 * bleibt aus, das Feld behaelt nur den direkt gesetzten DOM-Wert). Der Handler
 * ist derselbe, den ein Browser aufruft; nur der Weg dorthin ist hier der
 * kuerzere.
 */
async function fireChange(input, value) {
  await act(async () => {
    reactProps(input).onChange({ target: { value } });
  });
}

// ------------------------------------------------------------ statisch ----

test("der erste Render bietet Code-Eingabe und deaktiviertes Absenden", () => {
  const html = renderToStaticMarkup(React.createElement(RecoverPage));

  assert.match(html, /Recover access/);
  assert.match(html, /XXXX-XXXX-XXXX/, "das Code-Feld fehlt");
  assert.match(html, /New password/);
  assert.match(html, /Confirm password/);
  // Ohne Code ist der Absende-Knopf deaktiviert — sonst waere der erste Klick
  // ein Request mit leerem Code.
  assert.match(html, /<button[^>]*disabled=""[^>]*>Set new password<\/button>/);
  assert.doesNotMatch(html, /The password was changed/, "der Erfolgsschritt darf nicht vorab erscheinen");
});

// -------------------------------------------------------------- gemountet --

test("der Knopf fordert einen Code an und zeigt den Hinweis", async () => {
  const calls = installFetch([{ ok: true, expiresAt: Date.UTC(2026, 0, 1, 12, 0, 0) }]);
  const { container, unmount } = await mount();

  const button = [...container.querySelectorAll("button")].find((entry) => /recovery code/.test(entry.textContent));
  assert.ok(button, "der Anfordern-Knopf fehlt");
  await act(async () => {
    button.click();
  });

  assert.deepEqual(calls, [{ url: "/api/web-access/recovery", body: { action: "request" } }]);
  assert.match(container.textContent, /A code was printed on the server console/);
  assert.match(container.textContent, /Send another code/);
  await unmount();
});

test("ein Fehler der Route wird angezeigt, nicht verschluckt", async () => {
  installFetch([{ ok: false, status: 429, error: "Too many requests" }]);
  const { container, unmount } = await mount();

  const button = [...container.querySelectorAll("button")].find((entry) => /recovery code/.test(entry.textContent));
  await act(async () => {
    button.click();
  });

  assert.match(container.textContent, /Too many requests/);
  assert.match(container.textContent, /Print a recovery code/, "der Knopf bleibt im Ausgangszustand");
  await unmount();
});

test("der Anfordern-Knopf ist der einzige Weg zu einer Anfrage", async () => {
  const calls = installFetch([{ ok: true }, { ok: true }]);
  const { container, unmount } = await mount();

  const request = [...container.querySelectorAll("button")].find((entry) => /recovery code/.test(entry.textContent));
  await act(async () => {
    request.click();
  });
  assert.equal(calls.length, 1, "der Code muss beim Server angefordert werden");
  assert.deepEqual(calls[0], { url: "/api/web-access/recovery", body: { action: "request" } });
  // Der Absende-Knopf bleibt ohne Code und Passwort deaktiviert: der Erfolg
  // kann nicht durch einen Klick auf einem leeren Formular entstehen.
  const submit = [...container.querySelectorAll("button")].find((entry) => /Set new password/.test(entry.textContent));
  assert.equal(submit.disabled, true);
  await act(async () => {
    submit.click();
  });
  assert.equal(calls.length, 1, "ein deaktivierter Knopf darf keine zweite Anfrage ausloesen");
  await unmount();
});

test("ein vollstaendiger Ablauf setzt das Passwort und zeigt den Erfolgsschritt", async () => {
  const calls = installFetch([{ ok: true }, { ok: true }]);
  const { container, unmount } = await mount();

  const inputs = [...container.querySelectorAll("input")];
  await fireChange(inputs[0], "ABCD-EFGH-IJKL");
  await fireChange(inputs[1], "eins-zwei-drei");
  await fireChange(inputs[2], "eins-zwei-drei");

  const submit = [...container.querySelectorAll("button")].find((entry) => /Set new password/.test(entry.textContent));
  assert.equal(submit.disabled, false, "mit Code und zwei gleichen Passwoertern muss der Knopf aktiv sein");

  await act(async () => {
    submit.click();
  });

  assert.deepEqual(calls.at(-1), {
    url: "/api/web-access/recovery",
    body: { action: "complete", code: "ABCD-EFGH-IJKL", password: "eins-zwei-drei" },
  });
  assert.match(container.textContent, /The password was changed/);
  assert.match(container.textContent, /Back to omp-web/);
  await unmount();
});

test("ungleiche Passwoerter lassen den Knopf gesperrt", async () => {
  const calls = installFetch([]);
  const { container, unmount } = await mount();

  const inputs = [...container.querySelectorAll("input")];
  await fireChange(inputs[0], "ABCD-EFGH-IJKL");
  await fireChange(inputs[1], "eins-zwei-drei");
  await fireChange(inputs[2], "eins-zwei-drei-vier");

  const submit = [...container.querySelectorAll("button")].find((entry) => /Set new password/.test(entry.textContent));
  assert.equal(submit.disabled, true);
  assert.equal(calls.length, 0);
  await unmount();
});

test("ein abgelehnter Code zeigt die Meldung der Route", async () => {
  // Der Server kann den Code ablehnen, auch wenn das Formular ihn fuer
  // vollstaendig haelt — abgelaufen, schon benutzt, falsch.
  const calls = installFetch([{ ok: false, status: 400, error: "The recovery code has expired." }]);
  const { container, unmount } = await mount();

  const inputs = [...container.querySelectorAll("input")];
  await fireChange(inputs[0], "ABCD-EFGH-IJKL");
  await fireChange(inputs[1], "eins-zwei-drei");
  await fireChange(inputs[2], "eins-zwei-drei");

  const submit = [...container.querySelectorAll("button")].find((entry) => /Set new password/.test(entry.textContent));
  await act(async () => {
    submit.click();
  });

  assert.equal(calls.at(-1).body.action, "complete");
  assert.match(container.textContent, /The recovery code has expired/);
  assert.doesNotMatch(container.textContent, /The password was changed/);
  await unmount();
});
