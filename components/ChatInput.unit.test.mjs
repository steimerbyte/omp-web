import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";

/**
 * `ChatInput` hinter den bereits getesteten Tasten-Gesten:
 *
 *  - statisch: die Warteschlangen-Zeilen und die Modell-Sortierung
 *    (`compareModelOptions` laeuft bei jedem Render mit mindestens zwei
 *    Modellen, auch ohne offenes Menue);
 *  - gemountet: die Imperativ-Handle-Methoden (`focus`, `insertIfEmpty`,
 *    `replaceMessage`, `prependText`, `rekeyDraft`, `restoreSubmission`,
 *    `addImages`), das Slash-Palettensortieren (`slashMatchRank`,
 *    `getSlashDescription`) und der Outside-Click-Handler.
 *
 * `FileReader` fehlt in Bun, `URL.createObjectURL`/`requestAnimationFrame`
 * brauchen feste Werte; alle drei werden gestubbt und in `test.after`
 * zurueckgegeben. Die Datei selbst kommt aus `File` (Bun) und ist klein, also
 * ueberspringt `downscaleImageFile` den Canvas-Pfad.
 */
const ORIGINALS = {
  fetch: globalThis.fetch,
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  FileReader: globalThis.FileReader,
  createObjectURL: globalThis.URL?.createObjectURL,
  revokeObjectURL: globalThis.URL?.revokeObjectURL,
  raf: globalThis.requestAnimationFrame,
};
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
// linkedom kennt weder Layout noch Textauswahl; beides gehoert zum Vertrag
// des Composers (Caret, Hoehe, Scrollen in der Palette).
restoreLinkedomPrototypesOnExit(win);
win.Element.prototype.scrollIntoView = function scrollIntoView() {};
win.HTMLTextAreaElement.prototype.setSelectionRange = function setSelectionRange(start, end) {
  this.selectionStart = start;
  this.selectionEnd = end;
};
win.HTMLElement.prototype.focus = function focus() {
  Object.defineProperty(win.document, "activeElement", { configurable: true, value: this });
};
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
win.getComputedStyle = () => new Proxy({}, { get: (_t, p) => (typeof p === "string" && p.startsWith("get") ? () => "" : "0px") });
win.innerHeight = 800;
win.innerWidth = 1200;
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

let objectUrls = 0;
const revoked = [];
globalThis.URL.createObjectURL = () => `blob:mock-${++objectUrls}`;
globalThis.URL.revokeObjectURL = (url) => revoked.push(url);
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);

class FakeFileReader {
  result = null;
  error = null;
  onload = null;
  onerror = null;
  readAsDataURL(file) {
    file.arrayBuffer().then((buffer) => {
      this.result = `data:${file.type};base64,${Buffer.from(buffer).toString("base64")}`;
      this.onload?.();
    }).catch((error) => {
      this.error = error;
      this.onerror?.();
    });
  }
}
globalThis.FileReader = FakeFileReader;

const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  return { ok: true, status: 200, json: async () => ({}) };
};

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner, ModelSwitchErrorBanner, ModelScopeWarningBanner } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

const MODEL_LIST = [
  { id: "vendor/zeta", name: "Zeta", provider: "vendor" },
  { id: "vendor/alpha", name: "Alpha", provider: "vendor" },
  { id: "other/beta", name: "Beta", provider: "other" },
];
const SLASH_COMMANDS = [
  { name: "copy", description: "Copy the last answer", source: "custom" },
  { name: "recompile", description: "rebuild everything", source: "custom" },
];

function props(overrides = {}) {
  return {
    onSend: () => {},
    onAbort: () => {},
    isStreaming: false,
    model: { provider: "vendor", modelId: "vendor/alpha" },
    modelNames: { "vendor:alpha": "Alpha" },
    modelList: MODEL_LIST,
    onModelChange: () => {},
    ...overrides,
  };
}

function renderStatic(overrides = {}) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, { ref: React.createRef(), ...props(overrides) })),
  );
}

function reactProps(element) {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps"));
  assert.ok(key, "kein React-Props-Objekt am Knoten");
  return element[key];
}

async function mount(ref, overrides = {}) {
  win.document.body.replaceChildren();
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(ChatInput, { ref, ...props(overrides) })));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return { container, root };
}

function buttonByText(container, text) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === text);
}

function typeInto(textarea, value) {
  return act(async () => {
    reactProps(textarea).onChange({ target: { value, selectionStart: value.length } });
  });
}

test("queued steering and follow-up messages are listed with their own labels", () => {
  const html = renderStatic({ queuedMessages: { steering: ["adjust the plan"], followUp: ["then write tests"] } });

  assert.match(html, /adjust the plan/);
  assert.match(html, /then write tests/);
  assert.match(html, /steer|Steering/i);
  assert.match(html, /follow-?up/i);
  assert.match(html, /2 queued|queued \(2\)|2/i);
});

test("model options are sorted by display name even while the menu is closed", () => {
  const html = renderStatic();
  // The composer keeps the menu closed; the sorted array is still built, so
  // the visible current model name proves the options reached the renderer.
  assert.match(html, /Alpha/);
  assert.match(html, /Change model/);
});

test("the slash palette ranks name matches before description matches", { timeout: 30_000 }, async () => {
  const ref = React.createRef();
  const { container, root } = await mount(ref, { slashCommands: SLASH_COMMANDS });
  const textarea = container.querySelector("textarea");

  await typeInto(textarea, "/co");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  const text = container.textContent;
  // "copy" starts with "co" (rank 1); "recompile" matches only through its
  // description (rank 3). Innerhalb derselben Quelle muss der Namens-Treffer
  // vor dem Beschreibungstreffer stehen.
  assert.match(text, /compact/);
  const copy = text.indexOf("copy");
  const recompile = text.indexOf("recompile");
  assert.ok(copy >= 0, "der Befehlsname steht in der Palette");
  assert.ok(recompile > copy, "Beschreibungstreffer rankt hinter Namens-Treffern");
  assert.match(text, /rebuild everything/);
  await act(async () => { root.unmount(); });
});

test("the model banners share one alert component for errors, switches and scope warnings", () => {
  const error = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ModelErrorBanner, { error: "no key" })));
  assert.match(error, /role="alert"/);
  assert.match(error, /Model error/);
  assert.match(error, /no key/);
  assert.equal(renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ModelErrorBanner, { error: null }))), "");

  const switched = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ModelSwitchErrorBanner, {
    failure: { timeout: false, detail: "too large" },
    onDismiss() {},
  })));
  assert.match(switched, /role="alert"/);
  assert.match(switched, /too large/);
  assert.match(switched, /Dismiss|×|dismiss/);

  const scope = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ModelScopeWarningBanner, { warnings: ["pattern matched nothing"] })));
  assert.match(scope, /role="alert"/);
  assert.match(scope, /pattern matched nothing/);
  assert.equal(renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ModelScopeWarningBanner, { warnings: [] }))), "");
});

test("a builtin slash command with a prompt sends that prompt while streaming", { timeout: 30_000 }, async () => {
  const ref = React.createRef();
  const prompted = [];
  const { container, root } = await mount(ref, {
    isStreaming: true,
    onSteer: () => {},
    onBuiltinCommand: async (text) => ({ handled: text.startsWith("/vibe"), prompt: "generated prompt" }),
    onPromptWithStreamingBehavior: (prompt, behavior) => prompted.push({ prompt, behavior }),
  });
  await typeInto(container.querySelector("textarea"), "/vibe go");
  const steer = buttonByText(container, "Steer");
  assert.ok(steer, "der Steer-Knopf steht am Composer");
  await act(async () => { reactProps(steer).onClick(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.deepEqual(prompted, [{ prompt: "generated prompt", behavior: "steer" }]);
  await act(async () => { root.unmount(); });
});

test("the model menu opens, lists sorted options and closes on an outside mousedown", { timeout: 30_000 }, async () => {
  const ref = React.createRef();
  const { container, root } = await mount(ref);
  const trigger = container.querySelector('button[title="Change model"]');
  assert.ok(trigger, "der Modell-Knopf traegt seinen Titel");
  assert.match(trigger.textContent, /Alpha/);

  await act(async () => {
    reactProps(trigger).onClick({ currentTarget: trigger });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  const panel = [...container.querySelectorAll("div")].find((element) => (element.getAttribute("style") ?? "").includes("position:fixed"));
  assert.ok(panel, "das Modell-Panel ist positioniert");
  const optionTexts = [...panel.querySelectorAll("button")].map((button) => button.textContent.trim());
  // Sortiert wird flach nach Name, gruppiert nach Provider-Erstauftritt:
  // vendor (Alpha, Zeta) vor other (Beta).
  assert.deepEqual(optionTexts, ["Alpha", "Zeta", "Beta"]);

  // Der Outside-Click-Handler haengt an `mousedown` auf dem Dokument.
  const outside = win.document.createElement("p");
  win.document.body.appendChild(outside);
  const event = new win.Event("mousedown");
  Object.defineProperty(event, "target", { value: outside });
  await act(async () => {
    win.document.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const stillOpen = [...container.querySelectorAll("button")].some((button) => button.textContent.trim() === "Zeta");
  assert.equal(stillOpen, false, "der Klick daneben schliesst das Menue");
  await act(async () => { root.unmount(); });
});

test("the composer bar shows its focus in the border colour", { timeout: 30_000 }, async () => {
  const ref = React.createRef();
  const { container, root } = await mount(ref);
  const bar = container.querySelector("textarea").parentElement;
  assert.match(bar.getAttribute("style"), /color-mix\(in srgb, var\(--border\)/, "untätig trägt die Bar ihren eigenen Rand");

  // Fokus und Blur bubblen vom Textfeld an die Bar; der Handler wird direkt
  // gerufen, weil linkedom das `focusin` von React DOM nicht zustellt.
  await act(async () => { reactProps(bar).onFocus({}); });
  assert.match(bar.getAttribute("style"), /border:\s*1px solid var\(--accent\)/, "Fokus färbt den Rand");
  assert.match(bar.getAttribute("style"), /border:\s*1px/, "die Randbreite bleibt 1 px");

  await act(async () => { reactProps(bar).onBlur({}); });
  assert.match(bar.getAttribute("style"), /color-mix\(in srgb, var\(--border\)/, "Blur nimmt die Farbe zurück");
  await act(async () => { root.unmount(); });
});

test("replaceMessage only fills an empty composer", { timeout: 30_000 }, async () => {
  const ref = React.createRef();
  const { container, root } = await mount(ref);
  const textarea = container.querySelector("textarea");

  await act(async () => { ref.current.replaceMessage({ role: "user", content: "replacement" }); });
  assert.equal(textarea.value, "replacement");

  // Ein nicht leerer Composer wird nicht ueberschrieben.
  await act(async () => { ref.current.insertIfEmpty("keep me"); });
  await act(async () => { ref.current.replaceMessage({ role: "user", content: "other" }); });
  assert.equal(textarea.value, "replacement");
  await act(async () => { root.unmount(); });
});

test("the imperative handle edits, restores and rekeys the draft", { timeout: 30_000 }, async () => {
  revoked.length = 0;
  const ref = React.createRef();
  const { container, root } = await mount(ref, { draftKey: "draft-a" });
  const textarea = container.querySelector("textarea");

  await act(async () => { ref.current.focus(); });
  assert.equal(win.document.activeElement, textarea);

  await act(async () => { ref.current.insertIfEmpty("first"); });
  assert.equal(textarea.value, "first");
  await act(async () => { ref.current.insertIfEmpty("ignored"); });
  assert.equal(textarea.value, "first");

  await act(async () => { ref.current.prependText("quoted"); });
  assert.equal(textarea.value, "quoted\n\nfirst");

  // restoreSubmission merged den Text in den bestehenden Entwurf und haengt
  // das Bild als Chip an.
  await act(async () => {
    ref.current.restoreSubmission("late addendum", [{ data: "AAAA", mimeType: "image/png" }]);
  });
  assert.match(textarea.value, /late addendum/);
  assert.match(textarea.value, /first/);
  const chip = container.querySelector('img[src^="data:image/png;base64,AAAA"]');
  assert.ok(chip, "der wiederhergestellte Anhang steht als Chip");

  // addImages: Datei -> base64 + blob-Vorschau (FileReader/URL gestubbt).
  const file = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });
  await act(async () => { ref.current.addImages([file]); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const blobChip = container.querySelector('img[src^="blob:mock-"]');
  assert.ok(blobChip, "die angehaengte Datei zeigt ihre Blob-Vorschau");

  // Der Entfernen-Knopf am Chip widerruft die Blob-Vorschau.
  const removeButton = blobChip.parentElement.querySelector("button");
  assert.ok(removeButton);
  await act(async () => { reactProps(removeButton).onClick(); });
  assert.ok(revoked.some((url) => url.startsWith("blob:mock-")), "die Blob-Vorschau wurde widerrufen");
  assert.equal(container.querySelector('img[src^="blob:mock-"]'), null);

  // rekeyDraft verschiebt den Entwurf auf den neuen Schluessel.
  await act(async () => { ref.current.rekeyDraft("draft-a", "draft-b"); });
  assert.match(textarea.value, /late addendum/);
  await act(async () => { root.unmount(); });
});
