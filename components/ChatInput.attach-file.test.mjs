import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createJiti } from "jiti";

/**
 * Die Papierklammer im Composer — gemountet, nicht nur gerendert.
 *
 * ### Warum ein gemounteter Test und nicht `renderToStaticMarkup`
 *
 * Drei der vier Behauptungen sind Ereignisse: der Knopf oeffnet den Picker,
 * ein Upload ergibt genau einen Chip, und der Chip verschwindet, ohne dass die
 * Datei angefasst wird. Das laesst sich nicht an Markup ablesen. Der Aufbau ist
 * derselbe wie in `ChatInput.enter-gesture.test.mjs`: linkedom, `act`, und der
 * React-Handler eines Knotens wird direkt aufgerufen (linkedom und React 19
 * koennen `dispatchEvent` auf Formularelementen nicht gemeinsam zustellen).
 *
 * `fetch` ist die Grenze: der Stub ersetzt nur die Route, nicht die Logik —
 * der `cwd` und der Feldname `files` gehen durch den echten Client-Code.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

globalThis.window = new Proxy(dom.window, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = dom.document;
globalThis.navigator = fakeNavigator;

const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
globalThis.localStorage = localStorage;
dom.window.localStorage = localStorage;
globalThis.CSS = { supports: () => true, registerProperty: () => {} };

/** Jeder Upload-Aufruf dieses Tests, in der Reihenfolge des Absendens. */
const uploads = [];
/** Alles, was ausser dem Upload gefragt wird (Quick Phrases beim Mount). */
let uploadReply = { status: 200, body: { uploaded: [] } };

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith("/api/files/")) {
    uploads.push({ url: href, file: init.body.get("files"), method: init.method });
    return {
      ok: uploadReply.status >= 200 && uploadReply.status < 300,
      status: uploadReply.status,
      json: async () => uploadReply.body,
    };
  }
  return { ok: true, status: 200, json: async () => ({ phrases: [] }) };
};

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { clearDraft } = await jiti.import("../lib/draft-store.ts");
const { createRoot } = await import("react-dom/client");

const mountedRoots = [];
let draftCounter = 0;

async function mountInput(props = {}) {
  const sent = [];
  const draftKey = `attach-file-test-${draftCounter++}`;
  const container = document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend: (message) => sent.push(message),
      onAbort() {},
      modelList: [],
      modelNames: {},
      draftKey,
      ...props,
    })));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { container, sent, draftKey };
}

function reactProps(element, name) {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  assert.ok(key, `kein React-Props-Objekt an ${name}`);
  return element[key];
}

function paperclip(container) {
  const button = container.querySelector('[data-testid="composer-attach-file"]');
  assert.ok(button, "die Papierklammer wurde gerendert");
  return button;
}

function fileInput(container) {
  const input = container.querySelector('input[data-testid="composer-file-input"]');
  assert.ok(input, "das versteckte Datei-Input existiert");
  return input;
}

function chips(container) {
  return container.querySelectorAll('[data-testid="composer-file-chips"] > div');
}

/**
 * Warten auf einen DOM-Zustand statt auf eine feste Zeit.
 *
 * Der Upload ist asynchron (zwei `await`-Stufen im Client-Code). Ein
 * `setTimeout(40)` genuegt im Leerlauf und reisst unter Last — beim ersten
 * Durchlauf mit vier parallelen Testdateien sind genau solche Wartefristen
 * gerissen. Die Schleife gibt React nach jedem Schritt die Chance zu rendern.
 */
async function waitFor(predicate, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  assert.ok(predicate(), "der erwartete Zustand ist innerhalb von 5 s nicht eingetreten");
}

async function upload(container, file = new File(["a,b\n1,2\n"], "sample.csv", { type: "text/csv" })) {
  const input = fileInput(container);
  const before = chips(container).length;
  await act(async () => {
    reactProps(input, "onChange").onChange({ target: { files: [file], value: "C:\\fakepath\\sample.csv" } });
  });
  // Erfolg (Chip) oder Fehler (Meldung) — beides beendet den Upload.
  await waitFor(() => chips(container).length !== before || container.querySelector('[data-testid="composer-upload-error"]') !== null);
}

test.afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  uploads.length = 0;
  uploadReply = { status: 200, body: { uploaded: [] } };
  storage.clear();
});

test.after(() => {
  for (let index = 0; index < draftCounter; index += 1) clearDraft(`attach-file-test-${index}`);
});

test("without a working directory the paperclip is disabled and says why", async () => {
  const { container } = await mountInput({ cwd: null });
  const button = paperclip(container);

  assert.equal(button.getAttribute("aria-label"), "Attach file");
  assert.equal(button.getAttribute("title"), "Pick a working folder first — the file is uploaded into it");
  assert.ok(button.hasAttribute("disabled"), "ohne cwd ist der Knopf aus");

  const opens = [];
  const input = fileInput(container);
  input.click = () => { opens.push(1); };
  await act(async () => { reactProps(button, "onClick").onClick({}); });
  assert.deepEqual(opens, [], "ein ausgeschalteter Knopf oeffnet nichts");
});

test("with a cwd the paperclip opens the file picker", async () => {
  const { container } = await mountInput({ cwd: "/home/alice/project" });
  const button = paperclip(container);

  assert.equal(button.hasAttribute("disabled"), false);
  assert.equal(button.getAttribute("title"), "Attach file");

  const opens = [];
  const input = fileInput(container);
  input.click = () => { opens.push(1); };
  await act(async () => { reactProps(button, "onClick").onClick({}); });
  assert.deepEqual(opens, [1], "der Klick landet auf dem Datei-Input");
});

test("one uploaded file becomes exactly one chip carrying the name and size", async () => {
  uploadReply = { status: 200, body: { uploaded: ["sample.csv"], skipped: [], errors: [] } };
  const { container } = await mountInput({ cwd: "/home/alice/project" });

  await upload(container);

  assert.equal(uploads.length, 1, "genau ein Request");
  assert.equal(uploads[0].url, "/api/files/home/alice/project?type=upload&conflict=skip");
  assert.equal(uploads[0].file.name, "sample.csv");
  assert.equal(uploads[0].method, "POST");

  assert.equal(chips(container).length, 1, "genau ein Chip");
  assert.match(chips(container)[0].textContent, /sample\.csv/);
  assert.match(chips(container)[0].textContent, /8 B/, "die Groesse steht am Chip");
  assert.equal(container.querySelector('[data-testid="composer-upload-error"]'), null);
});

test("removing the chip drops the reference and issues no second request", async () => {
  uploadReply = { status: 200, body: { uploaded: ["sample.csv"], skipped: [], errors: [] } };
  const { container } = await mountInput({ cwd: "/home/alice/project" });
  await upload(container);

  const remove = container.querySelector('[aria-label^="Remove attachment"]');
  assert.ok(remove, "der Chip hat einen Entfernen-Knopf");
  await act(async () => { reactProps(remove, "onClick").onClick({}); });

  assert.equal(chips(container).length, 0);
  // Ein DELETE auf die Datei waere hier genau der Fehler: der Upload hat den
  // Chip erzeugt, das Entfernen ist eine Aenderung an der *Nachricht*.
  assert.equal(uploads.length, 1, "kein zusaetzlicher Request beim Entfernen");
  assert.equal(uploads.filter((entry) => entry.method !== "POST").length, 0);
});

test("the send payload references the file and a file-only message is sendable", async () => {
  uploadReply = { status: 200, body: { uploaded: ["sample.csv"], skipped: [], errors: [] } };
  const { container, sent } = await mountInput({ cwd: "/home/alice/project" });
  await upload(container);

  const sendButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Send");
  assert.ok(sendButton, "der Senden-Knopf existiert");
  assert.equal(sendButton.hasAttribute("disabled"), false, "ein Chip allein macht die Nachricht sendbar");

  await act(async () => { reactProps(sendButton, "onClick").onClick({}); });
  assert.deepEqual(sent, ["@sample.csv"], "ein Versand mit der Erwaehnung als ganze Nachricht");
  assert.equal(chips(container).length, 0, "nach dem Senden ist der Chip weg");

  // Der Entwurf nennt die Datei schon: es bleibt bei **einer** Erwaehnung.
  await upload(container);
  const textarea = container.querySelector("textarea");
  await act(async () => {
    reactProps(textarea, "onChange").onChange({ target: { value: "Read @sample.csv and print it" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const sendWithMention = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Send");
  await act(async () => { reactProps(sendWithMention, "onClick").onClick({}); });
  assert.equal(sent[1], "Read @sample.csv and print it");
  assert.equal((sent[1].match(/@sample\.csv(?:\s|$)/g) ?? []).length, 1, "genau eine Erwaehnung im Prompt");

  // Ohne Erwaehnung im Entwurf kommt genau eine dazu.
  await upload(container);
  await act(async () => {
    reactProps(textarea, "onChange").onChange({ target: { value: "read it" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const sendWithoutMention = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Send");
  await act(async () => { reactProps(sendWithoutMention, "onClick").onClick({}); });
  assert.equal(sent[2], "read it @sample.csv");
  assert.equal((sent[2].match(/@sample\.csv(?:\s|$)/g) ?? []).length, 1, "genau eine Erwaehnung, nachgetragen");
});

test("a rejected upload is visible in the composer and localized", async () => {
  uploadReply = { status: 413, body: { error: "Files must be 8 MB or smaller" } };
  const { container } = await mountInput({ cwd: "/home/alice/project" });

  await upload(container, new File(["x"], "big.bin"));

  const alert = container.querySelector('[data-testid="composer-upload-error"]');
  assert.ok(alert, "der Fehler ist sichtbar");
  assert.equal(alert.getAttribute("role"), "alert");
  assert.match(alert.textContent, /Files must be 8 MB or smaller/);
  assert.equal(chips(container).length, 0, "kein Chip fuer eine abgelehnte Datei");
});

test("a name collision is a message, not a silently overwritten file", async () => {
  uploadReply = { status: 200, body: { uploaded: [], skipped: ["sample.csv"], errors: [] } };
  const { container } = await mountInput({ cwd: "/home/alice/project" });

  await upload(container);

  const alert = container.querySelector('[data-testid="composer-upload-error"]');
  assert.ok(alert, "der Konflikt ist sichtbar");
  assert.match(alert.textContent, /A file named sample\.csv already exists here — it was not overwritten/);
  assert.equal(chips(container).length, 0, "die vorhandene Datei bekommt keinen zweiten Chip");
});

test("an oversize file is refused with the localized message and no request", async () => {
  const { container } = await mountInput({ cwd: "/home/alice/project" });

  await upload(container, new File([Buffer.alloc(8 * 1024 * 1024 + 1, 0x61)], "big.bin"));

  const alert = container.querySelector('[data-testid="composer-upload-error"]');
  assert.ok(alert, "die Meldung ist sichtbar");
  assert.match(alert.textContent, /Files must be 8 MB or smaller/);
  assert.equal(uploads.length, 0, "die Grenze greift vor dem Request");
  assert.equal(chips(container).length, 0);
});
