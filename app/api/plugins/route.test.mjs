import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

/**
 * Diese Tests rufen die ROUTE auf, nicht den Guard.
 *
 * Alle POST-Aktionen schreiben denselben prozessweiten Store: `~/.omp/plugins`,
 * die Marketplace-Registries und die Runtime-Lockfile; `install`/`update`
 * fuehren `bun install` bzw. `git clone` im Serverprozess aus. Deshalb steht
 * `requireAdmin` am Anfang des Handlers — und deshalb geht hier jeder Fall
 * durch `POST` mit den Headern, die `proxy.ts` setzt.
 */
function request(body, { admin }) {
  return new Request("http://localhost/api/plugins", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // `isApiRequestAllowed` reads the Host header; a bare Request has none.
      host: "localhost",
      // Der Name ist frei waehlbar, das Admin-Kennzeichen nicht.
      "x-omp-user": admin ? "steimerbyte" : "agent123",
      ...(admin ? { "x-omp-admin": "1" } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("ein Tenant kann den prozessweiten Plugin-Store nicht aendern", async () => {
  const { POST } = await jiti.import("./route.ts");

  for (const action of ["install", "update", "remove", "enable", "disable"]) {
    const response = await POST(request({ action, source: "omp-audit-probe", cwd: process.cwd() }, { admin: false }));
    assert.equal(response.status, 403, `${action} ist admin-only`);
    assert.equal((await response.json()).error, "Administrator access is required.");
  }
});

test("der Admin passiert den Guard", async () => {
  const { POST } = await jiti.import("./route.ts");

  // Ohne `cwd` antwortet der Handler 400, bevor er irgendeinen Store anfasst.
  // Zwischen Request und dieser Antwort steht nur der Guard: 400 belegt, dass
  // er passiert wurde, ohne einen Install auszufuehren.
  const response = await POST(request({ action: "install" }, { admin: true }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "cwd required");
});

test("der Guard ist der Einstieg, nicht ein Zweig", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  const post = source.slice(source.indexOf("export async function POST"));
  const guard = post.indexOf("requireAdmin(req)");
  assert.ok(guard !== -1, "POST ruft requireAdmin nicht auf");
  for (const branch of ['body.action === "install"', 'body.action === "remove"', "manager.setEnabled("]) {
    assert.ok(post.indexOf(branch) > guard, `${branch} liegt vor dem Admin-Guard`);
  }

  // GET ist die Leseliste und bleibt beim Mandanten: `cwd` wird gegen seine
  // erlaubten Wurzeln geprueft, der Store selbst gehoert niemandem allein.
  const get = source.slice(source.indexOf("export async function GET"), source.indexOf("// POST /api/plugins"));
  assert.doesNotMatch(get, /requireAdmin/);
});
