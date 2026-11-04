import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { parseHTML } from "linkedom";
import { createJiti } from "jiti";

/**
 * `app/page.tsx` — die Startseite.
 *
 * `Home()` wird direkt aufgerufen, nicht gerendert: die Funktion baut nur den
 * Elementbaum (Suspense um die Anbieter um die Shell), und genau dieser Baum
 * ist der Vertrag. Ein Render wuerde die echte `AppShell` ausfuehren, die ohne
 * App-Router-Kontext an `useSearchParams` suspendiert — uebrig bliebe ein
 * leerer String, und die Aussage waere keine mehr.
 *
 * Die Typen werden mit den echten Modulen verglichen; eine Attrappe ueber
 * `mock.module` scheidet aus, weil ein Modul-Mock prozessweit gilt und die
 * AppShell-Tests der naechsten Datei mitvernichtet.
 */

const INSTALLED = ["window", "document", "navigator"];
const previousGlobals = new Map();

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

test.before(() => {
  const { window } = parseHTML("<!doctype html><html><body></body></html>");
  // `@xterm/xterm` (ueber die Shell importiert) liest `navigator.userAgent`.
  const values = {
    window,
    document: window.document,
    navigator: {
      language: "en-US",
      languages: ["en-US"],
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      platform: "Linux x86_64",
      maxTouchPoints: 0,
    },
  };
  for (const [name, value] of Object.entries(values)) {
    previousGlobals.set(name, globalThis[name]);
    globalThis[name] = value;
  }
});

test.after(() => {
  for (const [name, value] of previousGlobals) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
  previousGlobals.clear();
});

test("die Startseite verschachtelt Suspense, I18n, Animation und Shell", async () => {
  const { default: Home } = await jiti.import("./page.tsx");
  const { AppShell } = await jiti.import("@/components/AppShell");
  const { AnimationProvider } = await jiti.import("@/components/motion/AnimationProvider");
  const { I18nProvider } = await jiti.import("@/hooks/useI18n");

  const tree = Home();

  assert.equal(tree.type, React.Suspense);
  const providers = tree.props.children;
  assert.equal(providers.type, I18nProvider, "I18n muss aussen stehen");
  assert.equal(providers.props.children.type, AnimationProvider);
  assert.equal(providers.props.children.props.children.type, AppShell);
});
