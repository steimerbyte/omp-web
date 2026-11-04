import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * `MarkdownBody` mappt Markdown auf eigene Renderer. Zwei davon — `img` und
 * `table` — sind reine Abbildungen und gehen ohne DOM. `a` entscheidet je
 * Link, ob er in der App geoeffnet oder in einem neuen Tab geoeffnet wird;
 * der Klick-Zweig (`handleClick`) braucht deshalb ein gemountetes Feld und
 * das React-Props-Objekt des Ankers, wie in `ChatInput.enter-gesture.test.mjs`
 * beschrieben (linkedom und React DOM 19 koennen ein Event auf einem
 * Formularelement nicht gemeinsam zustellen).
 */
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
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
// Motion prueft `instanceof HTMLElement`.
for (const [key, value] of Object.entries(linkedom)) {
  if (key !== "parseHTML" && key !== "default" && typeof value === "function" && /^[A-Z]/.test(key)) {
    globalThis[key] = value;
  }
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderMarkdown(markdown, props = {}) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(MarkdownBody, props, markdown)),
  );
}

function reactProps(element) {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps"));
  assert.ok(key, "kein React-Props-Objekt am Knoten");
  return element[key];
}

test("local image paths go through the file route, remote ones stay as they are", () => {
  const local = renderMarkdown("![shot](img/shot.png)", { cwd: "/work" });
  assert.match(local, /src="\/api\/files\/work\/img\/shot\.png\?type=read"/);
  assert.match(local, /alt="shot"/);

  const remote = renderMarkdown("![shot](https://cdn.example.com/shot.png)");
  assert.match(remote, /src="https:\/\/cdn\.example\.com\/shot\.png"/);
});

test("fenced code keeps its language and never highlights it into markup", () => {
  const html = renderMarkdown("```js\nconst x = 1 < 2;\n```");
  assert.match(html, /markdown-code-block/);
  assert.match(html, /markdown-code-lang">js</);
  assert.match(html, /\bconst\b/);
});

test("tables are wrapped so the chat column can scroll them horizontally", () => {
  const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");

  assert.match(html, /<div class="markdown-table-wrap"><table>/);
  assert.match(html, /<td>1<\/td>/);
});

test("a local file link opens in the app when the caller wants it", () => {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const opened = [];
  const anchored = React.createElement(
    I18nProvider,
    null,
    React.createElement(
      MarkdownBody,
      { cwd: "/work", onOpenFile: (filePath) => opened.push(filePath) },
      "[source](src/a.ts)",
    ),
  );

  return act(async () => { root.render(anchored); }).then(async () => {
    const anchor = container.querySelector("a");
    assert.ok(anchor, "der Link ist gerendert");
    const props = reactProps(anchor);
    assert.equal(typeof props.onClick, "function", "der lokale Link traegt einen Klick-Handler");

    let prevented = false;
    await act(async () => {
      props.onClick({
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault() { prevented = true; },
        currentTarget: anchor,
      });
    });

    assert.deepEqual(opened, ["/work/src/a.ts"]);
    assert.equal(prevented, true);
    await act(async () => { root.unmount(); });
  });
});

test("a modified or non-primary click is left to the browser", async () => {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const opened = [];
  await act(async () => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(
          MarkdownBody,
          { cwd: "/work", onOpenFile: (filePath) => opened.push(filePath) },
          "[source](src/a.ts)",
        ),
      ),
    );
  });
  const anchor = container.querySelector("a");
  const { onClick } = reactProps(anchor);

  const click = async (overrides) => {
    let prevented = false;
    await act(async () => {
      onClick({
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault() { prevented = true; },
        currentTarget: anchor,
        ...overrides,
      });
    });
    return prevented;
  };

  assert.equal(await click({ ctrlKey: true }), false);
  assert.equal(await click({ metaKey: true }), false);
  assert.equal(await click({ shiftKey: true }), false);
  assert.equal(await click({ altKey: true }), false);
  assert.equal(await click({ button: 1 }), false);
  assert.equal(await click({ defaultPrevented: true }), false);
  assert.deepEqual(opened, []);
  await act(async () => { root.unmount(); });
});

test("a link with an explicit non-self target keeps the browser in charge", async () => {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const opened = [];
  await act(async () => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(
          MarkdownBody,
          { cwd: "/work", onOpenFile: (filePath) => opened.push(filePath) },
          "[source](src/a.ts)",
        ),
      ),
    );
  });
  const anchor = container.querySelector("a");
  // Der Markdown-Renderer setzt kein `target`; der Zweig ist trotzdem
  // erreichbar, wenn ein Link es ueber Roh-HTML mitbringt.
  anchor.setAttribute("target", "_blank");
  const { onClick } = reactProps(anchor);

  let prevented = false;
  await act(async () => {
    onClick({
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault() { prevented = true; },
      currentTarget: anchor,
    });
  });

  assert.equal(prevented, false);
  assert.deepEqual(opened, []);
  await act(async () => { root.unmount(); });
});
