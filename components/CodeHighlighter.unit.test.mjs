import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import { restoreLinkedomPrototypesOnExit } from "../lib/test-linkedom.mjs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * CodeHighlighterLazy: Der Block muss schon vor dem Nachladen als echter
 * `<pre><code>`-Block mit unveraendertem Text im DOM stehen (Server-Render und
 * erster Client-Render identisch), und nach dem Chunk-Load dieselben
 * `.token`-Spans zeigen wie der direkte Highlighter.
 */

const ROOT = process.cwd();
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
restoreLinkedomPrototypesOnExit(win);

const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
globalThis.window = win;
globalThis.document = win.document;
globalThis.navigator = win.navigator;

const mounted = [];
test.after(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  for (const key of Object.keys(ORIGINALS)) {
    const value = ORIGINALS[key];
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

const jiti = createJiti(`${ROOT}/package.json`, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { CodeHighlighter } = await jiti.import(`${ROOT}/components/CodeHighlighterLazy.tsx`);
const { CodeHighlighter: DirectHighlighter } = await jiti.import(`${ROOT}/components/CodeHighlighter.tsx`);
const { vs } = await jiti.import(`${ROOT}/node_modules/react-syntax-highlighter/dist/cjs/styles/prism/index.js`);

const CODE = "const answer: number = 42;\nexport default answer;";

/** Server/first-render output: react-dom/server runs no effects, so the lazy chunk never loads. */
const { renderToStaticMarkup } = await jiti.import(`${ROOT}/node_modules/react-dom/server.js`).then((m) => m.default ?? m);

test("vor dem Nachladen steht der reine Block mit demselben Text im Markup", () => {
  const markup = renderToStaticMarkup(
    React.createElement(CodeHighlighter, { language: "ts", style: vs, showLineNumbers: true }, CODE),
  );
  assert.match(markup, /^<pre[^>]*><code[^>]*>/, `kein pre/code: ${markup}`);
  assert.ok(!markup.includes('class="token'), "ohne geladenen Chunk darf nichts hervorgehoben sein");
  assert.ok(markup.includes("const answer: number = 42;"), "der Text fehlt im Fallback");
});

test("der Fallback setzt weissen Raum und Klassen wie der Highlighter auf das code-Element", () => {
  const markup = renderToStaticMarkup(
    React.createElement(CodeHighlighter, { language: "ts", style: vs, codeTagProps: { className: "wrap-me" } }, CODE),
  );
  assert.ok(markup.includes("white-space:pre"), `ohne wrapLongLines kein pre: ${markup}`);
  assert.ok(markup.includes('class="wrap-me"'), `codeTagProps.className fehlt: ${markup}`);
});

test("der Fallback bricht mit wrapLongLines um (pre-wrap wie im echten Highlighter)", () => {
  const markup = renderToStaticMarkup(
    React.createElement(CodeHighlighter, { language: "ts", style: vs, wrapLongLines: true }, CODE),
  );
  assert.ok(markup.includes("white-space:pre-wrap"), `mit wrapLongLines kein pre-wrap: ${markup}`);
});

test("codeTagProps.style gewinnt gegen den Standard (whiteSpace nowrap)", () => {
  for (const wrapLongLines of [false, true]) {
    const markup = renderToStaticMarkup(
      React.createElement(
        CodeHighlighter,
        { language: "ts", style: vs, wrapLongLines, codeTagProps: { style: { whiteSpace: "nowrap" } } },
        CODE,
      ),
    );
    assert.ok(markup.includes("white-space:nowrap"), `Aufrufer-Stil verloren (wrapLongLines=${wrapLongLines}): ${markup}`);
    assert.ok(!markup.includes("white-space:pre-wrap"), `Standard gewinnt (wrapLongLines=${wrapLongLines}): ${markup}`);
  }
});

test("der Fallback folgt PreTag/CodeTag (Shell-Zeile rendert span statt pre)", () => {
  const markup = renderToStaticMarkup(
    React.createElement(CodeHighlighter, { language: "bash", style: vs, PreTag: "span", CodeTag: "span" }, "bun run verify"),
  );
  assert.match(markup, /^<span[^>]*><span[^>]*>bun run verify<\/span><\/span>$/, markup);
});

test("der direkte Highlighter setzt Tokens und laesst den Text unveraendert", () => {
  const markup = renderToStaticMarkup(
    React.createElement(DirectHighlighter, { language: "ts", style: vs, showLineNumbers: true }, CODE),
  );
  assert.ok(markup.includes('<span class="token'), "keine Token-Spans");
  assert.ok(markup.includes("const"), "Text beschaedigt");
  assert.ok(markup.includes("answer"), "Text beschaedigt");
});

test("nach dem Mount laedt der Chunk nach und der Block bekommt Tokens", async () => {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(React.createElement(CodeHighlighter, { language: "ts", style: vs }, CODE));
  });
  mounted.push({ root, container });

  for (let i = 0; i < 50 && container.querySelectorAll("pre code span.token").length === 0; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  const tokens = container.querySelectorAll("pre code span.token");
  assert.ok(tokens.length > 0, "der geladene Highlighter hat keine Tokens erzeugt");
  assert.ok(container.textContent.includes("const answer: number = 42;"), "Text wurde beim Nachladen veraendert");
  assert.equal(container.querySelectorAll("pre").length, 1, "der Block wurde beim Nachladen dupliziert");
});
