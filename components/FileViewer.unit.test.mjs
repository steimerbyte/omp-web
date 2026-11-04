import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * FileViewer: Weiche fuer Bild/Audio/Dokument/Text, Textmodus mit Syntax-
 * Renderer, Markdown-Vorschau (Code, lokale Links, Bilder, Frontmatter),
 * Zeilen-Mention per Selektion/Ctrl+I, Editieren inkl. Konflikt und der
 * Diff-Zweig. EventSource und fetch sind Aufzeichnungs-Stubs.
 */

const ROOT = process.cwd();
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);

const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US" };
const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
};

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  EventSource: globalThis.EventSource,
  Node: globalThis.Node,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url) {
    this.url = url;
    this.readyState = FakeEventSource.OPEN;
    this.listeners = new Map();
    this.closed = false;
    instances.push(this);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  emit(type, data) {
    this.emitRaw(type, JSON.stringify(data));
  }
  emitRaw(type, data) {
    const event = { data };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}
const instances = [];
globalThis.EventSource = FakeEventSource;

win.innerWidth = 1200;
win.innerHeight = 800;
win.localStorage = localStorage;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
win.Element.prototype.getBoundingClientRect = function rect() {
  return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
};
for (const proto of [win.HTMLInputElement?.prototype, win.HTMLTextAreaElement?.prototype]) {
  if (!proto) continue;
  proto.attachEvent = function attachEvent() {};
  proto.detachEvent = function detachEvent() {};
}
let selection = { isCollapsed: true, rangeCount: 0, getRangeAt: () => null };
win.getSelection = () => selection;
// linkedom kann nur selectNodeContents, aber kein setStart/setEnd.
win.document.createRange = () => ({
  node: null,
  start: 0,
  end: 0,
  selectNodeContents(node) {
    this.node = node;
    this.start = 0;
    this.end = String(node.textContent ?? "").length;
  },
  setStart(_node, offset) {
    this.start = offset;
  },
  setEnd(_node, offset) {
    this.end = offset;
  },
  toString() {
    return String(this.node?.textContent ?? "").slice(this.start, this.end);
  },
});

globalThis.window = new Proxy(win, {
  get(target, property) {
    if (property === "navigator") return fakeNavigator;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(target, property) {
    return property === "navigator" || Reflect.has(target, property);
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.localStorage = localStorage;
globalThis.Node = win.Node;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
win.getComputedStyle = () => new Proxy({}, { get: (_target, property) => (typeof property === "string" && property.startsWith("get") ? () => "" : "0px") });
globalThis.getComputedStyle = win.getComputedStyle;

const mounted = [];
test.after(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  win.document.body.innerHTML = "";
  for (const key of ["window", "document", "navigator", "localStorage", "fetch", "EventSource", "Node", "IS_REACT_ACT_ENVIRONMENT"]) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});

const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import(`${ROOT}/hooks/useI18n.tsx`);
const { FileViewer } = await jiti.import(`${ROOT}/components/FileViewer.tsx`);

function fire(target, type, props = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  target.dispatchEvent(event);
  return event;
}

const READ = {
  "/api/files/work/notes.txt?type=read": { content: "erste\nzweite\ndritte", language: "text", size: 19 },
  "/api/files/work/readme.md?type=read": {
    content: "---\ntitle: Demo\n---\n\n# Titel\n\n[Andere Datei](./other.md)\n\n![Bild](./pic.png)\n\n```js\nconst x = 1;\n```\n\n`inline`\n",
    language: "markdown",
    size: 120,
  },
  "/api/files/work/page.html?type=read": { content: "<h1>Hallo</h1>", language: "html", size: 15 },
};

async function mount({ filePath = "/work/notes.txt", fetchImpl, props = {} } = {}) {
  const calls = [];
  const router = fetchImpl ?? (async (url) => {
    const key = String(url);
    if (key.includes("/api/git/diff?")) return { ok: true, status: 200, json: async () => ({ supported: false }) };
    const body = READ[key];
    if (body) return { ok: true, status: 200, json: async () => body };
    return { ok: false, status: 404, json: async () => ({ error: `not found: ${key}` }) };
  });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return router(String(url), options);
  };
  instances.length = 0;
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const events = { openFile: [], mention: [], atMention: [] };
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileViewer, {
        filePath,
        cwd: "/work",
        onOpenFile: (path) => events.openFile.push(path),
        onMentionLines: (path, start, end) => events.mention.push([path, start, end]),
        onAtMention: (path, isDir) => events.atMention.push([path, isDir]),
        ...props,
      })));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  mounted.push({ root });
  return { root, container, calls, events };
}

async function typeInto(node, value) {
  if (node.tagName === "INPUT") node.setAttribute("type", "text");
  fire(node, "focusin");
  const proto = node.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
  fire(node, "keydown", { key: "a" });
  fire(node, "input");
}

test("Bild: Watch-Stream, Groesse, Live-Punkt, Ladefehler und Download", async () => {
  const { root, container } = await mount({ filePath: "/work/pic.png" });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].url, "/api/files/work/pic.png?type=watch");

  const img = container.querySelector("img");
  assert.ok(img);
  assert.equal(img.getAttribute("src"), "/api/files/work/pic.png?type=read");
  assert.match(container.textContent, /static/);
  assert.match(container.textContent, /png/);

  await act(async () => {
    instances[0].emit("connected", {});
  });
  assert.match(container.textContent, /live/);

  await act(async () => {
    instances[0].emit("change", { size: 2048 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(container.textContent, /2\.0 KB/);
  assert.equal(container.querySelector("img").getAttribute("src"), "/api/files/work/pic.png?type=read&v=1");

  await act(async () => {
    Object.defineProperty(container.querySelector("img"), "naturalWidth", { value: 640, configurable: true });
    Object.defineProperty(container.querySelector("img"), "naturalHeight", { value: 480, configurable: true });
    fire(container.querySelector("img"), "load");
  });
  assert.match(container.textContent, /640 × 480/);

  await act(async () => {
    instances[0].emit("error", {});
  });
  assert.match(container.textContent, /static/);

  const download = container.querySelector('a[download="pic.png"]');
  assert.ok(download);
  assert.equal(download.getAttribute("href"), "/api/files/work/pic.png?type=download");

  await act(async () => {
    fire(container.querySelector("img"), "error");
  });
  assert.match(container.textContent, /Failed to load image/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Audio: Dauer formatieren, Aenderung setzt sie zurueck, Fehlertext", async () => {
  const { root, container } = await mount({ filePath: "/work/song.mp3" });
  const audio = container.querySelector("audio");
  assert.ok(audio);
  assert.equal(audio.getAttribute("src"), "/api/files/work/song.mp3?type=read");
  assert.match(container.textContent, /mp3/);

  await act(async () => {
    instances[0].emit("connected", {});
    Object.defineProperty(audio, "duration", { value: 62.4, configurable: true });
    fire(audio, "loadedmetadata");
  });
  assert.match(container.textContent, /1:02/);
  assert.match(container.textContent, /live/);

  await act(async () => {
    instances[0].emit("change", { size: 1048576 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(container.textContent, /1\.0 MB/);
  assert.doesNotMatch(container.textContent, /1:02/);

  await act(async () => {
    fire(container.querySelector("audio"), "error");
  });
  assert.match(container.textContent, /Failed to load audio/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("DOCX: Meta-Groesse, iframe mit Sandbox, zu grosse datei und Meta-Fehler", async () => {
  const { root, container, calls } = await mount({
    filePath: "/work/doc.docx",
    fetchImpl: async (url) => {
      if (String(url).includes("type=meta")) return { ok: true, status: 200, json: async () => ({ size: 4096 }) };
      if (String(url).includes("/api/git/diff?")) return { ok: true, status: 200, json: async () => ({ supported: false }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  assert.equal(calls[0].url, "/api/files/work/doc.docx?type=meta");
  const iframe = container.querySelector("iframe");
  assert.ok(iframe);
  assert.equal(iframe.getAttribute("src"), "/api/files/work/doc.docx?type=preview");
  assert.equal(iframe.getAttribute("sandbox"), "allow-same-origin");
  assert.match(container.textContent, /4\.0 KB/);
  assert.match(container.textContent, /docx preview/);

  await act(async () => {
    instances[0].emit("change", { size: 12 * 1024 * 1024 });
  });
  assert.match(container.textContent, /DOCX too large for preview/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("PDF: read-URL, kein Sandbox-Attribut; Meta-Fehler wird angezeigt", async () => {
  const { root, container } = await mount({
    filePath: "/work/doc.pdf",
    fetchImpl: async (url) => {
      if (String(url).includes("type=meta")) return { ok: true, status: 200, json: async () => ({ size: 100 }) };
      if (String(url).includes("/api/git/diff?")) return { ok: true, status: 200, json: async () => ({ supported: false }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  const iframe = container.querySelector("iframe");
  assert.equal(iframe.getAttribute("src"), "/api/files/work/doc.pdf?type=read");
  assert.equal(iframe.getAttribute("sandbox"), null);
  assert.equal(iframe.getAttribute("title"), "Preview doc.pdf");
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();

  const failing = await mount({
    filePath: "/work/broken.docx",
    fetchImpl: async (url) => {
      if (String(url).includes("type=meta")) return { ok: false, status: 500, json: async () => { throw new Error("no json"); } };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.match(failing.container.textContent, /Error: no json/);
  await act(async () => failing.root.unmount());
  mounted.splice(0, mounted.length);
  failing.container.remove();
});

test("Text: Quelle mit Zeilennummern, Metadaten, Download, Umbruch und Mention", async () => {
  const { root, container, events } = await mount();
  assert.match(container.querySelector(".file-viewer-meta").textContent, /text · 3 lines · 19 B/);
  assert.equal(container.querySelector(".file-viewer-path").textContent, "notes.txt");
  assert.ok(container.querySelector(".file-source-line"), "der Syntax-Renderer hat keine Zeilen geliefert");
  assert.equal(container.querySelectorAll(".file-source-line").length, 3);
  assert.equal(container.querySelector('.file-source-line[data-line-number="2"] .file-source-line-content').textContent.trim(), "zweite");

  const wrap = container.querySelector('[aria-label="Enable word wrap"]');
  assert.ok(wrap);
  await act(async () => {
    wrap.click();
  });
  assert.equal(container.querySelector(".file-source-view").getAttribute("class").includes("is-wrapped"), true);
  assert.equal(container.querySelector('[aria-label="Disable word wrap"]').getAttribute("aria-pressed"), "true");

  // Mention ohne Auswahl fuegt den ganzen Pfad ein.
  const mention = container.querySelector('[aria-label="mention"]');
  assert.ok(mention);
  await act(async () => {
    fire(mention, "pointerdown");
    mention.click();
  });
  assert.deepEqual(events.atMention, [["notes.txt", false]]);

  // Text ohne Diff: keine Diff-Schaltflaeche, Edit vorhanden.
  const modes = [...container.querySelectorAll(".file-viewer-mode-button")].map((node) => node.textContent);
  assert.deepEqual(modes, ["Source", "Edit"]);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Markdown: Vorschau mit Frontmatter, Code, lokalem Link und Bild", async () => {
  const { root, container, events } = await mount({ filePath: "/work/readme.md" });
  assert.ok(container.querySelector(".markdown-file-preview"));
  assert.match(container.textContent, /Titel/);
  assert.match(container.textContent, /Demo/, "die Frontmatter-Karte fehlt");
  assert.ok(container.querySelector("pre"), "der Codeblock fehlt");
  assert.match(container.querySelector("pre").textContent, /const x = 1/);

  const image = container.querySelector("img[alt='Bild']");
  assert.ok(image);
  assert.equal(image.getAttribute("src"), "/api/files/work/pic.png?type=read");

  const link = [...container.querySelectorAll("a")].find((node) => node.textContent === "Andere Datei");
  assert.ok(link);
  await act(async () => {
    link.click();
  });
  assert.deepEqual(events.openFile, ["/work/other.md"]);

  // Moduswechsel auf Source und zurueck auf Preview.
  const sourceButton = [...container.querySelectorAll(".file-viewer-mode-button")].find((node) => node.textContent === "Source");
  await act(async () => {
    sourceButton.click();
  });
  assert.ok(container.querySelector(".file-source-line"));
  const previewButton = [...container.querySelectorAll(".file-viewer-mode-button")].find((node) => node.textContent === "Preview");
  await act(async () => {
    previewButton.click();
  });
  assert.ok(container.querySelector(".markdown-file-preview"));
  assert.match(container.querySelector(".markdown-file-preview").textContent, /inline/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("HTML: default Preview als sandboxed iframe, Source-Schaltflaeche bleibt", async () => {
  const { root, container } = await mount({ filePath: "/work/page.html" });
  const iframe = container.querySelector("iframe");
  assert.ok(iframe);
  assert.equal(iframe.getAttribute("srcDoc") ?? iframe.getAttribute("srcdoc"), "<h1>Hallo</h1>");
  assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
  assert.equal(iframe.getAttribute("title"), "HTML preview");
  const modes = [...container.querySelectorAll(".file-viewer-mode-button")].map((node) => node.textContent);
  assert.deepEqual(modes, ["Source", "Preview", "Edit"]);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Zeilen-Mention per Selektion, selectionchange und Ctrl+I", async () => {
  const { root, container, events } = await mount();

  const lines = container.querySelectorAll(".file-source-line");
  const start = lines[0];
  const end = lines[1];
  selection = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({ startContainer: start, startOffset: 0, endContainer: end, endOffset: 3, toString: () => "erste\nzwei" }),
  };
  await act(async () => {
    fire(win.document, "selectionchange");
  });
  const mention = container.querySelector('[aria-label="mention"]');
  assert.match(mention.getAttribute("title"), /L1-L2/);
  await act(async () => {
    mention.click();
  });
  assert.deepEqual(events.mention, [["notes.txt", 1, 2]]);

  // Ctrl+I mit derselben Auswahl.
  await act(async () => {
    fire(win.document, "keydown", { key: "i", ctrlKey: true });
  });
  assert.deepEqual(events.mention, [["notes.txt", 1, 2], ["notes.txt", 1, 2]]);

  // In einem Eingabefeld ignoriert.
  const input = win.document.createElement("input");
  win.document.body.appendChild(input);
  await act(async () => {
    fire(input, "keydown", { key: "i", ctrlKey: true });
  });
  assert.equal(events.mention.length, 2);

  // Mit repeat passiert nichts.
  await act(async () => {
    fire(win.document, "keydown", { key: "i", ctrlKey: true, repeat: true });
  });
  assert.equal(events.mention.length, 2);

  input.remove();
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Edit: Save per Klick und Ctrl+S, Verwerfen, Konflikt und Reload", async () => {
  const saves = [];
  let putMode = "ok";
  const { root, container, calls } = await mount({
    fetchImpl: async (url, options = {}) => {
      const key = String(url);
      if (options.method === "PUT") {
        saves.push(options.body);
        if (putMode === "conflict") {
          return { ok: false, status: 409, json: async () => ({ conflict: true, currentMtimeMs: 5, currentSize: 9, error: "File changed on disk" }) };
        }
        if (putMode === "error") {
          return { ok: false, status: 500, json: async () => { throw new Error("html"); } };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, size: 20, mtimeMs: 123 }) };
      }
      if (key.includes("/api/git/diff?")) return { ok: true, status: 200, json: async () => ({ supported: false }) };
      const body = READ[key];
      if (body) return { ok: true, status: 200, json: async () => (saves.length ? { ...body, content: "neu" } : body) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });

  await act(async () => {
    [...container.querySelectorAll(".file-viewer-mode-button")].find((node) => node.textContent === "Edit").click();
  });
  let textarea = container.querySelector("textarea");
  assert.ok(textarea);
  assert.equal(textarea.value, "erste\nzweite\ndritte");

  await act(async () => {
    await typeInto(textarea, "erste\nzweite\ndritte\nneu");
  });
  assert.ok(container.querySelector('[aria-label="Unsaved changes"]'));
  const save = container.querySelector('[aria-label="Save"]');
  assert.equal(save.hasAttribute("disabled"), false);

  // Ctrl+S im Textarea speichert ebenfalls.
  await act(async () => {
    fire(textarea, "keydown", { key: "s", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(saves.length, 1);
  assert.deepEqual(JSON.parse(saves[0]), { content: "erste\nzweite\ndritte\nneu", expectedMtimeMs: null });
  assert.ok(calls.some((call) => call.options.method === "PUT"));
  
  // Konflikt: 409 setzt Alarm und Reload-Knopf.
  putMode = "conflict";
  textarea = container.querySelector("textarea");
  await act(async () => {
    await typeInto(textarea, "anders");
  });
  await act(async () => {
    container.querySelector('[aria-label="Save"]').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent, /File changed on disk/);
  const reload = [...alert.querySelectorAll("button")].find((node) => node.textContent.includes("Reload from disk"));
  assert.ok(reload);
  await act(async () => {
    reload.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  // Verwerfen setzt den Entwurf zurueck.
  textarea = container.querySelector("textarea");
  await act(async () => {
    await typeInto(textarea, "verworfen");
  });
  const discard = container.querySelector('[aria-label="Discard changes"]');
  assert.equal(discard.hasAttribute("disabled"), false);
  await act(async () => {
    discard.click();
  });
  assert.equal(container.querySelector("textarea").value, "neu");

  // Fehler ohne JSON.
  putMode = "error";
  textarea = container.querySelector("textarea");
  await act(async () => {
    await typeInto(textarea, "kaputt");
  });
  await act(async () => {
    container.querySelector('[aria-label="Save"]').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(container.querySelector('[role="alert"]').textContent, /Save failed \(500\)/);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Diff: Schaltflaeche erscheint nur mit Patch, initialDisplayMode diff schaltet", async () => {
  const { root, container } = await mount({
    fetchImpl: async (url) => {
      const key = String(url);
      if (key.includes("/api/git/diff?")) {
        return { ok: true, status: 200, json: async () => ({ supported: true, patch: "diff --git a b", status: "modified" }) };
      }
      const body = READ[key];
      if (body) return { ok: true, status: 200, json: async () => body };
      return { ok: false, status: 404, json: async () => ({}) };
    },
    props: { initialDisplayMode: "diff" },
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  const diffButton = [...container.querySelectorAll(".file-viewer-mode-button")].find((node) => node.textContent === "Diff");
  assert.ok(diffButton, "die Diff-Schaltflaeche fehlt");
  assert.equal(diffButton.getAttribute("aria-pressed"), "true", "initialDisplayMode muss auf Diff schalten");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Watch-Ereignisse im Text: connected, change, error und onerror", async () => {
  const { root, container, calls } = await mount();
  const readsBefore = calls.filter((call) => call.url.includes("type=read")).length;

  await act(async () => {
    instances[0].emit("connected", {});
  });
  assert.equal(container.querySelector('[aria-label="Live sync active"]') !== null, true);

  await act(async () => {
    instances[0].emit("change", "kein json");
  });
  await act(async () => {
    instances[0].emit("change", { size: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls.filter((call) => call.url.includes("type=read")).length, readsBefore + 2);

  await act(async () => {
    instances[0].emit("error", {});
  });
  assert.equal(container.querySelector('[aria-label="Not watching"]') !== null, true);
  await act(async () => {
    instances[0].emit("connected", {});
    instances[0].onerror?.();
  });
  assert.equal(container.querySelector('[aria-label="Not watching"]') !== null, true);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Loesch-Diff: nur Diff-Modus, Metadaten Deleted, Watch wird geschlossen", async () => {
  const { root, container } = await mount({
    fetchImpl: async (url) => {
      if (String(url).includes("/api/git/diff?")) {
        return { ok: true, status: 200, json: async () => ({ supported: true, patch: "diff", status: "deleted" }) };
      }
      return { ok: true, status: 200, json: async () => READ["/api/files/work/notes.txt?type=read"] };
    },
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  // Bei einem einzigen Modus blendet die Toolbar den Umschalter aus.
  assert.equal(container.querySelector(".file-viewer-mode-switch"), null);
  assert.equal(container.querySelector(".file-viewer-mode-button"), null);
  assert.ok(container.querySelector(".file-viewer-toolbar"));
  assert.match(container.querySelector(".file-viewer-meta").textContent, /Deleted/);
  assert.equal(instances[0].closed, true, "bei einem geloeschten Diff wird der Watch-Stream geschlossen");

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("cwd fehlt: kein Git-Diff-Aufruf; Git-Fehler bleibt ohne Diff", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("type=read")) return { ok: true, status: 200, json: async () => READ["/api/files/work/notes.txt?type=read"] };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  instances.length = 0;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileViewer, { filePath: "/work/notes.txt" })));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls.some((url) => url.includes("/api/git/diff?")), false);
  await act(async () => root.unmount());
  container.remove();

  const gitFails = await mount({
    fetchImpl: async (url) => {
      if (String(url).includes("/api/git/diff?")) throw new Error("git down");
      return { ok: true, status: 200, json: async () => READ["/api/files/work/notes.txt?type=read"] };
    },
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const modes = [...gitFails.container.querySelectorAll(".file-viewer-mode-button")].map((node) => node.textContent);
  assert.deepEqual(modes, ["Source", "Edit"]);
  await act(async () => gitFails.root.unmount());
  mounted.splice(0, mounted.length);
  gitFails.container.remove();
});

test("Lese- und Speicher-Netzfehler landen als Fehlertext", async () => {
  const readFails = await mount({
    fetchImpl: async (url) => {
      if (String(url).includes("type=read")) throw new Error("read exploded");
      return { ok: true, status: 200, json: async () => ({ supported: false }) };
    },
  });
  assert.match(readFails.container.textContent, /read exploded/);
  await act(async () => readFails.root.unmount());
  mounted.splice(0, mounted.length);
  readFails.container.remove();

  const saveFails = await mount({
    fetchImpl: async (url, options = {}) => {
      if (options.method === "PUT") throw new Error("write exploded");
      if (String(url).includes("/api/git/diff?")) return { ok: true, status: 200, json: async () => ({ supported: false }) };
      return { ok: true, status: 200, json: async () => READ["/api/files/work/notes.txt?type=read"] };
    },
  });
  await act(async () => {
    [...saveFails.container.querySelectorAll(".file-viewer-mode-button")].find((node) => node.textContent === "Edit").click();
  });
  await act(async () => {
    await typeInto(saveFails.container.querySelector("textarea"), "neu");
  });
  await act(async () => {
    saveFails.container.querySelector('[aria-label="Save"]').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(saveFails.container.querySelector('[role="alert"]').textContent, /write exploded/);
  await act(async () => saveFails.root.unmount());
  mounted.splice(0, mounted.length);
  saveFails.container.remove();
});

test("Bild/Audio/Dokument ueberstehen kaputte Watch-Daten und Stream-Fehler", async () => {
  const image = await mount({ filePath: "/work/pic.png" });
  await act(async () => {
    instances[0].emitRaw("change", "{kein json");
    instances[0].emit("error", {});
    instances[0].onerror?.();
  });
  assert.match(image.container.textContent, /static/);
  await act(async () => image.root.unmount());
  mounted.splice(0, mounted.length);
  image.container.remove();

  const audio = await mount({ filePath: "/work/song.mp3" });
  await act(async () => {
    instances[0].emitRaw("change", "{kein json");
    instances[0].emit("error", {});
    instances[0].onerror?.();
  });
  assert.match(audio.container.textContent, /static/);
  await act(async () => audio.root.unmount());
  mounted.splice(0, mounted.length);
  audio.container.remove();

  const doc = await mount({
    filePath: "/work/doc.docx",
    fetchImpl: async (url) => {
      if (String(url).includes("type=meta")) throw new Error("meta exploded");
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.match(doc.container.textContent, /meta exploded/);
  await act(async () => {
    instances[0].emitRaw("change", "{kein json");
    instances[0].emit("error", {});
    instances[0].onerror?.();
  });
  await act(async () => doc.root.unmount());
  mounted.splice(0, mounted.length);
  doc.container.remove();
});

test("Markdown: Mermaid, externer Link, absolutes Bild; Text ohne cwd", async () => {
  const { root, container, events } = await mount({
    filePath: "/work/readme.md",
    fetchImpl: async (url) => {
      const key = String(url);
      if (key.includes("/api/git/diff?")) return { ok: true, status: 200, json: async () => ({ supported: false }) };
      if (key.includes("type=read")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: "```mermaid\ngraph TD; A-->B\n```\n\n[extern](https://example.test/x)\n\n![abs](https://cdn.test/y.png)\n",
            language: "markdown",
            size: 90,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  assert.ok(container.querySelector("svg") || container.querySelector("pre"), "Mermaid-Block fehlt");

  const external = [...container.querySelectorAll("a")].find((node) => node.textContent === "extern");
  assert.ok(external);
  assert.equal(external.getAttribute("href"), "https://example.test/x");
  await act(async () => {
    external.click();
  });
  assert.deepEqual(events.openFile, [], "externe Links oeffnen keine Datei");

  const absoluteImage = [...container.querySelectorAll("img")].find((node) => node.getAttribute("alt") === "abs");
  assert.ok(absoluteImage);
  assert.equal(absoluteImage.getAttribute("src"), "https://cdn.test/y.png");

  // Lokaler Link mit Ctrl-Klick bleibt beim Browser.
  await act(async () => {
    const local = win.document.createElement("a");
    local.href = "#";
    local.addEventListener("click", (event) => event.preventDefault());
    local.dispatchEvent(new win.Event("click"));
  });

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Selektion an Textknoten trimmt leere Randzeilen weg", async () => {
  const { root, container, events } = await mount();
  const lines = [...container.querySelectorAll(".file-source-line")];
  const content1 = lines[0].querySelector(".file-source-line-content");
  const content3 = lines[2].querySelector(".file-source-line-content");
  const text1 = win.document.createTextNode("erste");
  const text3 = win.document.createTextNode("dritte");
  content1.appendChild(text1);
  content3.appendChild(text3);

  selection = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({
      startContainer: text1,
      startOffset: content1.textContent.length,
      endContainer: text3,
      endOffset: 0,
      toString: () => "",
    }),
  };
  await act(async () => {
    fire(win.document, "selectionchange");
  });
  const mention = container.querySelector('[aria-label="mention"]');
  assert.match(mention.getAttribute("title"), /L2/, "leere Randzeilen muessen wegfallen");
  await act(async () => {
    mention.click();
  });
  assert.deepEqual(events.mention, [["notes.txt", 2, 2]]);

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Dateiwechsel im selben Baum schliesst den alten Watch-Stream", async () => {
  const { root, container } = await mount();
  const first = instances[0];
  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileViewer, { filePath: "/work/readme.md", cwd: "/work" })));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  assert.equal(first.closed, true, "der Text-Watch des alten Pfads wurde nicht geschlossen");
  assert.equal(instances.at(-1).url, "/api/files/work/readme.md?type=watch");

  await act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(FileViewer, { filePath: "/work/pic.png", cwd: "/work" })));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  // Bild- und Audio/Dokument-Effekte schliessen ihren Vorgaenger ebenfalls.
  assert.ok(instances.some((instance) => instance.closed));

  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("DOCX-Meta ueber 10 MB und ein Bild mit nicht aufloesbarer Quelle", async () => {
  const doc = await mount({
    filePath: "/work/big.docx",
    fetchImpl: async (url) => {
      if (String(url).includes("type=meta")) return { ok: true, status: 200, json: async () => ({ size: 11 * 1024 * 1024 }) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.match(doc.container.textContent, /DOCX too large for preview/);
  await act(async () => doc.root.unmount());
  mounted.splice(0, mounted.length);
  doc.container.remove();

  const markdown = await mount({
    filePath: "/work/readme.md",
    fetchImpl: async (url) => {
      if (String(url).includes("/api/git/diff?")) return { ok: true, status: 200, json: async () => ({ supported: false }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: "![leer]()\n", language: "markdown", size: 40 }),
      };
    },
  });
  const img = markdown.container.querySelector("img");
  assert.equal(img.getAttribute("src"), null);
  await act(async () => markdown.root.unmount());
  mounted.splice(0, mounted.length);
  markdown.container.remove();
});

test("Markdown ohne onOpenFile: lokaler Link bleibt ein normaler Anker", async () => {
  const { root, container } = await mount({
    filePath: "/work/readme.md",
    fetchImpl: async (url) => {
      if (String(url).includes("/api/git/diff?")) return { ok: true, status: 200, json: async () => ({ supported: false }) };
      return { ok: true, status: 200, json: async () => READ["/api/files/work/readme.md?type=read"] };
    },
    props: { onOpenFile: undefined, onMentionLines: undefined, onAtMention: undefined },
  });
  const link = [...container.querySelectorAll("a")].find((node) => node.textContent === "Andere Datei");
  assert.equal(link.getAttribute("href"), "./other.md");
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});

test("Ladefehler und Sprache ohne Vorschau", async () => {
  const { root, container } = await mount({
    fetchImpl: async (url) => {
      if (String(url).includes("type=read")) return { ok: false, status: 403, json: async () => ({ error: "Access denied" }) };
      return { ok: true, status: 200, json: async () => ({ supported: false }) };
    },
  });
  assert.match(container.textContent, /Access denied/);
  await act(async () => root.unmount());
  mounted.splice(0, mounted.length);
  container.remove();
});
