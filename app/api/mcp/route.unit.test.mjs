import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/mcp` — die *gefundenen* Server.
 *
 * `route.test.mjs` deckt die Schreibpfade und die Mandantengrenze ab. Hier geht
 * es um den zweiten Leseweg: `loadCapability("mcps", …)` findet auch Dateien,
 * die `configPath` nicht liest (`.mcp.json` im Projekt). Genau diese Eintraege
 * laufen durch `discoveredConfig` und `redactNestedStrings` — ein Secret in
 * `env`, `headers`, `auth` oder `oauth` darf die Antwort nicht verlassen.
 *
 * Der Test ist der Beweis fuer die Tiefe: `auth.clientSecret` und
 * `oauth.clientId` stehen verschachtelt, ein flaches Redigieren wuerde sie
 * stehen lassen.
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const route = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access");

const homeRoot = mkdtempSync(join(tmpdir(), "omp-web-mcp-discovered-"));
const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;

const cwd = join(homeRoot, "alice", "projekt");
mkdirSync(cwd, { recursive: true });
const ALICE = { host: "localhost", "x-omp-user": "alice" };
allowFileRoot(cwd, { username: "alice", isAdmin: false });

// `OMP_WEB_HOME_ROOT` ist prozessweit, und `bun test` laedt die
// Testdateien im selben Prozess: eine Zuweisung auf Modulebene gilt nicht
// mehr, sobald eine andere Datei ihre eigene setzt. Deshalb pro Test.
test.beforeEach(() => {
  process.env.OMP_WEB_HOME_ROOT = homeRoot;
});

test.after(() => {
  if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
  else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
  rmSync(homeRoot, { recursive: true, force: true });
});

const SECRETS = {
  env: "TOKEN-DO-NOT-LEAK",
  header: "Bearer HEADER-DO-NOT-LEAK",
  authSecret: "AUTH-SECRET-DO-NOT-LEAK",
  oauthClient: "OAUTH-CLIENT-DO-NOT-LEAK",
};

writeFileSync(join(cwd, ".mcp.json"), `${JSON.stringify({
  mcpServers: {
    // stdio: command/args/cwd/env/timeout/enabled laufen durch `discoveredConfig`.
    lokal: {
      command: "true",
      args: ["--flag"],
      cwd: "/tmp",
      timeout: 1234,
      enabled: false,
      env: { API_TOKEN: SECRETS.env, PLAIN: "sichtbar" },
    },
    // http: url/headers sowie die verschachtelten auth/oauth-Objekte.
    entfernt: {
      url: "https://example.invalid/mcp",
      headers: { Authorization: SECRETS.header },
      auth: { type: "apikey", credentialId: "cred-1", clientSecret: SECRETS.authSecret },
      oauth: { clientId: SECRETS.oauthClient, scope: "read" },
    },
  },
}, null, 2)}\n`);

function get() {
  const url = new URL("http://localhost/api/mcp");
  url.searchParams.set("cwd", cwd);
  return route.GET(new Request(url, { headers: ALICE }));
}

test("gefundene Server kommen redigiert und nicht editierbar zurueck", async () => {
  const res = await get();
  assert.equal(res.status, 200);
  const body = await res.json();

  const servers = new Map((body.project?.servers ?? []).map((entry) => [entry.name, entry]));
  assert.deepEqual([...servers.keys()].sort(), ["entfernt", "lokal"]);

  const local = servers.get("lokal");
  assert.equal(local.editable, false, "eine gefundene Datei ist nicht der Projekt-Store");
  assert.equal(local.source.level, "project");
  assert.match(local.source.path, /\.mcp\.json$/);
  assert.equal(local.config.command, "true");
  assert.deepEqual(local.config.args, ["--flag"]);
  assert.equal(local.config.cwd, "/tmp");
  assert.equal(local.config.timeout, 1234);
  // `discoveredConfig` setzt *jeden* env-Wert auf den Platzhalter, nicht nur
  // die, deren Name nach Secret klingt: der Entdecker kennt die Semantik der
  // Datei nicht.
  assert.equal(local.config.env.API_TOKEN, "••••••••");
  assert.equal(local.config.env.PLAIN, "••••••••");
  assert.equal(local.enabled, false, "der deaktivierte Server bleibt als deaktiviert sichtbar");

  const remote = servers.get("entfernt");
  assert.equal(remote.config.url, "https://example.invalid/mcp");
  assert.equal(remote.config.headers.Authorization, "••••••••");
  assert.equal(remote.config.auth.type, "••••••••");
  assert.equal(remote.config.auth.credentialId, "••••••••");
  assert.equal(remote.config.auth.clientSecret, "••••••••", "auth.clientSecret ist nicht redigiert");
  assert.equal(remote.config.oauth.clientId, "••••••••");
  assert.equal(remote.config.oauth.scope, "••••••••");

  const raw = JSON.stringify(body);
  for (const secret of Object.values(SECRETS)) {
    assert.equal(raw.includes(secret), false, `Secret in der Antwort: ${secret}`);
  }
});

test("ein cwd ausserhalb der eigenen Roots ist 403", async () => {
  const outside = join(homeRoot, "fremd");
  mkdirSync(outside, { recursive: true });
  const url = new URL("http://localhost/api/mcp");
  url.searchParams.set("cwd", outside);
  const res = await route.GET(new Request(url, { headers: ALICE }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Access denied" });
});

test("ein PUT mit Platzhaltern laesst die gespeicherten Geheimnisse stehen", async () => {
  // Der Client bekommt Secrets nur als `••••••••` und schickt sie so zurueck.
  // Ein PUT, das den Platzhalter woertlich speichert, wuerde das Geheimnis
  // durch neun Punkte ersetzen — und beim naechsten Verbindungsaufbau scheitern.
  mkdirSync(join(cwd, ".omp"), { recursive: true });
  const configPath = join(cwd, ".omp", "mcp.json");
  writeFileSync(configPath, `${JSON.stringify({
    mcpServers: {
      probe: {
        url: "https://example.invalid/mcp",
        headers: { Authorization: "Bearer ECHT-DO-NOT-LEAK" },
        auth: { type: "apikey", clientSecret: "ECHT-AUTH-DO-NOT-LEAK" },
      },
      // Ein Arraypfad: `restoreRedactedValues` rekursiert auch in Listen.
      stdio: {
        command: "true",
        args: ["--token", "ECHT-ARG-DO-NOT-LEAK"],
        env: { API_TOKEN: "ECHT-ENV-DO-NOT-LEAK" },
      },
    },
  }, null, 2)}\n`);

  const url = new URL("http://localhost/api/mcp");
  url.searchParams.set("cwd", cwd);
  const res = await route.PUT(new Request(url, {
    method: "PUT",
    headers: { ...ALICE, "content-type": "application/json" },
    body: JSON.stringify({
      scope: "project",
      servers: [{
        name: "probe",
        config: {
          type: "http",
          url: "https://example.invalid/mcp",
          headers: { Authorization: "••••••••" },
          auth: { type: "••••••••", clientSecret: "••••••••" },
        },
      }, {
        name: "stdio",
        config: {
          command: "true",
          args: ["--token", "••••••••"],
          env: { API_TOKEN: "••••••••" },
        },
      }],
    }),
  }));
  assert.equal(res.status, 200, await res.clone().text());

  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.mcpServers.probe.headers.Authorization, "Bearer ECHT-DO-NOT-LEAK");
  assert.equal(saved.mcpServers.probe.auth.clientSecret, "ECHT-AUTH-DO-NOT-LEAK");
  assert.deepEqual(saved.mcpServers.stdio.args, ["--token", "ECHT-ARG-DO-NOT-LEAK"]);
  assert.equal(saved.mcpServers.stdio.env.API_TOKEN, "ECHT-ENV-DO-NOT-LEAK");
  // Und die Antwort bleibt redigiert.
  assert.equal(JSON.stringify(await res.json()).includes("ECHT-DO-NOT-LEAK"), false);
});
