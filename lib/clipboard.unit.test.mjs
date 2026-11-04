import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./clipboard.ts");
}

/**
 * Kopieren mit zwei Wegen.
 *
 * Der moderne Weg (`navigator.clipboard.writeText`) ist der einzige, der auch
 * in einem unsicheren Kontext ohne `document` funktioniert; der alte Weg legt
 * ein unsichtbares `textarea` an und markiert es, weil `execCommand("copy")`
 * nur eine Auswahl kopiert. Der Fehlerfall ist kein stiller Erfolg: ein
 * Aufrufer, der "kopiert" meldet, waehrend nichts in der Zwischenablage steht,
 * luegt den Nutzer an.
 */
async function withGlobal(name, value, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}

test("uses the async clipboard API when it exists", async () => {
  const { copyText } = await loadSubject();
  const written = [];

  await withGlobal("navigator", {
    clipboard: { writeText: async (text) => { written.push(text); } },
  }, () => copyText("hallo"));

  assert.deepEqual(written, ["hallo"]);
});

test("falls back to a hidden textarea and execCommand", async () => {
  const { copyText } = await loadSubject();
  const calls = [];
  const appended = [];
  const removed = [];
  const textarea = {
    value: "",
    style: {},
    select: () => calls.push("select"),
  };
  const document = {
    createElement: (tag) => {
      calls.push(`create:${tag}`);
      return textarea;
    },
    body: {
      appendChild: (node) => appended.push(node),
      removeChild: (node) => removed.push(node),
    },
    execCommand: (command) => {
      calls.push(`exec:${command}`);
      return true;
    },
  };

  await withGlobal("navigator", {}, () =>
    withGlobal("document", document, () => copyText("mit Leerzeichen")));

  assert.equal(textarea.value, "mit Leerzeichen");
  assert.deepEqual(calls, ["create:textarea", "select", "exec:copy"]);
  // Das Feld muss wieder weg sein: ein liegengebliebenes textarea scrollt die
  // Seite und bleibt fokussierbar.
  assert.deepEqual(appended, [textarea]);
  assert.deepEqual(removed, [textarea]);
});

test("rejects when neither path is available", async () => {
  const { copyText } = await loadSubject();

  await withGlobal("navigator", {}, () =>
    withGlobal("document", undefined, () =>
      assert.rejects(copyText("geht nicht"), undefined, "ohne document gibt es keinen Kopierweg")));
});
