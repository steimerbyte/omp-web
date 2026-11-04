import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Der Session-Export ist aktives HTML in der App-Origin. Der Schutz ist der
 * `sandbox`-Teil der CSP (opaque Origin: kein Cookie, kein Credential-Fetch),
 * nicht die Herkunft — gemessen in Chrome 149 gegen ein echtes Export-Dokument.
 *
 * `exportSession()` startet sonst den omp-CLI als Kindprozess; die Probe
 * schreibt die Ausgabedatei, damit der Erfolgszweig ohne SDK laeuft. Sie laeuft
 * in einem eigenen Prozess, weil `mock.module` prozessweit ist und die Route im
 * selben Prozess schon von `session-ownership.test.mjs` ausgewertet sein kann
 * (scan-suite.md §3.1). Der Mock greift dann zu spaet und der Export antwortet
 * 500 — unabhaengig davon, ob dieser Test zuerst laeuft.
 */
const PROBE = fileURLToPath(new URL("./export-headers.probe.mjs", import.meta.url));

const output = (() => {
  try {
    return execFileSync(process.execPath, ["test", PROBE], {
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test" },
      timeout: 30_000,
      // Bun erbt stderr ohne explizite stdio-Angabe; die Zusammenfassung der
      // Kindprobe wuerde sonst im Suite-Log stehen.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    assert.fail(
      `die Probe ist gescheitert (${error.status}):\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    );
  }
})();
const resultLine = output.split("\n").find((line) => line.startsWith("EXPORT_HEADERS "));
assert.ok(resultLine, `die Probe hat kein Ergebnis gedruckt:\n${output}`);
const measured = JSON.parse(resultLine.slice("EXPORT_HEADERS ".length));

test("der Export traegt den Sandbox und die Viewer-Hosts", () => {
  assert.equal(measured.inline.status, 200);
  assert.equal(
    measured.inline.headers.csp,
    "sandbox allow-scripts; "
      + "default-src 'self'; "
      + "script-src 'self' 'unsafe-inline' https://build.stencil.so https://stencil.so; "
      + "img-src 'self' data:; "
      + "style-src 'self' 'unsafe-inline'; "
      + "font-src 'self' data:",
  );
  // `allow-same-origin` wuerde den Sandbox fuer die Origin-Rechte aufheben.
  assert.ok(!measured.inline.headers.csp.includes("allow-same-origin"));
  assert.equal(measured.inline.headers.contentTypeOptions, "nosniff");
  assert.equal(measured.inline.headers.frameOptions, "DENY");
  // `inline=1` bleibt die bewusste Funktion; der Schutz kommt aus `sandbox`.
  assert.match(measured.inline.headers.disposition ?? "", /^inline;/);
});

test("ohne inline=1 bleibt es ein Anhang mit denselben Headern", () => {
  assert.equal(measured.attachment.status, 200);
  assert.match(measured.attachment.headers.disposition ?? "", /^attachment;/);
  assert.match(measured.attachment.headers.csp ?? "", /^sandbox allow-scripts;/);
});
