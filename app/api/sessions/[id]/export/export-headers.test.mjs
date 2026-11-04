import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { mock } from "bun:test";

/**
 * Der Session-Export ist aktives HTML in der App-Origin. Der Schutz ist der
 * `sandbox`-Teil der CSP (opaque Origin: kein Cookie, kein Credential-Fetch),
 * nicht die Herkunft — gemessen in Chrome 149 gegen ein echtes Export-Dokument.
 *
 * `exportSession()` startet sonst den omp-CLI als Kindprozess; hier schreibt
 * der Stub die Ausgabedatei, damit der Erfolgszweig ohne SDK laeuft.
 */
mock.module("../../session-guard", () => ({ requireSessionAccess: async () => null }));
mock.module("@/lib/session-reader", () => ({ resolveSessionPath: async () => "/tmp/omp-export-headers-test.jsonl" }));
mock.module("child_process", () => ({
  execFile: (_file, args, _options, callback) => {
    writeFileSync(args[3], "<!doctype html><html><body>export</body></html>");
    callback(null, { stdout: "", stderr: "" });
  },
}));

const { GET } = await import("./route.ts");

async function exportRequest(search) {
  const response = await GET(
    new Request(`http://localhost:8788/api/sessions/session-1/export${search}`, {
      headers: { host: "localhost:8788", "sec-fetch-site": "same-origin" },
    }),
    { params: Promise.resolve({ id: "session-1" }) },
  );
  return response;
}

test("der Export traegt den Sandbox und die Viewer-Hosts", async () => {
  const response = await exportRequest("?inline=1");

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-security-policy"),
    "sandbox allow-scripts; "
      + "default-src 'self'; "
      + "script-src 'self' 'unsafe-inline' https://build.stencil.so https://stencil.so; "
      + "img-src 'self' data:; "
      + "style-src 'self' 'unsafe-inline'; "
      + "font-src 'self' data:",
  );
  // `allow-same-origin` wuerde den Sandbox fuer die Origin-Rechte aufheben.
  assert.ok(!response.headers.get("content-security-policy").includes("allow-same-origin"));
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  // `inline=1` bleibt die bewusste Funktion; der Schutz kommt aus `sandbox`.
  assert.match(response.headers.get("content-disposition") ?? "", /^inline;/);
});

test("ohne inline=1 bleibt es ein Anhang mit denselben Headern", async () => {
  const response = await exportRequest("");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.match(response.headers.get("content-security-policy") ?? "", /^sandbox allow-scripts;/);
});
