import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * Die Renderer von `MessageView` jenseits der bereits getesteten Tool-Karten.
 *
 * Aufgeteilt in zwei Schichten:
 *  - statisch (`renderToStaticMarkup`) fuer alles, was nur Props -> Markup
 *    abbildet: Nutzerblase, usage-Zeile, Compaction-Block, Custom-Nachricht,
 *    Diff-Karten, Bash-Ausgabe und der "zu gross"-Knopf;
 *  - gemountet fuer alles, was einen Klick, einen Effekt, `fetch` oder ein
 *    zweites Rendern braucht: Kopieren, deferred Thinking, Bash-Nachladen,
 *    die Token-Schaetzung waehrend des Streams und der Memo-Vergleich.
 *
 * `fetch`, `navigator.clipboard` und die DOM-Globals werden gestubbt und in
 * `test.after` zurueckgegeben.
 */
const ORIGINALS = {
  fetch: globalThis.fetch,
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
const fakeNavigator = {
  userAgent: "test",
  languages: ["en-US"],
  language: "en-US",
  platform: "linux",
  clipboard: { writeText: async () => {} },
};
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

const fetchCalls = [];
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
globalThis.fetch = (url, init) => {
  fetchCalls.push(String(url));
  return fetchImpl(String(url), init);
};

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { setShowHiddenMessages, SHOW_HIDDEN_MESSAGES_STORAGE_KEY } = await jiti.import("../hooks/useShowHiddenMessages.ts");

const TWO_FILE_PATCH = `--- a/alpha.ts
+++ b/alpha.ts
@@ -1,2 +1,2 @@
-const alpha = 1;
+const alpha = 2;
 const shared = 0;
--- a/beta.ts
+++ b/beta.ts
@@ -1,2 +1,1 @@
-old beta
-also old
+new beta
`;

const toolResults = (entries) => new Map(entries.map((entry) => [entry.toolCallId, entry]));

function render(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

async function mount(element) {
  win.document.body.replaceChildren();
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(I18nProvider, null, element)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return { container, root };
}

function reactProps(element) {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps"));
  assert.ok(key, "kein React-Props-Objekt am Knoten");
  return element[key];
}

async function click(element, extra = {}) {
  const handler = reactProps(element).onClick;
  assert.equal(typeof handler, "function", "der Knoten hat einen onClick-Handler");
  await act(async () => {
    handler({ target: element, currentTarget: element, defaultPrevented: false, preventDefault() {}, ...extra });
  });
}

function buttonByText(container, text) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === text);
}

test("a user bubble shows images, text, timestamp and fork/navigate actions", () => {
  const html = render({
    role: "user",
    timestamp: Date.now(),
    content: [
      { type: "text", text: "Look at this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", data: "BBBB", mimeType: "image/jpeg" },
    ],
  }, {
    entryId: "e1",
    onFork() {},
    prevAssistantEntryId: "a0",
    onNavigate() {},
    forking: false,
  });

  assert.match(html, /Look at this/);
  assert.match(html, /src="data:image\/png;base64,AAAA"/);
  assert.match(html, /src="data:image\/jpeg;base64,BBBB"/);
  assert.match(html, /New session/);
  assert.match(html, /Edit from here/);
  assert.match(html, /Copy/);
});

test("assistant usage, model name and written files are rendered", () => {
  const html = render({
    role: "assistant",
    provider: "test",
    model: "model-a",
    timestamp: Date.now(),
    content: [{ type: "text", text: "All done" }],
    usage: { input: 1200, output: 3456, cacheRead: 7, cacheWrite: 8, cost: { total: 0.0123 } },
  }, {
    modelNames: { "test:model-a": "Model A" },
    writtenFiles: [{ filePath: "/work/out.txt" }],
  });

  assert.match(html, /Model A/);
  assert.match(html, /1,200 in/);
  assert.match(html, /3,456 out/);
  assert.match(html, /7 cache R/);
  assert.match(html, /8 cache W/);
  assert.match(html, /\$0\.0123/);
  assert.match(html, /out\.txt/);
  assert.match(html, /All done/);
});

test("a patch result renders the split diff with file headers and empty cells", () => {
  const html = render({
    role: "assistant",
    content: [
      { type: "toolCall", toolCallId: "t1", toolName: "apply_patch", input: { patch: "x" } },
      { type: "text", text: "done" },
    ],
  }, {
    toolResults: toolResults([{
      role: "toolResult",
      toolCallId: "t1",
      toolName: "apply_patch",
      content: [{ type: "text", text: "applied" }],
      isError: false,
      details: { patch: TWO_FILE_PATCH },
    }]),
  });

  // Both file headers, in a grid of two columns.
  assert.match(html, /alpha\.ts/);
  assert.match(html, /beta\.ts/);
  // Added/removed/context markers and a padded empty cell.
  assert.match(html, /\+2/);
  assert.match(html, /−2|2 lines added/);
  assert.match(html, />\s*\+\s*</);
  assert.match(html, />\s*-\s*</);
});

test("a diff-shaped string that is not a unified patch falls back to line text", () => {
  const html = render({
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "t2", toolName: "apply_patch", input: {} }],
  }, {
    toolResults: toolResults([{
      role: "toolResult",
      toolCallId: "t2",
      toolName: "apply_patch",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      details: { diff: "prose that is not a patch\n+ plus a line" },
    }]),
  });

  assert.match(html, /prose that is not a patch/);
  assert.match(html, /plus a line/);
});

test("an error result renders the paired error block and an empty one says so", () => {
  const error = render({
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "t3", toolName: "read", input: { path: "/x" } }],
  }, {
    toolResults: toolResults([{
      role: "toolResult",
      toolCallId: "t3",
      toolName: "read",
      content: [{ type: "text", text: "ENOENT: no such file" }],
      isError: true,
    }]),
  });
  assert.match(error, /ENOENT: no such file/);

  const empty = render({
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "t4", toolName: "read", input: { path: "/x" } }],
  }, {
    toolResults: toolResults([{
      role: "toolResult",
      toolCallId: "t4",
      toolName: "read",
      content: [],
      isError: true,
    }]),
  });
  assert.match(empty, /\(no output\)/);
});

test("a compaction summary renders its body and file metadata lists", () => {
  const html = render({
    role: "custom",
    customType: "compaction",
    timestamp: Date.now(),
    content: [
      "The turn was compacted.",
      "",
      "<read-files>",
      "a.ts",
      "b.ts",
      "</read-files>",
      "<modified-files>",
      "c.ts",
      "</modified-files>",
    ].join("\n"),
  });

  assert.match(html, /conversation was compacted|Conversation compacted/i);
  assert.match(html, /The turn was compacted\./);
  assert.match(html, /2 read/);
  assert.match(html, /1 modified/);
  assert.match(html, /a\.ts/);
  assert.match(html, /c\.ts/);
  assert.match(html, /Modified files|modified files/);
});

test("an unknown custom message shows its type, body, details and copy control", () => {
  const longText = `${"word ".repeat(40)}end`;
  // display:false is the harness's "not displayable" marker: by default the
  // message does not reach the transcript at all. The switch in Settings turns
  // it back on (covered by the mounted test below).
  const hidden = render({
    role: "custom",
    customType: "note",
    display: false,
    timestamp: Date.now(),
    content: longText,
    details: { why: "because" },
  });
  assert.equal(hidden, "");

  const visible = render({
    role: "custom",
    customType: "",
    content: [{ type: "text", text: "visible body" }],
  });
  assert.match(visible, /extension/);
  assert.match(visible, /visible body/);
  assert.match(visible, /No message|visible body/);
});

test("a huge message is replaced by a click-to-reveal button with its size", () => {
  const kb = render({ role: "user", content: "x".repeat(100_001) });
  assert.match(kb, /100 KB/);
  assert.doesNotMatch(kb, /x{1000}/);

  const mb = render({ role: "assistant", content: [{ type: "text", text: "y".repeat(1_000_000) }] });
  assert.match(mb, /1\.0 MB/);
});

test("a non-truncated bash message renders through the shell preview", () => {
  const html = render({
    role: "bashExecution",
    command: "printf hello",
    output: "hello\n",
    exitCode: 0,
    timestamp: 1,
    excludeFromContext: true,
  });

  const text = html.replace(/<[^>]+>/g, "");
  assert.match(text, /printf hello/);
  assert.match(text, /hello/);
  assert.match(text, /local/);
});

test("streaming text updates the token estimate across renders, including a split surrogate pair", { timeout: 30_000 }, async () => {
  const message = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });
  const { container, root } = await mount(React.createElement(MessageView, { message: message("abcd"), isStreaming: true }));

  if (!container.textContent) assert.fail("der Stream rendert Text");
  let shown = container.querySelector('[title^="Estimated token"]');
  assert.ok(shown, "die Token-Schaetzung ist sichtbar");
  const first = Number(shown.textContent);
  assert.ok(first > 0, `erste Schaetzung ${first}`);

  // Wurzel der Schaetzung: der Text waechst, der Cache greift (startsWith).
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(MessageView, { message: message("abcdefgh"), isStreaming: true })));
  });
  shown = container.querySelector('[title^="Estimated token"]');
  assert.ok(Number(shown.textContent) > first);

  // Ein Surrogatpaar, das ueber zwei Deltas geteilt ankommt: erst das hohe
  // Halbzeichen, dann das niedrige. Beide Grenzen (`isHighSurrogate`,
  // `isLowSurrogate`) und die Korrektur in `estimateUpdatedTokens` laufen.
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(MessageView, { message: message("abcdefgh\uD83D"), isStreaming: true })));
  });
  const beforePair = Number(container.querySelector('[title^="Estimated token"]').textContent);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(MessageView, { message: message("abcdefgh\uD83D\uDE00"), isStreaming: true })));
  });
  const afterPair = Number(container.querySelector('[title^="Estimated token"]').textContent);
  // Die Korrektur zaehlt das geteilte Paar genau einmal; beide Werte sind
  // gleich, obwohl der String um ein UTF-16-Zeichen gewachsen ist.
  assert.equal(afterPair, beforePair);

  // Ein voellig neuer Text (kein Praefix) nimmt den Neuberechnungs-Zweig.
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(MessageView, { message: message("ZZZZ"), isStreaming: true })));
  });
  assert.ok(container.querySelector('[title^="Estimated token"]'));

  // Stream-Ende: der Effekt finalisiert die Dauer und setzt tps zurueck.
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(MessageView, { message: message("ZZZZ"), isStreaming: false })));
  });
  assert.doesNotMatch(container.textContent, /t\/s/);
  await act(async () => { root.unmount(); });
});

test("the stream ticker shows tokens per second after half a second", { timeout: 30_000 }, async () => {
  const { container, root } = await mount(React.createElement(MessageView, {
    message: { role: "assistant", content: [{ type: "text", text: "streaming text" }] },
    isStreaming: true,
  }));

  // tick laeuft alle 300 ms; erst nach 0.5 s Elapsed setzt er tps.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_300)); });
  assert.match(container.textContent, /t\/s/);
  await act(async () => { root.unmount(); });
});

test("the memo comparator ignores tool results a message does not reference", { timeout: 30_000 }, async () => {
  const message = {
    role: "assistant",
    content: [
      { type: "toolCall", toolCallId: "t9", toolName: "read", input: { path: "/a" } },
      { type: "text", text: "reading" },
    ],
  };
  // isError laesst das Ergebnis sofort sichtbar werden, ohne Aufklappen.
  const resultA = { role: "toolResult", toolCallId: "t9", toolName: "read", content: [{ type: "text", text: "AAAA" }], isError: true };
  const resultB = { ...resultA, content: [{ type: "text", text: "BBBB" }] };
  const other = { role: "toolResult", toolCallId: "other", toolName: "read", content: [], isError: false };
  const { container, root } = await mount(React.createElement(MessageView, {
    message,
    toolResults: toolResults([resultA, other]),
  }));

  // Andere Map, gleiche Ergebnisse fuer t9 -> Vergleich sagt "gleich".
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(MessageView, {
      message,
      toolResults: toolResults([{ ...resultA }, other]),
    })));
  });
  assert.match(container.textContent, /reading/);

  // Neues Ergebnis fuer t9 -> Vergleich sagt "neu".
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(MessageView, {
      message,
      toolResults: toolResults([resultB, other]),
    })));
  });
  assert.match(container.textContent, /BBBB/);
  await act(async () => { root.unmount(); });
});

test("copying a user and an assistant message reports both states", { timeout: 30_000 }, async () => {
  const writes = [];
  fakeNavigator.clipboard.writeText = async (text) => { writes.push(text); };

  const user = await mount(React.createElement(MessageView, {
    message: { role: "user", content: "copy me" },
  }));
  await click(buttonByText(user.container, "Copy"));
  assert.deepEqual(writes.at(-1), "copy me");
  assert.ok(buttonByText(user.container, "Copied"));
  await act(async () => { user.root.unmount(); });

  const assistant = await mount(React.createElement(MessageView, {
    message: { role: "assistant", content: [{ type: "text", text: "assistant text" }] },
  }));
  await click(buttonByText(assistant.container, "Copy"));
  assert.deepEqual(writes.at(-1), "assistant text");
  assert.ok(buttonByText(assistant.container, "Copied"));
  await act(async () => { assistant.root.unmount(); });
});

test("a deferred thinking block is fetched, cached and its failure is shown", { timeout: 30_000 }, async () => {
  fetchCalls.length = 0;
  fetchImpl = async (url) => {
    if (url.includes("/thinking?")) {
      return { ok: true, status: 200, json: async () => ({ thinking: "the hidden reasoning" }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const message = { role: "assistant", content: [{ type: "thinking", thinking: "", deferred: true }] };

  const first = await mount(React.createElement(MessageView, {
    message,
    sessionId: "s 1",
    entryId: "e/1",
  }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(first.container.textContent, /the hidden reasoning/);
  assert.match(fetchCalls[0], /\/api\/sessions\/s%201\/entries\/e%2F1\/thinking\?blockIndex=0/);
  await act(async () => { first.root.unmount(); });

  // Zweiter Mount, gleicher Key: der Cache beantwortet die Anfrage.
  const callsBefore = fetchCalls.length;
  const second = await mount(React.createElement(MessageView, {
    message,
    sessionId: "s 1",
    entryId: "e/1",
  }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(second.container.textContent, /the hidden reasoning/);
  assert.equal(fetchCalls.length, callsBefore, "der zweite Aufruf kommt aus dem Cache");
  await act(async () => { second.root.unmount(); });

  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const failing = await mount(React.createElement(MessageView, {
    message,
    sessionId: "s2",
    entryId: "e2",
  }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(failing.container.textContent, /HTTP 500/);
  await act(async () => { failing.root.unmount(); });

  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const missing = await mount(React.createElement(MessageView, {
    message,
    sessionId: "s3",
    entryId: "e3",
  }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(missing.container.textContent, /Invalid thinking response/);
  await act(async () => { missing.root.unmount(); });
});

test("a truncated bash output can load its full text over the agent route", { timeout: 30_000 }, async () => {
  fetchCalls.length = 0;
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { output: "the full output\nsecond line" } }),
  });
  const { container, root } = await mount(React.createElement(MessageView, {
    message: {
      role: "bashExecution",
      command: "cat big.log",
      output: "truncated…",
      exitCode: 0,
      timestamp: 1,
      truncated: true,
      fullOutputPath: "/tmp/big.log",
    },
    sessionId: "sess 1",
  }));

  const viewFull = buttonByText(container, "view full output");
  assert.ok(viewFull, "der Nachlade-Knopf steht an der Ausgabe");
  await click(viewFull);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(fetchCalls[0], /\/api\/agent\/sess%201\/bash-output\?path=%2Ftmp%2Fbig\.log/);
  assert.match(container.textContent, /the full output/);
  assert.doesNotMatch(container.textContent, /view full output/);
  await act(async () => { root.unmount(); });

  // Fehlerantwort: `success:false` zeigt den Servertext, kein Ergebnis.
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ success: false, error: "gone" }) });
  const failed = await mount(React.createElement(MessageView, {
    message: {
      role: "bashExecution",
      command: "cat big.log",
      output: "truncated…",
      exitCode: 0,
      timestamp: 1,
      truncated: true,
      fullOutputPath: "/tmp/big.log",
    },
    sessionId: "sess-2",
  }));
  await click(buttonByText(failed.container, "view full output"));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(failed.container.textContent, /gone/);
  await act(async () => { failed.root.unmount(); });
});

test("the custom-message copy and detail toggles work", { timeout: 30_000 }, async () => {
  const writes = [];
  fakeNavigator.clipboard.writeText = async (text) => { writes.push(text); };
  const { container, root } = await mount(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "checkpoint",
      content: "custom body",
      details: { ok: true },
      timestamp: Date.now(),
    },
  }));

  assert.match(container.textContent, /custom body/);
  assert.doesNotMatch(container.textContent, /"ok"/);
  await click(buttonByText(container, "Show details"));
  assert.match(container.textContent, /"ok": true/);
  await click(buttonByText(container, "Hide details"));
  assert.doesNotMatch(container.textContent, /"ok": true/);

  await click(buttonByText(container, "Copy"));
  assert.deepEqual(writes.at(-1), "custom body");
  assert.ok(buttonByText(container, "Copied"));
  await act(async () => { root.unmount(); });
});

test("a hidden custom message expands and collapses its details once the switch is on", { timeout: 30_000 }, async () => {
  // Der eingeklappte Vorschau-Knopf zeigt die ersten 140 Zeichen; der Marker
  // am Ende beweist, ob der Volltext wirklich wieder eingeklappt ist.
  const body = `HIDDENSTART ${"q ".repeat(100)} HIDDENEND`;
  setShowHiddenMessages(true);
  try {
    const { container, root } = await mount(React.createElement(MessageView, {
      message: {
        role: "custom",
        customType: "note",
        display: false,
        content: body,
        details: { reason: "compact" },
      },
    }));

    assert.match(container.textContent, /hidden extension message/);
    assert.doesNotMatch(container.textContent, /HIDDENEND/);
    await click(buttonByText(container, "Expand"));
    assert.match(container.textContent, /HIDDENEND/);
    assert.match(container.textContent, /"reason": "compact"/);
    await click(buttonByText(container, "Collapse"));
    assert.doesNotMatch(container.textContent, /HIDDENEND/);
    assert.doesNotMatch(container.textContent, /"reason": "compact"/);
    await act(async () => { root.unmount(); });
  } finally {
    setShowHiddenMessages(false);
  }
});

test("a hidden custom message stays out of the transcript until the switch is on", { timeout: 30_000 }, async () => {
  const { container, root } = await mount(React.createElement(MessageView, {
    message: { role: "custom", customType: "note", display: false, content: "hidden body" },
  }));
  assert.doesNotMatch(container.textContent, /hidden extension message|hidden body/);

  await act(async () => { setShowHiddenMessages(true); });
  assert.match(container.textContent, /hidden extension message/);
  assert.match(container.textContent, /hidden body/);

  await act(async () => { setShowHiddenMessages(false); });
  assert.doesNotMatch(container.textContent, /hidden extension message/);
  await act(async () => { root.unmount(); });
});

test("the switch persists under the key the next page load reads", () => {
  setShowHiddenMessages(true);
  assert.equal(globalThis.localStorage.getItem(SHOW_HIDDEN_MESSAGES_STORAGE_KEY), "true");
  setShowHiddenMessages(false);
  assert.equal(globalThis.localStorage.getItem(SHOW_HIDDEN_MESSAGES_STORAGE_KEY), "false");
});

test("an async-result stays visible although it carries display:false", () => {
  const html = render({
    role: "custom",
    customType: "async-result",
    display: false,
    content: "Agent Scout finished: found 3 call sites.",
  });
  assert.match(html, /Background result/);
  assert.match(html, /Agent Scout finished: found 3 call sites\./);
});

test("a vibe tool renders its screen wall, spawn line and output", () => {
  const html = render({
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "v1", toolName: "vibe_list", input: {} }],
  }, {
    toolResults: toolResults([{
      role: "toolResult",
      toolCallId: "v1",
      toolName: "vibe_list",
      content: [{ type: "text", text: "vibe output" }],
      isError: false,
      details: {
        screens: [
          { id: "s1", cli: "good", state: "running", turns: 2, queued: 1, turnMessage: "\n busy line" },
          { id: "s2", state: "constructor", killed: true, lastActivity: "ended" },
        ],
        spawned: { id: "sp-1", cli: "good" },
        hiddenKilled: ["dead-1"],
      },
    }]),
  });

  assert.match(html, /2 sessions · 1 running · 1 killed/);
  assert.match(html, /spawned <span[^>]*>sp-1<\/span> · good/);
  assert.match(html, /busy line/);
  assert.match(html, /ended/);
  assert.match(html, /2t\+1q/);
  assert.match(html, /constructor · killed/);
  assert.match(html, /vibe output/);
});

test("a task tool lists batch items with its header count", () => {
  const html = render({
    role: "assistant",
    content: [{
      type: "toolCall",
      toolCallId: "task-1",
      toolName: "task",
      input: { tasks: [{ name: "one", agent: "alpha", task: "line1\nline2" }, { name: "", agent: "", taskFile: "/x" }] },
    }],
  }, {
    toolResults: toolResults([{
      role: "toolResult",
      toolCallId: "task-1",
      toolName: "task",
      content: [{ type: "text", text: "batched" }],
      isError: false,
    }]),
  });

  assert.match(html, /2 tasks/);
  assert.match(html, /one/);
  assert.match(html, /alpha/);
  assert.match(html, /line1/);
});

test("todo previews from details and from input.list cover every status", () => {
  const fromDetails = render({
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "todo-1", toolName: "todo", input: {} }],
  }, {
    toolResults: toolResults([{
      role: "toolResult",
      toolCallId: "todo-1",
      toolName: "todo",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      details: {
        phases: [{
          name: "P1",
          tasks: [
            { content: "done", status: "completed" },
            { content: "aband", status: "abandoned" },
            { content: "blk", status: "blocked", blocker: "why" },
            { content: "run", status: "in_progress" },
            { content: "wait", status: "pending" },
            { content: "bad", status: "weird" },
          ],
        }],
      },
    }]),
  });

  assert.match(fromDetails, /Todo 5 tasks/);
  assert.match(fromDetails, /completed: done/);
  assert.match(fromDetails, /abandoned: aband/);
  assert.match(fromDetails, /blocked: blk/);
  assert.match(fromDetails, /\(why\)/);
  assert.match(fromDetails, /in_progress: run/);
  assert.match(fromDetails, /pending: wait/);
  assert.match(fromDetails, /1\/5/);
  assert.doesNotMatch(fromDetails, /weird/);

  const fromInput = render({
    role: "assistant",
    content: [{
      type: "toolCall",
      toolCallId: "todo-2",
      toolName: "todo",
      input: { list: [{ phase: "Phase A", items: ["alpha", 42] }, { phase: 7, items: ["ignored"] }] },
    }],
  }, {
    toolResults: toolResults([{
      role: "toolResult",
      toolCallId: "todo-2",
      toolName: "todo",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }]),
  });
  assert.match(fromInput, /1 task/);
  assert.match(fromInput, /alpha/);
  assert.doesNotMatch(fromInput, /ignored/);
});

test("an async result renders its images and each artifact error once", () => {
  const html = render({
    role: "custom",
    customType: "async-result",
    timestamp: Date.now(),
    content: [
      { type: "text", text: "background body" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "IMG1" } },
      { type: "image", data: "IMG2", mimeType: "image/gif" },
    ],
    details: {
      meta: { artifactError: "disk full" },
      jobs: [{ meta: { artifactError: "disk full" } }, { meta: { artifactError: "timeout" } }, {}],
    },
  });

  assert.match(html, /Background result/);
  assert.match(html, /background body/);
  assert.match(html, /src="data:image\/png;base64,IMG1"/);
  assert.match(html, /src="data:image\/gif;base64,IMG2"/);
  assert.equal((html.match(/disk full/g) ?? []).length, 1);
  assert.equal((html.match(/timeout/g) ?? []).length, 1);
});

test("the large-message button reveals the raw text", { timeout: 30_000 }, async () => {
  const { container, root } = await mount(React.createElement(MessageView, {
    message: { role: "user", content: `START ${"z".repeat(100_010)} END` },
  }));
  const button = container.querySelector("button");
  assert.ok(button);
  assert.match(button.textContent, /100 KB/);
  await click(button);
  const pre = container.querySelector("pre");
  assert.ok(pre, "nach dem Klick steht der Rohtext");
  assert.match(pre.textContent, /START /);
  assert.match(pre.textContent, / END/);
  await act(async () => { root.unmount(); });
});

test.after(() => {
  globalThis.fetch = ORIGINALS.fetch;
  for (const key of ["window", "document", "navigator"]) {
    if (ORIGINALS[key] === undefined) delete globalThis[key];
    else globalThis[key] = ORIGINALS[key];
  }
});
