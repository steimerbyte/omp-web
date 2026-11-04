import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * `FrontmatterCard` ist reine Darstellung: ein `data`-Objekt aus dem
 * YAML-Block wird zu Titel, Tag-Zeile und Definitionsliste. Deshalb
 * `renderToStaticMarkup` — kein DOM, keine Effekte, kein Harness.
 *
 * Die drei Export-Funktionen des Moduls (`isUrl`, `renderValue`,
 * `FrontmatterCard`) sind nur ueber diesen Render erreichbar; `renderValue`
 * laeuft fuer jede Zeile, `isUrl` fuer jeden String-Wert.
 */
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { FrontmatterCard } = await jiti.import("./FrontmatterCard.tsx");

function render(data) {
  return renderToStaticMarkup(React.createElement(FrontmatterCard, { data }));
}

test("renders nothing without data or with an empty object", () => {
  assert.equal(render(null), "");
  assert.equal(render({}), "");
});

test("renders a title, tag chips and the remaining rows", () => {
  const html = render({
    title: "Release notes",
    tags: ["alpha", "beta"],
    owner: "ada",
    draft: false,
  });

  assert.match(html, /markdown-frontmatter-title">Release notes</);
  assert.match(html, /markdown-frontmatter-tag">alpha</);
  assert.match(html, /markdown-frontmatter-tag">beta</);
  assert.match(html, /<dt>owner<\/dt><dd>ada<\/dd>/);
  assert.match(html, /<dt>draft<\/dt><dd>false<\/dd>/);
  // The title row is not repeated in the list and the tag array is not a row.
  assert.doesNotMatch(html, /<dt>title<\/dt>/);
  assert.doesNotMatch(html, /<dt>tags<\/dt>/);
});

test("turns http, mailto and other string values into the right element", () => {
  const html = render({
    homepage: "https://example.com/docs",
    mail: "mailto:ada@example.com",
    relative: "notes/readme.md",
  });

  assert.match(html, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\/docs<\/a>/);
  assert.match(html, /<a href="mailto:ada@example\.com" target="_blank" rel="noopener noreferrer">mailto:ada@example\.com<\/a>/);
  assert.match(html, /<dt>relative<\/dt><dd>notes\/readme\.md<\/dd>/);
  assert.doesNotMatch(html, /href="notes/);
});

test("formats arrays and objects as inline text, not nested markup", () => {
  const html = render({
    authors: ["ada", "grace"],
    meta: { branch: "main" },
  });

  assert.match(html, /<dt>authors<\/dt><dd>ada, grace<\/dd>/);
  assert.match(html, /<dt>meta<\/dt><dd>\{&quot;branch&quot;:&quot;main&quot;\}<\/dd>/);
});

test("uses the first array-valued tag key in TAG_KEYS order", () => {
  const html = render({
    categories: ["docs"],
    tags: ["primary"],
    empty: "",
    nothing: null,
  });

  // TAG_KEYS starts with "tags", so it wins over a later "categories".
  assert.match(html, /markdown-frontmatter-tag">primary</);
  assert.doesNotMatch(html, /markdown-frontmatter-tag">docs</);
  // The chosen tag key is not repeated as a row; the other one is.
  assert.match(html, /<dt>categories<\/dt><dd>docs<\/dd>/);
  // Empty strings and null produce an empty <dd> rather than a value.
  assert.match(html, /<dt>empty<\/dt><dd><\/dd>/);
  assert.match(html, /<dt>nothing<\/dt><dd><\/dd>/);
});

test("falls back to categories when tags is not an array", () => {
  const html = render({ categories: ["handbook"], keywords: ["x"] });

  assert.match(html, /markdown-frontmatter-tag">handbook</);
  assert.match(html, /<dt>keywords<\/dt><dd>x<\/dd>/);
});

test("a blank title row falls back to the type name", () => {
  const html = render({ title: "   ", status: "ok" });

  assert.doesNotMatch(html, /markdown-frontmatter-title/);
  assert.match(html, /<dt>title<\/dt><dd>   <\/dd>/);
});
