import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * Die Inhaltssuche — gemountet, mit gestellten Anfragen.
 *
 * Geprueft wird das Zeitverhalten, nicht der Quelltext: keine Anfrage unter
 * zwei Zeichen, zwei Tastendruecke sind eine Anfrage, ein neuer Begriff bricht
 * die alte Anfrage ab, und eine Antwort, die zu spaet kommt, setzt nichts
 * mehr. Dafuer werden die Antworten hier von Hand aufgeloest, damit die
 * Reihenfolge der Test ist und nicht der Zufall der Ereignisschleife.
 */

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  fetch: globalThis.fetch,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

globalThis.window = win;
globalThis.document = win.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  useSessionContentSearch,
  CONTENT_SEARCH_DEBOUNCE_MS,
  CONTENT_SEARCH_MIN_LENGTH,
} = await jiti.import("../hooks/useSessionContentSearch.ts");

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

const MATCH = {
  sessionId: "s1",
  title: "hello there",
  cwd: "/home/alice/work",
  hits: 2,
  snippet: "…the needle sits in the transcript…",
};

function json(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

/** Jede Anfrage bleibt offen, bis der Test sie aufloest. */
let pending = [];
let requests = [];

function installFetch() {
  pending = [];
  requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    // Nur die Suche gehoert diesem Test: liegengebliebene Baeume aus anderen
    // Testdateien fragen weiter ihre eigenen Routen, und deren Antworten
    // duerfen weder hier gezaehlt noch offen gelassen werden.
    if (!url.startsWith("/api/sessions/search")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    requests.push({ url, signal: init.signal ?? null });
    return new Promise((resolve, reject) => {
      pending.push({ url, resolve, reject, signal: init.signal ?? null });
    });
  };
}

async function mount() {
  installFetch();
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  let latest = null;
  function Probe({ query }) {
    latest = useSessionContentSearch(query);
    return null;
  }
  const root = createRoot(container);
  const render = (query) => act(async () => {
    root.render(React.createElement(Probe, { query }));
  });
  await render("");
  return {
    get value() { return latest; },
    render,
    async unmount() { await act(async () => { root.unmount(); }); },
  };
}

/** Wartet, bis der Entpreller gefeuert hat (und ein wenig mehr). */
const pastDebounce = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, CONTENT_SEARCH_DEBOUNCE_MS + 40));
});

/** Loest die offene Anfrage `index` auf und laesst React rendern. */
async function answer(index, body, status = 200) {
  const entry = pending[index];
  assert.ok(entry, `die Anfrage ${index} wurde nie gestellt`);
  await act(async () => {
    entry.resolve(json(body, status));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

test("a query under the minimum sends nothing and clears old results", async () => {
  const harness = await mount();

  await harness.render("a");
  await pastDebounce();
  assert.equal(requests.length, 0, "unter zwei Zeichen darf keine Anfrage laufen");
  assert.deepEqual(harness.value.matches, []);

  await harness.render("abc");
  await pastDebounce();
  await answer(0, { matches: [MATCH], truncated: false, scanned: 1 });
  assert.equal(harness.value.matches.length, 1);

  // Zurueck unter die Grenze: die alten Treffer gehoeren zur alten Frage.
  await harness.render("a");
  assert.deepEqual(harness.value.matches, [], "die Treffer bleiben stehen");
  await pastDebounce();
  assert.equal(requests.length, 1, "der kurze Begriff hat erneut gefragt");
  await harness.unmount();
});

test("two keystrokes within the debounce are one request", async () => {
  const harness = await mount();

  await harness.render("he");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  await harness.render("hello");
  await pastDebounce();

  assert.equal(requests.length, 1, "jeder Tastendruck fragte den Server");
  assert.match(requests[0].url, /\/api\/sessions\/search\?q=hello$/);
  assert.ok(harness.value.searching, "die laufende Frage ist nicht als laufend markiert");

  await answer(0, { matches: [], truncated: false, scanned: 0 });
  assert.equal(harness.value.searching, false);
  await harness.unmount();
});

test("a newer query aborts the request in flight", async () => {
  const harness = await mount();

  await harness.render("hello");
  await pastDebounce();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);

  await harness.render("hello!");
  // Der Abbruch gehoert zum Aufraeumen des alten Effekts und ist sofort da,
  // nicht erst nach dem naechsten Entprellen.
  assert.equal(requests[0].signal.aborted, true, "die alte Anfrage laeuft weiter");

  await pastDebounce();
  assert.equal(requests.length, 2);
  await answer(1, { matches: [MATCH], truncated: false, scanned: 1 });
  assert.equal(harness.value.matches.length, 1);
  await harness.unmount();
});

test("a stale answer that arrives last does not overwrite the newer one", async () => {
  const harness = await mount();

  await harness.render("old");
  await pastDebounce();
  await harness.render("new");
  await pastDebounce();
  assert.equal(requests.length, 2);

  const newer = { ...MATCH, sessionId: "s2", snippet: "the newer answer" };
  await answer(1, { matches: [newer], truncated: false, scanned: 1 });
  // Die alte Antwort kommt zuletzt — und wird verworfen.
  await answer(0, { matches: [MATCH], truncated: false, scanned: 1 });

  assert.deepEqual(harness.value.matches.map((match) => match.sessionId), ["s2"]);
  await harness.unmount();
});

test("a refused search is an error state and never throws", async () => {
  const harness = await mount();

  await harness.render("needle");
  await pastDebounce();
  await answer(0, { error: "Unknown user" }, 403);

  assert.equal(harness.value.error, "Unknown user");
  assert.deepEqual(harness.value.matches, []);
  assert.equal(harness.value.searching, false);
  await harness.unmount();
});

test("truncated is passed through", async () => {
  const harness = await mount();

  await harness.render("needle");
  await pastDebounce();
  await answer(0, { matches: [MATCH], truncated: true, scanned: 40 });

  assert.equal(harness.value.truncated, true);
  assert.equal(harness.value.error, null);
  assert.equal(CONTENT_SEARCH_MIN_LENGTH, 2);
  await harness.unmount();
});

test("a dead connection is an error state and never throws", async () => {
  const harness = await mount();

  await harness.render("needle");
  await pastDebounce();
  assert.equal(requests.length, 1);
  await act(async () => {
    pending[0].reject(new TypeError("Failed to fetch"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  assert.equal(harness.value.error, "Failed to fetch");
  assert.deepEqual(harness.value.matches, []);
  assert.equal(harness.value.searching, false);
  await harness.unmount();
});

test("a body that is not JSON still settles as an error", async () => {
  const harness = await mount();

  await harness.render("needle");
  await pastDebounce();
  await act(async () => {
    pending[0].resolve({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  assert.equal(harness.value.error, "HTTP 502");
  assert.equal(harness.value.searching, false);
  await harness.unmount();
});
