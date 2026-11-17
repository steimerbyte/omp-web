import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Das Ablegen eingefuegter Bilder, an echten Dateien gemessen.
 *
 * Die drei Zusagen, die zaehlen: der Name ist ein Inhalts-Hash (zweimal
 * dasselbe Bild ist eine Datei), die Endung kommt aus der Whitelist des SDK
 * und nicht aus dem MIME-String des Clients, und ein Fehler beim Schreiben
 * kostet nur die Datei-Referenz, nie den Prompt.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});
const { persistPromptImages } = await jiti.import("./chat-attachments.ts");
const { imageAttachmentSource } = await jiti.import("@oh-my-pi/pi-tui/prompt/image-source");

function sessionAt(artifactsDir) {
  return {
    sessionId: "attach-session",
    sessionManager: {
      getArtifactsDir: () => artifactsDir,
      getSessionId: () => "attach-session",
    },
  };
}

const image = (contents, mimeType = "image/png") => ({
  type: "image",
  data: Buffer.from(contents).toString("base64"),
  mimeType,
});

test("legt ein Bild unter <artefakte>/local ab und taggt den local://-Pfad", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-attach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const [prepared] = await persistPromptImages(sessionAt(dir), [image("png-bytes-1")]);
  const source = imageAttachmentSource(prepared);

  assert.ok(source, "das Bild traegt die Quellen-Metadaten des SDK");
  assert.match(source.path, /^local:\/\/pasted-image-[0-9a-f]+\.png$/);
  const file = join(dir, "local", source.path.slice("local://".length));
  assert.equal(existsSync(file), true, "die Datei existiert wirklich");
  assert.equal(readFileSync(file, "utf8"), "png-bytes-1");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(prepared.data, image("png-bytes-1").data, "die Bytes gehen unveraendert weiter");
});

test("derselbe Inhalt ergibt denselben Dateinamen und eine Datei", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-attach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const [first] = await persistPromptImages(sessionAt(dir), [image("immer dieselben bytes")]);
  const [second] = await persistPromptImages(sessionAt(dir), [image("immer dieselben bytes")]);

  assert.equal(imageAttachmentSource(first).path, imageAttachmentSource(second).path);
  assert.deepEqual(readdirSync(join(dir, "local")).length, 1);
});

test("die Endung kommt aus der Whitelist, nicht aus dem MIME-String", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-attach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const [jpeg] = await persistPromptImages(sessionAt(dir), [image("jpeg-bytes", "image/jpeg")]);
  assert.match(imageAttachmentSource(jpeg).path, /\.jpg$/);

  const [hostile] = await persistPromptImages(sessionAt(dir), [image("evil", "image/../../etc/passwd")]);
  const source = imageAttachmentSource(hostile);
  assert.match(source.path, /^local:\/\/pasted-image-[0-9a-f]+\.png$/, "fremde MIME-Typen fallen auf png zurueck");
  const file = join(dir, "local", source.path.slice("local://".length));
  assert.equal(existsSync(file), true);
  assert.equal(file.startsWith(join(dir, "local")), true, "kein Pfad verlaesst die Wurzel");
});

test("ohne Artefaktverzeichnis bleibt das Bild untagged", async (t) => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => {
    console.warn = originalWarn;
  });

  const input = image("ohne ziel");
  const prepared = await persistPromptImages(sessionAt(null), [input]);

  assert.equal(prepared.length, 1);
  assert.equal(imageAttachmentSource(prepared[0]), undefined, "kein Pfad, den es nicht gibt");
  assert.equal(prepared[0].data, input.data, "die Bytes bleiben erhalten");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no artifacts directory/);
});

test("ein Schreibfehler degradiert statt den Prompt zu verlieren", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-attach-"));
  // Ein Verzeichnis, das keine ist: `mkdir(<datei>/local)` scheitert.
  const blocker = join(dir, "kein-verzeichnis");
  writeFileSync(blocker, "x");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => {
    console.warn = originalWarn;
  });

  const input = image("passt nicht");
  const [prepared] = await persistPromptImages(sessionAt(blocker), [input]);

  assert.equal(imageAttachmentSource(prepared), undefined);
  assert.equal(prepared.data, input.data);
  assert.match(warnings[0], /could not persist local:\/\/pasted-image-/);
});

test("eine leere Liste bleibt leer und fasst das Dateisystem nicht an", async () => {
  assert.deepEqual(await persistPromptImages(sessionAt("/nonexistent"), []), []);
  assert.deepEqual(await persistPromptImages(sessionAt("/nonexistent"), undefined), []);
});
