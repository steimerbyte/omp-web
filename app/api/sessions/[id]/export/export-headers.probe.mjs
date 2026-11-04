/**
 * Die Header des Session-Exports, gemessen in einem eigenen Prozess.
 *
 * `mock.module` ist prozessweit und nicht rücknehmbar. `session-ownership.test.mjs`
 * importiert dieselbe Route über eine eigene jiti-Instanz; im selben Prozess ist
 * die Route damit schon ausgewertet, und der `child_process`-Mock greift für das
 * bereits gebundene `execFile` nicht mehr — die Route lief in den echten Pfad
 * und antwortete 500 (scan-suite.md §3.1). Ein frischer Prozess ist der
 * kleinste Schnitt, der die Datei von jeder Reihenfolge unabhängig macht.
 *
 * Ausgabe: eine Zeile `EXPORT_HEADERS <json>`; der Test davor prüft sie.
 */
import { writeFileSync } from "node:fs";
import { mock } from "bun:test";

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
  const headers = {
    csp: response.headers.get("content-security-policy"),
    contentTypeOptions: response.headers.get("x-content-type-options"),
    frameOptions: response.headers.get("x-frame-options"),
    disposition: response.headers.get("content-disposition"),
  };
  return { status: response.status, headers };
}

console.log(`EXPORT_HEADERS ${JSON.stringify({
  inline: await exportRequest("?inline=1"),
  attachment: await exportRequest(""),
})}`);
