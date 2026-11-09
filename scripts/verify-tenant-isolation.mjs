#!/usr/bin/env node
/**
 * Abnahme-Harness fuer die Mandanten-Isolation (docs/plans/tenant-isolation.md, §11 Tabelle A1-A10).
 *
 * Warum das hier steht und nicht als Testdatei: die Vertragspunkte sind
 * Prozess- und Dateisystem-Eigenschaften eines laufenden Servers, kein
 * Verhalten einer Funktion. `bun test` kann sie nicht sehen, weil der Worker
 * ein Kindprozess ist und die Grenze vom Kernel kommt.
 *
 * Jede Zeile ist ein Lauf. Der Basisstand (2026-11-08) haelt Zeilen 2, 3, 4 und
 * 7 nicht: es gibt keinen Worker pro Mandant, der Agent laeuft im
 * Serverprozess, und die Archive liegen im Dienstverzeichnis. Das Harness
 * faerbt genau diese Zeilen rot — dafuer braucht es keinen Modellaufruf, weil
 * `type:"ensure_session"` den Agent-Pfad ohne Turn betritt
 * (app/api/agent/new/route.ts:127).
 *
 * Aufruf:
 *   node scripts/verify-tenant-isolation.mjs --mode probe
 *   node scripts/verify-tenant-isolation.mjs --mode fail-closed --base-url http://127.0.0.1:31999
 *   node scripts/verify-tenant-isolation.mjs --mode opt-out   --base-url http://127.0.0.1:31998 \
 *        --server-log /tmp/ti/server.stderr
 *
 * `--mode opt-out` liest Zeile 6b aus dem abgefangenen **stderr** des Servers
 * (`--server-log`, typisch `2> server.stderr`). Eine eigene Log-Variable gibt
 * es bewusst nicht: eine Zeile, die nur der Test erzeugt, sagt nichts ueber den
 * Betrieb. Ohne `--server-log` ist 6b SKIP, mit Log und ohne die Zeile FAIL.
 *
 * Exit-Code: 0 nur wenn jede Zeile PASS ist. FAIL -> 1. Ein SKIP -> 1 mit
 * `INCOMPLETE`: eine Voraussetzung, die nicht erfuellt werden konnte, ist kein
 * gruener Haken.
 *
 * Konten: zuerst ueber die dokumentierte Admin-Route `POST /api/web-access/users`
 * (app/api/web-access/users/route.ts:87-131, `requireAdmin` in Zeile 88,
 * `createWebAccount` in Zeile 122, Body `{username, password}`). Ist kein Admin
 * anmeldbar, faellt es auf denselben Code zurueck, den die Route aufruft
 * (`createWebAccount` aus bin/web-auth-store.js:1034) — nicht auf eine
 * nachgebaute Datei.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    baseUrl: "http://127.0.0.1:30141",
    homeRoot: process.env.OMP_WEB_HOME_ROOT ?? null,
    tenant: "verifyalpha",
    tenantPassword: "verify-alpha-password-1",
    peerTenant: "verifybeta",
    peerPassword: "verify-beta-password-1",
    adminUser: process.env.OMP_WEB_ADMIN_USER ?? "verifyadmin",
    adminPassword: process.env.OMP_WEB_ADMIN_PASSWORD ?? "verify-admin-password-1",
    serviceAgentDir: process.env.PI_CODING_AGENT_DIR ?? null,
    secretsFile: process.env.OMP_WEB_SECRETS_FILE ?? null,
    // Abgefangener stderr des Servers unter Test. Fuer `--mode opt-out` die
    // einzige Log-Quelle: die Zeile muss der Server selbst schreiben, und sie
    // muss aus dem Lauf stammen, der gerade geprueft wird.
    serverLog: null,
    mode: "probe",
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--base-url": out.baseUrl = next().replace(/\/+$/, ""); break;
      case "--home-root": out.homeRoot = next(); break;
      case "--tenant": out.tenant = next(); break;
      case "--tenant-password": out.tenantPassword = next(); break;
      case "--peer-tenant": out.peerTenant = next(); break;
      case "--peer-password": out.peerPassword = next(); break;
      case "--admin-user": out.adminUser = next(); break;
      case "--admin-password": out.adminPassword = next(); break;
      case "--service-agent-dir": out.serviceAgentDir = next(); break;
      case "--secrets-file": out.secretsFile = next(); break;
      case "--server-log":
      case "--server-stderr": out.serverLog = next(); break;
      case "--mode": {
        const value = next();
        if (!["probe", "fail-closed", "opt-out"].includes(value)) {
          throw new Error(`--mode must be probe, fail-closed or opt-out (got ${value})`);
        }
        out.mode = value;
        break;
      }
      case "--json": out.json = true; break;
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: node scripts/verify-tenant-isolation.mjs [options]\n"
          + "  --base-url URL          (default http://127.0.0.1:30141)\n"
          + "  --home-root DIR         (default $OMP_WEB_HOME_ROOT)\n"
          + "  --tenant NAME           dummy tenant A (default verifyalpha)\n"
          + "  --tenant-password PW\n"
          + "  --peer-tenant NAME      dummy tenant B (default verifybeta)\n"
          + "  --peer-password PW\n"
          + "  --admin-user NAME       (default $OMP_WEB_ADMIN_USER or verifyadmin)\n"
          + "  --admin-password PW     (default $OMP_WEB_ADMIN_PASSWORD or verify-admin-password-1)\n"
          + "  --service-agent-dir DIR (default $PI_CODING_AGENT_DIR)\n"
          + "  --secrets-file FILE     (default $OMP_WEB_SECRETS_FILE)\n"
          + "  --server-log FILE       captured stderr of the server under test;\n"
          + "                          required for --mode opt-out (row 6b reads it)\n"
          + "  --mode probe|fail-closed|opt-out\n"
          + "  --json\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ergebnis-Sammlung — nichts darf stillschweigend gruen werden.
// ---------------------------------------------------------------------------

const rows = [];
/** Berichtszeilen. In `--json` bleibt stdout reines JSON, damit ein Aufrufer
 *  es ohne Filter parsen kann; die Erzaehlung geht dann nach stderr. */
let quietStdout = false;
function note(text) {
  if (quietStdout) process.stderr.write(text);
  else process.stdout.write(text);
}
function record(id, claim, status, observed) { rows.push({ id, claim, status, observed }); }
const pass = (id, claim, observed) => record(id, claim, "PASS", observed);
const fail = (id, claim, observed) => record(id, claim, "FAIL", observed);
const skip = (id, claim, observed) => record(id, claim, "SKIP", observed);
/**
 * "Diese Zeile misst dieser Modus nicht."
 *
 * `--mode fail-closed` startet bewusst einen Server **ohne** `bwrap`: dort gibt
 * es keinen Worker, also auch kein `/proc/<worker>/root/home`, kein Archiv und
 * keine Mandanten-Shell. Die Zeilen 2, 3, 4, 7 und A1-A10 zu faerben waere
 * zweierlei falsch: rot, obwohl nichts defekt ist, und gruen waere eine Luege.
 *
 * `N/A` ist keine Wertung, sondern die Feststellung, dass die Messung in diesem
 * Modus nicht stattfindet. Sie zaehlt weder als bestanden noch als offen; der
 * jeweilige Modus hat seine eigenen Zeilen (5a-d bzw. 6a-b), und die sind es,
 * die dort etwas aussagen.
 */
const na = (id, claim, observed) => record(id, claim, "N/A", observed);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const COOKIE = "omp_session";

async function request(opts, path, init = {}, cookie = null) {
  const headers = { ...(init.headers ?? {}) };
  if (cookie) headers.cookie = `${COOKIE}=${cookie}`;
  let res;
  try {
    res = await fetch(`${opts.baseUrl}${path}`, { ...init, headers, redirect: "manual" });
  } catch (error) {
    return { status: 0, error: String(error?.cause?.code ?? error), headers: new Map(), text: "", json: null };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON is itself an observation */ }
  return { status: res.status, headers: res.headers, text, json };
}

function takeCookie(res) {
  const raw = res.headers?.getSetCookie?.() ?? [];
  for (const entry of raw) {
    const match = new RegExp(`(?:^|,\\s*)${COOKIE}=([^;]+)`).exec(entry);
    if (match) return match[1];
  }
  // Fallback: some runtimes expose only the joined header.
  const joined = res.headers?.get?.("set-cookie");
  const match = joined ? new RegExp(`${COOKIE}=([^;]+)`).exec(joined) : null;
  return match ? match[1] : null;
}

/**
 * Ein Modell, das nie aufgerufen wird.
 *
 * `baseUrl` zeigt auf `127.0.0.1:9` (discard), damit ein versehentlicher
 * Modellaufruf sofort scheitert statt in ein echtes Netz zu gehen. `apiKey` ist
 * ein Platzhalter; es geht kein Schluessel des Betreibers in den Mandanten, das
 * ist genau die Zusage aus `lib/tenant-config.ts`.
 */
function seedTenantModel(home) {
  const agentDir = join(home, ".omp", "agent");
  try {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(agentDir, "models.yml"), [
      "providers:",
      "  local:",
      "    baseUrl: http://127.0.0.1:9/v1",
      "    apiKey: dummy-tenant-key",
      "    auth: apiKey",
      "    api: openai-completions",
      "    models:",
      "      - id: dummy-model",
      "",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  default: local/dummy-model\n", { mode: 0o600 });
  } catch { /* 3a/3c report the consequence */ }
}

async function login(opts, username, password) {
  const res = await request(opts, "/api/web-access/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return { res, cookie: takeCookie(res) };
}

// ---------------------------------------------------------------------------
// /proc
// ---------------------------------------------------------------------------

function rpcProcesses() {
  if (!existsSync("/proc")) return null;
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let raw;
    try { raw = readFileSync(`/proc/${entry}/cmdline`, "utf8"); } catch { continue; }
    const argv = raw.split("\0").filter(Boolean);
    const at = argv.indexOf("--mode");
    if (at === -1 || argv[at + 1] !== "rpc") continue;
    found.push({ pid: Number(entry), argv });
  }
  return found;
}

/**
 * Ist dieser Prozess in der Namespace, oder ist er nur der bwrap-Stub davor?
 *
 * Gemessen am 2026-11-08 auf diesem Host: ein Worker erscheint als **drei**
 * Prozesse — `bwrap` (Supervisor, noch in der Host-Mount-Namespace), `bwrap`
 * (pid 1 der Namespace) und der eigentliche `bun`. Alle drei tragen `--mode
 * rpc` bzw. den Mandantennamen im argv, weil bwrap den ganzen Befehl als eigene
 * Argumente mitfuehrt. Der erste ist damit **kein** Beweis fuer die Grenze: sein
 * `/proc/<pid>/root` ist der Host, und `/home` zeigt `pi`.
 *
 * Das Kriterium ist deshalb nicht der argv, sondern die Mount-Namespace: nur ein
 * Prozess mit einer anderen `mnt:`-Namespace als dieser Host sieht die Grenze.
 * Ohne diese Unterscheidung wuerde das Harness den Stub messen und die
 * Isolationszeilen zufaellig rot faerben — oder, schlimmer, gruen, wenn die
 * Stub-Namespace zufaellig so aussieht wie erwartet.
 */
function insideOwnMountNamespace(pid) {
  try {
    // `readlinkSync`, nicht `readFileSync`: `/proc/<pid>/ns/mnt` ist ein
    // Symlink auf `mnt:[inode]`, und ihn zu *lesen* liefert keinen Text.
    // Gemessen: mit `readFileSync` meldeten alle drei Worker `false` und das
    // Kriterium wurde still wirkungslos.
    return readlinkSync(`/proc/${pid}/ns/mnt`) !== readlinkSync("/proc/self/ns/mnt");
  } catch {
    return false;
  }
}

/**
 * Worker, deren argv oder deren Guest-Home auf den Mandanten zeigt.
 *
 * Wenn mehrere Prozesse auf denselben Mandanten passen (bwrap-Supervisor,
 * pid 1 der Namespace, der Bun selbst), wird der **innerste** gewaehlt: der
 * Prozess mit eigener Mount-Namespace und dem groessten PID-Baum nach unten.
 * Das ist der, dessen `/proc/<pid>/root` die Grenze zeigt.
 */
function workersFor(tenant, procs) {
  const matched = (procs ?? []).filter(({ pid, argv }) => {
    if (argv.some((value) => value === tenant || value.endsWith(`/${tenant}`))) return true;
    try {
      // Ein Worker spricht /home/<name>; der Hostpfad ist nur ueber
      // /proc/<pid>/root sichtbar. Beides wird geprueft, damit ein spaeterer
      // Startpfad nicht durchfaellt.
      return readFileSync(`/proc/${pid}/environ`, "utf8").includes(`HOME=/home/${tenant}\0`);
    } catch {
      return false;
    }
  });
  const confined = matched.filter(({ pid }) => insideOwnMountNamespace(pid));
  const pool = confined.length > 0 ? confined : matched;
  // Innerster Prozess: der mit der tiefsten Position im Baum, also der, der am
  // wenigsten Nachfahren hat. Bei bwrap ist das der Bun.
  const descendants = (pid) => {
    let count = 0;
    for (const candidate of pool) {
      let cursor = candidate.pid;
      for (let depth = 0; depth < 8; depth += 1) {
        try {
          const ppid = Number(readFileSync(`/proc/${cursor}/stat`, "utf8").split(" ")[3]);
          if (ppid === pid) { count += 1; break; }
          if (ppid <= 1) break;
          cursor = ppid;
        } catch { break; }
      }
    }
    return count;
  };
  return [...pool].sort((a, b) => descendants(a.pid) - descendants(b.pid) || b.pid - a.pid);
}

function guestStat(pid, path) {
  try {
    const st = statSync(`/proc/${pid}/root${path}`);
    return { ok: true, isDirectory: st.isDirectory(), mode: st.mode & 0o777 };
  } catch (error) { return { ok: false, code: error?.code ?? String(error) }; }
}

function guestRead(pid, path) {
  try { return { ok: true, value: readFileSync(`/proc/${pid}/root${path}`, "utf8") }; }
  catch (error) { return { ok: false, code: error?.code ?? String(error) }; }
}

// ---------------------------------------------------------------------------
// Sonstiges
// ---------------------------------------------------------------------------

function walkFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function modeOf(path) {
  try { return statSync(path).mode & 0o777; } catch (error) { return error?.code ?? "?"; }
}

function modeText(value) { return typeof value === "number" ? value.toString(8) : String(value); }

function idFromSessionFile(file) {
  return /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Konto-Anlage
// ---------------------------------------------------------------------------

/**
 * Legt ein Konto an. Reihenfolge: dokumentierte Route zuerst, dann derselbe
 * Code, den die Route aufruft. Gibt zurueck, welcher Weg gegriffen hat, damit
 * der Bericht ihn nennen kann.
 */
async function ensureAccount(opts, adminCookie, username, password) {
  if (adminCookie) {
    const res = await request(opts, "/api/web-access/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    }, adminCookie);
    if (res.status === 200) return { via: "api", note: "POST /api/web-access/users -> 200" };
    if (/already exists/i.test(res.json?.error ?? "")) return { via: "api", note: "already existed" };
    // 403/409/... -> store path below decides.
  }
  try {
    const store = require_(join(REPO_ROOT, "bin", "web-auth-store.js"));
    // Die Umgebung des Servers, nicht die des Harness: sonst legt
    // createWebAccount das Home unter dem Default `/home` an
    // (bin/web-auth-store.js:1059-1063 prueft genau diese Wurzel). Beide
    // Variablen sind an dieser Stelle garantiert gesetzt — ohne sie haette
    // main() den Lauf schon verweigert.
    const serverEnv = {
      ...process.env,
      OMP_WEB_HOME_ROOT: opts.homeRoot,
      PI_CODING_AGENT_DIR: opts.serviceAgentDir,
    };
    const account = store.createWebAccount(username, password, { env: serverEnv });
    return { via: "store", note: `createWebAccount -> home ${account.home}, admin=${account.isAdmin}` };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/already exists/i.test(message)) {
      return { via: "store", note: "already existed in the accounts store" };
    }
    return { via: "none", note: message.slice(0, 160) };
  }
}


/**
 * Ein Kommando in der Mandanten-Session ausfuehren. Das ist die Probe aus der
 * Spalte "Probe (aus der Session des Kontos A)" in docs/plans/tenant-isolation.md
 * §11 — nicht eine Messung vom Host, sondern das, was der Mandant selbst sieht.
 * Kostet keinen Modellaufruf: `type:"bash"` geht direkt an die Shell
 * (app/api/agent/[id]/route.ts, `case "bash"` in lib/rpc-manager.ts:1457).
 */
async function tenantShell(opts, cookie, sessionId, command) {
  const res = await request(opts, `/api/agent/${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "bash", command }),
  }, cookie);
  const output = res.json?.data?.output;
  return { status: res.status, ok: res.status === 200 && typeof output === "string", output: output ?? "", raw: res };
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.homeRoot === null) {
    process.stderr.write("--home-root or OMP_WEB_HOME_ROOT is required: the harness must know where tenant homes live.\n");
    process.exit(1);
  }

  const accountsFile = opts.serviceAgentDir ? join(opts.serviceAgentDir, "omp-web-accounts.json") : null;
  const accountsFileExisted = accountsFile !== null && existsSync(accountsFile);
  const rpcBaseline = rpcProcesses()?.length ?? null;
  const cleanup = { createdHomes: [], seededAccountsFile: false };

  // Sicherung gegen den Fehler, der beim Bau dieses Harness passiert ist: der
  // Store-Code faellt ohne `PI_CODING_AGENT_DIR` auf `~/.omp/agent` zurueck und
  // haette dort Konten angelegt. Ein Lauf gegen den echten Dienst ist kein
  // Testlauf — er wird hier verweigert, nicht nur dokumentiert.
  if (opts.serviceAgentDir === null) {
    process.stderr.write(
      "Refusing to run: --service-agent-dir (or PI_CODING_AGENT_DIR) is required and must point at the\n"
      + "scratch agent directory of the server under test. Without it the account store falls back to\n"
      + "~/.omp/agent, which is the live service directory.\n",
    );
    process.exit(1);
  }
  const resolvedAgentDir = resolve(opts.serviceAgentDir);
  const liveAgentDir = resolve(process.env.HOME ?? "/home/pi", ".omp", "agent");
  const insideHomeRoot = resolve(opts.homeRoot).startsWith(resolvedAgentDir)
    || resolvedAgentDir.startsWith(resolve(opts.homeRoot))
    || resolvedAgentDir.startsWith("/tmp/");
  if (resolvedAgentDir === liveAgentDir || !insideHomeRoot) {
    process.stderr.write(
      `Refusing to run: agent dir ${resolvedAgentDir} is the live service directory (${liveAgentDir})\n`
      + `or is not under the scratch home root ${resolve(opts.homeRoot)} / /tmp.\n`,
    );
    process.exit(1);
  }

  quietStdout = opts.json;
  note(`# tenant isolation acceptance — mode=${opts.mode}\n`);
  note(`# base=${opts.baseUrl} home-root=${opts.homeRoot}\n`);
  note(`# tenant=${opts.tenant} peer=${opts.peerTenant}\n\n`);

  // --- P0: erreichbar ------------------------------------------------------
  const probe = await request(opts, "/api/whoami");
  if (probe.status === 0) {
    skip("P0", "Server erreichbar", `GET /api/whoami -> ${probe.error}`);
    return finish(opts, cleanup, rpcBaseline, accountsFile, accountsFileExisted);
  }
  pass("P0", "Server erreichbar", `GET /api/whoami -> ${probe.status}`);

  // --- P1: Admin (nicht zwingend: die Kontoanlage hat einen zweiten Weg) ---
  let admin = await login(opts, opts.adminUser, opts.adminPassword);
  if (admin.cookie === null) {
    // Konto existiert vielleicht noch nicht: anlegen, dann erneut versuchen.
    await ensureAccount(opts, null, opts.adminUser, opts.adminPassword);
    admin = await login(opts, opts.adminUser, opts.adminPassword);
  }
  const adminCookie = admin.cookie;
  if (adminCookie === null) {
    // Kein SKIP: die Kontoanlage hat einen zweiten, gleichwertigen Weg
    // (`createWebAccount` aus dem Store-Code, den die Route selbst aufruft),
    // und der wird unten benutzt. Ein SKIP wuerde den ganzen Lauf zu
    // `INCOMPLETE` machen, obwohl nichts offen ist — die Voraussetzung ist
    // nicht "fehlt", sondern "wird anders erfuellt".
    na("P1", "Admin anmeldbar (fuer die dokumentierte Konto-Route)",
      `POST /api/web-access/login -> ${admin.res.status}; Kontoanlage laeuft ueber den Store-Code`);
  } else {
    pass("P1", "Admin anmeldbar (fuer die dokumentierte Konto-Route)", `POST /api/web-access/login -> 200`);
  }

  // --- Konten -------------------------------------------------------------
  // Die angelegten Homes merkt sich `cleanup.createdHomes` (unten), sobald sie
  // wirklich existieren; eine zweite Liste hier waere eine zweite Wahrheit.
  for (const [username, password] of [
    [opts.tenant, opts.tenantPassword],
    [opts.peerTenant, opts.peerPassword],
  ]) {
    const home = join(opts.homeRoot, username);
    const existed = existsSync(home);
    const result = await ensureAccount(opts, adminCookie, username, password);
    // Ein Konto kann im Store stehen, waehrend sein Home fehlt (ein frueherer
    // Lauf hat aufgeraeumt, der Store blieb). Die Route legt es dann nicht neu
    // an — `createWebAccount` verweigert vorhandene Namen. Fuer den Lauf wird
    // das Verzeichnis deshalb hier ergaenzt, mit demselben Mode wie
    // `createWebAccount` (0o700, bin/web-auth-store.js:1066).
    if (!existsSync(home)) {
      try { mkdirSync(home, { recursive: false, mode: 0o700 }); } catch { /* reported via 3a */ }
    }
    if (!existed && existsSync(home)) cleanup.createdHomes.push(home);
    if (result.via === "store") cleanup.seededAccountsFile = true;
    // Ein frisches Mandantenkonto bekommt vom Produkt **bewusst** keine
    // Provider-Konfiguration (lib/tenant-config.ts:38-46: den globalen
    // `models.yml` zu kopieren hiesse, den Betreiber-Key an den ersten
    // angemeldeten Mandanten weiterzugeben). Ohne Modell bricht der Worker-Start
    // ab — ehrlich und mit Grund, aber die Isolationszeilen waeren dann nicht
    // messbar. Deshalb legt das Harness denselben leeren Probezustand an, den
    // ein Betreiber ueber `PUT /api/models-config` setzen wuerde: ein
    // Platzhalter-Provider auf 127.0.0.1:9, der nie erreicht wird, weil keine
    // Zeile einen Modellaufruf macht.
    seedTenantModel(home);
    note(`# account ${username}: via ${result.via} — ${result.note}\n`);
  }
  note("\n");

  const tenantHome = join(opts.homeRoot, opts.tenant);
  const peerHome = join(opts.homeRoot, opts.peerTenant);

  // --- 1: Login ------------------------------------------------------------
  const alpha = await login(opts, opts.tenant, opts.tenantPassword);
  if (alpha.cookie === null) {
    fail("1", "Mandant kann sich anmelden",
      `POST /api/web-access/login {username:"${opts.tenant}"} -> ${alpha.res.status} ${alpha.res.text.slice(0, 100)}`);
    return finish(opts, cleanup, rpcBaseline, accountsFile, accountsFileExisted);
  }
  pass("1", "Mandant kann sich anmelden", `POST /api/web-access/login -> 200, Cookie ${COOKIE} gesetzt`);

  const beta = await login(opts, opts.peerTenant, opts.peerPassword);
  if (beta.cookie === null) skip("4d", "Zweitmandant anmeldbar", `-> ${beta.res.status}`);

  // B braucht ein eigenes Archiv, sonst ist "A darf B nicht lesen" nicht
  // pruefbar und wuerde stillschweigend zu SKIP. Dieselbe billige Bauart:
  // ensure_session + bash, kein Modellaufruf.
  let peerSessionId = null;
  if (beta.cookie !== null) {
    const peerNew = await request(opts, "/api/agent/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: peerHome, type: "ensure_session" }),
    }, beta.cookie);
    peerSessionId = peerNew.json?.sessionId ?? null;
    if (peerSessionId !== null) {
      const peerBash = await request(opts, `/api/agent/${peerSessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "bash", command: "echo omp-web-verify-peer" }),
      }, beta.cookie);
      note(`# peer ${opts.peerTenant}: ensure_session -> ${peerNew.status}, bash -> ${peerBash.status}\n`);
    } else {
      note(`# peer ${opts.peerTenant}: ensure_session -> ${peerNew.status} (keine Session)\n`);
    }
  }

  // --- erste Agent-Anfrage -------------------------------------------------
  const agentRes = await request(opts, "/api/agent/new", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: tenantHome, type: "ensure_session" }),
  }, alpha.cookie);
  const sessionId = agentRes.json?.sessionId ?? null;
  note(`# POST /api/agent/new {type:ensure_session} -> ${agentRes.status}`
    + `${sessionId ? ` session=${sessionId}` : ""}`
    + `${agentRes.json?.error ? ` error=${JSON.stringify(agentRes.json.error).slice(0, 110)}` : ""}\n`);

  // `ensure_session` legt die Runtime an, schreibt aber noch kein Archiv: die
  // Datei entsteht erst, wenn es Eintraege gibt (lib/rpc-manager.ts:1005-1020,
  // `persistBashOnlySession`). Ein `bash`-Kommando ueber dieselbe Session
  // erzeugt genau diesen Eintrag, ohne einen Modellaufruf und ohne Kosten —
  // damit sind die Zeilen 3 und 4 am echten Archiv pruefbar.
  let bashOk = false;
  if (sessionId !== null) {
    const bashRes = await request(opts, `/api/agent/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "bash", command: "echo omp-web-verify" }),
    }, alpha.cookie);
    bashOk = bashRes.status === 200;
    note(`# POST /api/agent/${sessionId} {type:bash} -> ${bashRes.status}`
      + `${bashOk ? "" : ` ${(bashRes.text ?? "").slice(0, 120)}`}\n`);
  }
  note("\n");

  await new Promise((r) => setTimeout(r, 800));

  const procs = rpcProcesses();
  if (procs === null) {
    skip("2", "Worker-Grenze (/proc)", "kein /proc auf diesem Host");
    return finish(opts, cleanup, rpcBaseline, accountsFile, accountsFileExisted);
  }

  const mine = workersFor(opts.tenant, procs);
  const others = procs.filter((p) => !mine.includes(p));

  // Ab hier wird der *laufende Worker* vermessen. In `--mode fail-closed` gibt
  // es keinen: der Server laeuft dort ohne `bwrap`, damit 5a-d beweisen koennen,
  // dass kein ungesandboxter Worker entsteht. Die Zeilen sind dann N/A statt
  // rot — es ist nichts defekt, es wird nur nichts gemessen.
  // Gemessen werden die Worker-Zeilen nur, wo ein Worker entstehen *soll*:
  // `probe`. `fail-closed` startet ohne `bwrap` (kein Worker, siehe 5a-d), und
  // `opt-out` schaltet die Grenze ausdruecklich ab (6a/6b belegen das).
  const workerRowsApply = opts.mode === "probe";

  // --- 2: Worker-Grenze ----------------------------------------------------
  if (!workerRowsApply) {
    for (const id of ["2a", "2b", "2c", "2d", "2e", "2f"]) {
      // Der Text nennt den Modus, in dem der Lauf steht. Vorher stand hier
      // fest "--mode fail-closed", und ein opt-out-Lauf behauptete damit
      // etwas ueber einen Modus, in dem er nicht lief.
      na(id, "Worker-Grenze", `kein Worker in --mode ${opts.mode} (siehe 5a-d nur in fail-closed)`);
    }
  } else if (mine.length === 0) {
    const why = `${procs.length} RPC-Prozess(e) sichtbar, 0 mit ${opts.tenant} in argv oder HOME`;
    fail("2a", "Ein Workerprozess pro Mandant", why);
    fail("2b", "/proc/<worker>/root/home enthaelt nur den Mandanten", "kein Worker — Agent laeuft im Serverprozess");
    fail("2c", "/proc/<worker>/root/home/<hostuser> existiert nicht", "kein Worker");
    fail("2d", "Worker-environ traegt keine Dienstgeheimnisse", "kein Worker — kein Kindprozess zum Messen");
    fail("2e", "Guest-Geheimnisdatei im Worker nicht lesbar", "kein Worker");
    fail("2f", "boundary.enforced stimmt mit dem Kernelbefund ueberein", "kein Worker — keine Grenze zu melden");
  } else {
    pass("2a", "Ein Workerprozess pro Mandant",
      `${mine.length} Worker (pids ${mine.map((p) => p.pid).join(",")}), ${procs.length} RPC gesamt`
      + (others.length ? `, fremde pids ${others.map((p) => p.pid).join(",")}` : ""));

    const worker = mine[0];

    const homeStat = guestStat(worker.pid, "/home");
    let entries = [];
    if (homeStat.ok && homeStat.isDirectory) {
      try { entries = readdirSync(`/proc/${worker.pid}/root/home`); } catch (error) { entries = [`<${error.code}>`]; }
    }
    const onlyTenant = homeStat.ok && homeStat.isDirectory && entries.length === 1 && entries[0] === opts.tenant;
    (onlyTenant ? pass : fail)("2b", "/proc/<worker>/root/home enthaelt nur den Mandanten",
      `pid ${worker.pid}: ${homeStat.ok ? JSON.stringify(entries) : homeStat.code}`);

    const hostUser = process.env.USER ?? process.env.LOGNAME ?? "pi";
    const hostHome = guestStat(worker.pid, `/home/${hostUser}`);
    (!hostHome.ok ? pass : fail)("2c", `/proc/<worker>/root/home/${hostUser} existiert nicht`,
      `pid ${worker.pid}: ${hostHome.ok ? "vorhanden" : hostHome.code}`);

    let environ = "";
    try { environ = readFileSync(`/proc/${worker.pid}/environ`, "utf8"); } catch { /* reported below */ }
    const names = environ.split("\0").filter(Boolean).map((kv) => kv.split("=", 1)[0]);
    const leaked = ["BRAVE_API_KEY", "PARALLEL_API_KEY", "OMP_WEB_PASSWORD"].filter((n) => names.includes(n));
    const keyPath = /omp-web-session-key/.test(environ);
    (leaked.length === 0 && !keyPath ? pass : fail)("2d", "Worker-environ traegt keine Dienstgeheimnisse",
      `${names.length} keys [${names.join(",")}]`
      + (leaked.length ? ` — GEFUNDEN: ${leaked.join(",")}` : "")
      + (keyPath ? " — GEFUNDEN: omp-web-session-key" : ""));

    const secretsPath = opts.secretsFile ?? "/etc/omp-web.env";
    const guest = guestRead(worker.pid, secretsPath);
    const empty = guest.ok && guest.value.trim().length === 0;
    (guest.ok && !empty ? fail : pass)("2e", `Guest ${secretsPath} im Worker nicht lesbar`,
      guest.ok ? (empty ? "leer (maskiert)" : `${guest.value.length} Bytes lesbar`) : `nicht lesbar (${guest.code})`);

    // 2f: sagt die API dasselbe wie der Kernel?
    //
    // `boundary.enforced` ist eine Behauptung des Servers gegenueber dem Client.
    // Sie darf nicht aus `pid !== undefined` folgen: ein `bwrap`-Wrapper frueher
    // im PATH, der die Nutzlast ohne Mount-Namespace `exec`t, liefert eine PID
    // und keine Grenze (§5/§8 des Plans). Seit dem Fix steht `enforced: true`
    // nur nach einer bestandenen Probe (`lib/tenant-namespace-probe.ts`), die
    // vom Kernel liest: `/proc/<pid>/root` muss eine eigene Wurzel haben, und
    // `/proc/<pid>/root/home` muss genau den Mandanten enthalten.
    //
    // Beide Richtungen, und die negative wird **nicht** mit einem gefaelschten
    // `bwrap` gebaut, sondern ueber die eingeschleuste Probe
    // (`lib/tenant-worker.test.mjs`, "a worker whose namespace probe fails is
    // refused"): ein Wrapper auf dem PATH waere ein zweiter Testgegenstand
    // (PATH-Aufloesung, Shell-Semantik, `exec`-Ersatz) und wuerde messen, ob der
    // Wrapper funktioniert — nicht, ob der Server ohne Grenze schweigt. Diese
    // Zeile misst deshalb die positive Richtung am laufenden Server und
    // verweist fuer die negative auf den Test, der sie fuehrt.
    const listRes2f = await request(opts, "/api/sessions", {}, alpha.cookie);
    const own = (listRes2f.json?.sessions ?? []).find((s) => s.id === sessionId) ?? null;
    const boundary = own?.boundary ?? null;
    if (listRes2f.status !== 200) {
      skip("2f", "boundary.enforced stimmt mit dem Kernelbefund ueberein", `GET /api/sessions -> ${listRes2f.status}`);
    } else if (own === null) {
      fail("2f", "boundary.enforced stimmt mit dem Kernelbefund ueberein",
        `Session ${sessionId} fehlt in der Liste (${(listRes2f.json?.sessions ?? []).length} Zeilen)`);
    } else if (!boundary) {
      fail("2f", "boundary.enforced stimmt mit dem Kernelbefund ueberein",
        `kein boundary-Feld an Session ${sessionId} — der Client kann \"Worker\" nicht von \"Serverprozess\" unterscheiden`);
    } else {
      const claimed = boundary.enforced === true;
      // Die Zusage ist eine Gleichheit in beide Richtungen: ein `true` ohne
      // Grenze ist die Behauptung, die der Fix verbietet; ein `false` bei
      // stehender Grenze waere die umgekehrte Luege (und wuerde den Fix
      // verdecken, wenn er zu streng ablehnt). Der Kernelbefund ist `onlyTenant`
      // aus Zeile 2b: genau ein Eintrag unter `/proc/<worker>/root/home`, und er
      // ist der Mandant.
      (claimed === onlyTenant ? pass : fail)(
        "2f", "boundary.enforced stimmt mit dem Kernelbefund ueberein",
        `API: kind=${JSON.stringify(boundary.kind)} enforced=${claimed} pid=${boundary.pid ?? "—"}; `
        + `Kernel: /proc/<worker>/root/home = ${JSON.stringify(entries)} (${onlyTenant ? "eigene Wurzel" : "Host-Wurzel"})`
        + (claimed === onlyTenant ? "" : " — die API behauptet etwas anderes als der Kernel zeigt")
        + "; negativer Fall: `bun test lib/tenant-worker.test.mjs` (\u00abnamespace probe fails\u00bb) belegt, dass eine fehlgeschlagene Probe keinen enforced-Worker zurueckgibt",
      );
    }
  }

  // --- 3: Store-Layout -----------------------------------------------------
  // Die Archive liegen im Dienst-Agent-Verzeichnis, in einem nach dem cwd
  // kodierten Bucket (`<agentDir>/sessions/<cwd-kodiert>/<ts>_<id>.jsonl`,
  // node_modules/@oh-my-pi/pi-coding-agent/src/session/session-storage.ts via
  // pi-utils getSessionsDir:998). Das ist der Befund, den die Spezifikation
  // umbauen will: das Dienstverzeichnis traegt alle Mandanten.
  const tenantSessionsDir = join(tenantHome, ".omp", "agent", "sessions");
  const serviceSessions = opts.serviceAgentDir ? walkFiles(join(opts.serviceAgentDir, "sessions")) : [];
  const tenantArchived = walkFiles(tenantSessionsDir);

  const serviceBuckets = opts.serviceAgentDir
    ? (() => {
      try { return readdirSync(join(opts.serviceAgentDir, "sessions"), { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name); }
      catch { return []; }
    })()
    : [];

  // 3a: liegt das Archiv im Mandanten-Home? (das Ziel)
  if (!workerRowsApply) {
    // Ohne Session gibt es kein Archiv; die Frage stellt sich nicht.
    for (const id of ["3a", "3c", "3d", "3e"]) {
      na(id, "Archiv-Layout", `keine Session in --mode ${opts.mode} (siehe 5a)`);
    }
  } else if (tenantArchived.length > 0) {
    pass("3a", "Archiv liegt im Mandanten-Home (<root>/<tenant>/.omp/agent/sessions)",
      `${tenantArchived.length} Datei(en) unter ${tenantSessionsDir}`);
  } else {
    fail("3a", "Archiv liegt im Mandanten-Home (<root>/<tenant>/.omp/agent/sessions)",
      `${tenantSessionsDir}: ${existsSync(tenantSessionsDir) ? "leer" : "existiert nicht"}`
      + `; ${serviceSessions.length} Datei(en) im Dienstverzeichnis`
      + (serviceBuckets.length ? ` (Buckets: ${serviceBuckets.join(", ")})` : ""));
  }

  // 3b: liegt ein Mandanten-Archiv im Dienstverzeichnis? (der heutige Zustand)
  const tenantTaggedService = serviceSessions.filter((file) => file.includes(opts.tenant));
  if (opts.serviceAgentDir === null) {
    skip("3b", "Kein Mandanten-Archiv im Dienst-Agent-Verzeichnis", "kein --service-agent-dir");
  } else if (tenantTaggedService.length === 0) {
    pass("3b", "Kein Mandanten-Archiv im Dienst-Agent-Verzeichnis",
      `${serviceSessions.length} Datei(en) im Dienstverzeichnis, keine mit "${opts.tenant}" im Pfad`);
  } else {
    fail("3b", "Kein Mandanten-Archiv im Dienst-Agent-Verzeichnis",
      `${tenantTaggedService.length} Datei(en) mit "${opts.tenant}" im Pfad, z.B. ${tenantTaggedService[0]}`);
  }

  if (workerRowsApply) {
    (tenantArchived.length > 0 ? pass : fail)(
      "3c", "Mindestens ein Archiv des Mandanten existiert ueberhaupt",
      `${tenantArchived.length} im Home, ${tenantTaggedService.length} im Dienstverzeichnis`,
    );
  }

  const archiveDir = tenantArchived.length > 0 ? tenantSessionsDir : join(opts.serviceAgentDir ?? "", "sessions");
  const dirMode = modeOf(archiveDir);
  const fileModes = tenantArchived.map((file) => ({ file, mode: statSync(file).mode & 0o777 }));
  if (workerRowsApply) {
    (typeof dirMode === "number" && (dirMode & 0o077) === 0 ? pass : fail)(
      "3d", "Session-Verzeichnis des Mandanten ist 0700", `${archiveDir} -> ${modeText(dirMode)}`,
    );
  }

  if (!workerRowsApply) {
    // 3e bereits N/A gesetzt; nichts weiter zu messen.
  } else if (fileModes.length === 0) {
    fail("3e", "Session-Datei des Mandanten ist 0600", "kein Archiv im Mandanten-Home");
  } else {
    const groupReadable = fileModes.filter((m) => (m.mode & 0o077) !== 0);
    (groupReadable.length === 0 ? pass : fail)("3e", "Session-Datei des Mandanten ist 0600",
      fileModes.map((m) => `${m.file.slice(tenantSessionsDir.length + 1)}=${modeText(m.mode)}`).slice(0, 3).join(", ")
      + (fileModes.length > 3 ? ` (+${fileModes.length - 3})` : ""));
  }

  // --- 7: keine weltlesbare Mandanten-Datei --------------------------------
  // Der Vertrag fragt nach "keine weltlesbare Mandanten-Datei", nicht nach
  // "unter dem Home". Deshalb beide Orte: das Mandanten-Agent-Verzeichnis und
  // die Mandanten-Dateien im Dienstverzeichnis, denn dort liegen sie heute
  // (gemessen 0644, siehe 3b).
  const agentDirOfTenant = join(tenantHome, ".omp", "agent");
  const agentFiles = walkFiles(agentDirOfTenant);
  const worldReadableHome = agentFiles.filter((file) => (statSync(file).mode & 0o004) !== 0);
  const worldReadableService = tenantTaggedService.filter((file) => (statSync(file).mode & 0o004) !== 0);
  const worldReadable = [...worldReadableHome, ...worldReadableService];
  const scanned = agentFiles.length + tenantTaggedService.length;
  if (opts.mode === "opt-out") {
    // Im Ausstieg ist die Grenze abgeschaltet, also ist eine weltlesbare Datei
    // die erwartete Lage und keine Regression — 6c belegt sie positiv. Die
    // Zeile hier zu faerben hiesse, den Ausstieg an einer Grenze zu messen, die
    // er ausdruecklich entfernt.
    na("7", "Keine weltlesbare Mandanten-Datei (o+r)",
      `${scanned} Datei(en), ${worldReadable.length} weltlesbar — erwartete Lage in --mode opt-out (siehe 6c)`);
  } else {
  (worldReadable.length === 0 ? pass : fail)("7", "Keine weltlesbare Mandanten-Datei (o+r)",
    `${scanned} Datei(en) geprueft (${agentFiles.length} im Home, ${tenantTaggedService.length} im Dienstverzeichnis), `
    + `${worldReadable.length} weltlesbar`
    + (worldReadable.length ? `: ${worldReadable.slice(0, 2).map((f) => `${f.split("/").slice(-1)[0]} ${modeText(statSync(f).mode & 0o777)}`).join(", ")}` : ""));
  }

  // --- 4: mandantenfremde Daten -------------------------------------------
  // Das Ziel-Archiv von B: im Mandanten-Home, sonst dort, wo es heute liegt.
  const peerHomeArchives = walkFiles(join(peerHome, ".omp", "agent", "sessions"));
  const peerServiceArchives = serviceSessions.filter((file) => file.includes(opts.peerTenant));
  const peerArchive = peerHomeArchives[0] ?? peerServiceArchives[0] ?? null;

  // Kontrolle: kann A ueberhaupt ein Archiv ueber /api/files lesen?
  // Ohne diese Zeile ist ein 403 auf B's Datei nicht von "liegt ausserhalb
  // meiner erlaubten Wurzeln" zu unterscheiden — der Befund waere dann
  // gruen, ohne etwas ueber die Mandantengrenze zu sagen.
  const ownArchive = tenantArchived[0] ?? tenantTaggedService[0] ?? null;
  let discriminating = null;
  if (!workerRowsApply) {
    for (const id of ["4a0", "4a", "4b"]) {
      na(id, "mandantenfremde Daten", "kein Archiv in --mode fail-closed (siehe 5a)");
    }
  } else if (ownArchive === null) {
    skip("4a0", "Kontrolle: A kann das eigene Archiv lesen", "A hat kein Archiv");
  } else {
    const ownRes = await request(opts, `/api/files${ownArchive}?type=read`, {}, alpha.cookie);
    discriminating = ownRes.status === 200;
    (discriminating ? pass : fail)("4a0", "Kontrolle: A kann das eigene Archiv lesen",
      `GET /api/files${ownArchive}?type=read -> ${ownRes.status}`
      + (discriminating ? "" : " — damit ist ein 403 auf B's Datei NICHT als Mandantengrenze belegbar"));
  }

  if (!workerRowsApply) {
    // bereits N/A gesetzt
  } else if (peerArchive === null) {
    skip("4a", "A bekommt kein B-Archiv ueber /api/files", "B hat kein Archiv (bash-Command nicht persistiert)");
  } else {
    const url = `/api/files${peerArchive}?type=read`;
    const res = await request(opts, url, {}, alpha.cookie);
    (res.status === 403 || res.status === 404 ? pass : fail)(
      "4a", "A bekommt kein B-Archiv ueber /api/files",
      `GET ${url} -> ${res.status}${res.json?.error ? ` ${res.json.error}` : ` (${res.text.length} B Body)`}`
      + (discriminating === false ? " (nicht diskriminierend: eigene Datei antwortet genauso, siehe 4a0)" : ""),
    );
  }

  const peerIds = [...peerHomeArchives, ...peerServiceArchives].map(idFromSessionFile).filter(Boolean);
  if (!workerRowsApply) {
    // bereits N/A gesetzt
  } else if (peerIds.length === 0) {
    skip("4b", "A bekommt keine B-Session ueber /api/sessions/<id>", "keine B-Session-Id auffindbar");
  } else {
    const res = await request(opts, `/api/sessions/${peerIds[0]}`, {}, alpha.cookie);
    (res.status === 403 || res.status === 404 ? pass : fail)(
      "4b", "A bekommt keine B-Session ueber /api/sessions/<id>",
      `GET /api/sessions/${peerIds[0]} -> ${res.status}`,
    );
  }

  const listRes = await request(opts, "/api/sessions", {}, alpha.cookie);
  if (listRes.status !== 200) {
    skip("4c", "Session-Liste von A enthaelt keine B-Ids", `GET /api/sessions -> ${listRes.status}`);
  } else {
    const ids = (listRes.json?.sessions ?? []).map((s) => s.id).filter(Boolean);
    const peerIdSet = new Set(peerIds);
    const overlap = ids.filter((id) => peerIdSet.has(id));
    (overlap.length === 0 ? pass : fail)("4c", "Session-Liste von A enthaelt keine B-Ids",
      `${ids.length} Ids bei A, ${peerIdSet.size} bei B, Schnitt ${overlap.length}`);
  }

  // --- A1..A10: die Probe aus der Mandanten-Session -------------------------
  // Die Zeilen oben messen vom Host. Die Spezifikation fragt aber, was das
  // Konto *aus seiner Session heraus* sieht (§11, Spalte "Probe"). Ohne diese
  // Zeilen waere "isoliert" eine Aussage ueber /proc, nicht ueber den Agenten.
  // Diese Beobachtungen braucht `--mode opt-out` mit umgekehrtem Vorzeichen:
  // dort ist die Grenze absichtlich aus, und der Beweis lautet dann "das fremde
  // Konto IST sichtbar". Ein Modus, der das nicht prueft, waere gruen, wenn der
  // Ausstieg gar nichts taete.
  const optOutEvidence = {};
  // In `--mode opt-out` existiert eine Session, aber die Grenze ist absichtlich
  // aus. Die A-Zeilen fragen "ist die Grenze dicht?" — dort lautet die Antwort
  // per Auftrag nein, also sind sie N/A. Gemessen wird stattdessen das
  // Gegenteil, und zwar als Beweis (6c): das fremde Konto muss sichtbar sein.
  const optOutMode = opts.mode === "opt-out";
  if (sessionId === null) {
    // In `--mode fail-closed` ist das die erwartete Lage: der Request scheitert
    // mit `bwrap-missing`, also gibt es keine Session und nichts zu messen. Die
    // Zeilen werden N/A statt SKIP, weil "nicht messbar" hier kein offener
    // Punkt ist — 5a-d sind die Zeilen, die diesen Modus abdecken.
    const why = opts.mode === "fail-closed"
      ? "keine Session in --mode fail-closed (siehe 5a-d)"
      : "keine Session (siehe 3a)";
    for (const id of ["A1", "A2", "A3", "A4", "A5", "A6", "A10", "A11", "A12"]) {
      if (opts.mode === "fail-closed" || opts.mode === "opt-out") na(id, "In-Session-Probe", why);
      else skip(id, "In-Session-Probe", why);
    }
  } else if (optOutMode) {
    // Nur Beobachtung, keine Wertung: dieselben Proben, aber als Beleg fuer 6c.
    const a1 = await tenantShell(opts, alpha.cookie, sessionId, `ls ${opts.homeRoot}`);
    optOutEvidence.foreignAccountVisible = a1.ok && a1.output.includes(opts.peerTenant);
    if (peerArchive !== null) {
      const a2 = await tenantShell(opts, alpha.cookie, sessionId, `head -c 40 ${peerArchive} 2>&1; echo`);
      optOutEvidence.peerArchiveReadable = a2.ok && /\{\s*"type"\s*:\s*"session"/.test(a2.output);
    } else {
      optOutEvidence.peerArchiveReadable = null;
    }
    const keyPathOptOut = opts.serviceAgentDir ? `${opts.serviceAgentDir}/omp-web-session-key` : null;
    if (keyPathOptOut !== null) {
      const a3 = await tenantShell(opts, alpha.cookie, sessionId, `[ -r ${keyPathOptOut} ] && echo READABLE || echo NO`);
      optOutEvidence.sessionKeyReadable = a3.ok && /READABLE/.test(a3.output);
    } else {
      optOutEvidence.sessionKeyReadable = null;
    }
    const foreignRootOptOut = peerHomeArchives.length > 0 ? peerHome : (opts.serviceAgentDir ?? peerHome);
    const a10 = await tenantShell(opts, alpha.cookie, sessionId,
      `find ${foreignRootOptOut} -type f -readable 2>/dev/null | wc -l`);
    const foreignReadableOptOut = Number(a10.output.trim());
    optOutEvidence.foreignFilesReadable = Number.isNaN(foreignReadableOptOut) ? null : foreignReadableOptOut;
    for (const id of ["A1", "A2", "A3", "A4", "A5", "A6", "A10", "A11", "A12"]) {
      na(id, "In-Session-Probe", "Grenze ist in --mode opt-out abgeschaltet; 6c belegt die Wirkung");
    }
  } else {
    // A1: sieht A die Konten der anderen?
    const a1 = await tenantShell(opts, alpha.cookie, sessionId, `ls ${opts.homeRoot}`);
    // Die Zeile ist nur gruen, wenn NUR das eigene Konto sichtbar ist. Ein
    // gelungenes `ls` mit fremden Namen darin ist der Befund, nicht der Beweis.
    const peerVisible = a1.output.includes(opts.peerTenant);
    optOutEvidence.foreignAccountVisible = a1.ok && peerVisible;
    (a1.ok && !peerVisible ? pass : fail)("A1", `\`ls ${opts.homeRoot}\` zeigt nur das eigene Konto`,
      a1.ok ? `${JSON.stringify(a1.output.trim())}` + (peerVisible ? ` — FREMDES KONTO SICHTBAR (${opts.peerTenant})` : "")
        : `bash -> ${a1.status} ${(a1.raw.text ?? "").slice(0, 100)}`);

    // A2: kann A das Archiv von B lesen?
    if (peerArchive === null) {
      skip("A2", "Archiv von B aus der Session lesbar", "kein B-Archiv");
    } else {
      const a2 = await tenantShell(opts, alpha.cookie, sessionId, `head -c 40 ${peerArchive} 2>&1; echo`);
      // Ein Session-Archiv beginnt immer mit `{"type":"session"`. Kommt das
      // zurueck, hat die Mandanten-Shell die Datei eines anderen Kontos gelesen
      // — unabhaengig davon, ob `head` danach noch etwas meldet.
      const leaked = a2.ok && /\{\s*"type"\s*:\s*"session"/.test(a2.output);
      optOutEvidence.peerArchiveReadable = leaked;
      (leaked ? fail : pass)("A2", "Archiv von B aus der Session nicht lesbar",
        a2.ok ? (leaked ? `GELESEN: ${JSON.stringify(a2.output.slice(0, 50))}` : a2.output.trim().slice(0, 100))
          : `bash -> ${a2.status}`);
    }

    // A3: ist der Session-Key erreichbar?
    const keyPath = opts.serviceAgentDir ? `${opts.serviceAgentDir}/omp-web-session-key` : null;
    if (keyPath === null) {
      skip("A3", "Session-Key aus der Session nicht lesbar", "kein --service-agent-dir");
    } else {
      const a3 = await tenantShell(opts, alpha.cookie, sessionId, `[ -r ${keyPath} ] && echo READABLE || echo NO`);
      optOutEvidence.sessionKeyReadable = a3.ok && /READABLE/.test(a3.output);
      (a3.ok && /READABLE/.test(a3.output) ? fail : pass)("A3", "Session-Key aus der Session nicht lesbar",
        `${keyPath}: ${a3.ok ? a3.output.trim() : `bash -> ${a3.status}`}`);
    }

    // A4: traegt die Shell Geheimnisse des Dienstes?
    //
    // Die urspruengliche Zeile fragte nach "hoechstens 10 Variablen" und ist
    // damit am falschen Kriterium gemessen. Gemessen am 2026-11-08 im Worker:
    // der **Worker** erbt 7 Schluessel (HOME LANG LOGNAME PATH
    // PI_CODING_AGENT_DIR PWD USER). Die **Shell darin** sieht 55, weil das SDK
    // seine eigenen `NON_INTERACTIVE_ENV`-Defaults hinzufuegt
    // (`src/exec/non-interactive-env.ts:6-52`: alle Pager auf `cat`, `CI=true`,
    // `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`, npm/pip/yarn-Schalter — keine
    // Geheimnisse). Die Haelfte davon ist genau das, was eine Agent-Shell
    // braucht, damit sie nicht an einem Pager haengt.
    //
    // Der Vertrag aus §11 ist "die Shell erbt keine Dienstgeheimnisse", nicht
    // "die Shell hat wenige Variablen". Deshalb wird jetzt das geprueft: kein
    // Geheimnis, und die 40 SDK-Defaults sind ausdruecklich in Ordnung. Eine
    // Obergrenze bleibt, aber als Zaehlwerk fuer "es waechst etwas nach".
    const a4 = await tenantShell(opts, alpha.cookie, sessionId, "env | sort");
    const envNames = a4.output.split("\n").filter((line) => line.includes("="))
      .map((line) => line.slice(0, line.indexOf("=")));
    const secretNames = envNames.filter((name) => /KEY|PASSWORD|TOKEN|SECRET/i.test(name));
    const envCount = envNames.length;
    (a4.ok && secretNames.length === 0 ? pass : fail)(
      "A4", "Shell erbt keine Dienstgeheimnisse",
      secretNames.length > 0
        ? `GEFUNDEN: ${secretNames.join(",")}`
        : `${envCount} Variablen, keine mit KEY/PASSWORD/TOKEN/SECRET`
          + " (SDK-NON_INTERACTIVE_ENV plus Allowlist, ohne Geheimnis)",
    );

    // A5: sieht A alle Host-Prozesse?
    const a5 = await tenantShell(opts, alpha.cookie, sessionId, "ls /proc | grep -c '^[0-9]'");
    const pidCount = Number(a5.output.trim());
    const hostPids = readdirSync("/proc").filter((e) => /^\d+$/.test(e)).length;
    (a5.ok && !Number.isNaN(pidCount) && pidCount < hostPids / 2 ? pass : fail)(
      "A5", "Shell sieht nicht alle Host-PIDs",
      `ls /proc -> ${Number.isNaN(pidCount) ? a5.output.trim().slice(0, 40) : pidCount}, Host hat ${hostPids}`,
    );

    // A6: darf A ausserhalb seines Homes schreiben?
    const probePath = `${opts.homeRoot}/zzz-write-probe`;
    const a6 = await tenantShell(opts, alpha.cookie, sessionId, `echo x > ${probePath} 2>&1 && echo WROTE || echo DENIED`);
    const wrote = /WROTE/.test(a6.output);
    try { rmSync(probePath, { force: true }); } catch { /* nothing to remove */ }
    (wrote ? fail : pass)("A6", `Schreiben ausserhalb des eigenen Homes (${opts.homeRoot}) verweigert`,
      a6.ok ? a6.output.trim().slice(0, 100) : `bash -> ${a6.status}`);

    // A11: ist das Arbeitsverzeichnis der Mandant selbst — oder `/tmp`?
    //
    // Diese Zeile fehlte, und genau dort sass der Defekt. `bwrap --chdir
    // /home/<name>` setzt das Verzeichnis des Prozesses; die SDK-CLI fasst es
    // danach wieder an: `maybeAutoChdir` (`src/cli/startup-cwd.ts:11-42`)
    // behandelt "startet im Home" als "der Benutzer wollte ein Projekt" und
    // zieht nach `<home>/tmp`, `/tmp` oder `/var/tmp` um. Gemessen am
    // 2026-11-08 an der CLI ohne `bwrap`: mit `--allow-home` bleibt das cwd
    // `/tmp/ti-iso/clihome`, ohne das Flag ist es `/tmp` — im selben Aufruf,
    // nur ein Argument Unterschied.
    //
    // Ein Mandant, dessen Arbeitsverzeichnis `/tmp` ist, verliert seine Dateien
    // beim Abraeumen des Workers und teilt sich ein welt-beschreibbares
    // Verzeichnis mit jedem anderen Prozess derselben Namespace. Deshalb wird
    // hier nicht `bwrap --chdir` geglaubt, sondern **im** Worker gemessen —
    // und zwar dreifach, weil `$PWD` eine Behauptung der Shell ist, `pwd -P`
    // eine Abfrage des Kernels und `readlink /proc/self/cwd` die direkte.
    // Eine Zeile, die nur `$PWD` liest, waere gruen, wenn die Shell luegt.
    const guestHomeOfTenant = `/home/${opts.tenant}`;
    const a7 = await tenantShell(opts, alpha.cookie, sessionId,
      'echo "readlink=$(readlink /proc/self/cwd)"'
      + '; echo "binpwd=$(/bin/pwd -P)"'
      + '; echo "pwdvar=$PWD"');
    const read = (key) => new RegExp(`${key}=([^\\n]*)`).exec(a7.output)?.[1]?.trim() ?? null;
    const realCwd = read("readlink");
    const binPwd = read("binpwd");
    const pwdVar = read("pwdvar");
    // Drei Aussagen, alle noetig:
    //   1. das echte cwd ist das Gast-Home des Mandanten (nicht `/tmp`, nicht
    //      das Home des Hostbenutzers),
    //   2. `pwd -P` stimmt damit ueberein (kein Symlink-Trick),
    //   3. `$PWD` sagt dasselbe (die Umgebung luegt nicht — der urspruengliche
    //      Befund war `PWD=/tmp` bei richtigem cwd; das ist ein eigener Fehler).
    const cwdOk = realCwd === guestHomeOfTenant
      && binPwd === guestHomeOfTenant
      && pwdVar === guestHomeOfTenant;
    (a7.ok && cwdOk ? pass : fail)("A11", `Arbeitsverzeichnis des Workers ist ${guestHomeOfTenant}`,
      a7.ok
        ? `readlink /proc/self/cwd=${JSON.stringify(realCwd)}, /bin/pwd -P=${JSON.stringify(binPwd)}, $PWD=${JSON.stringify(pwdVar)}`
          + (cwdOk ? "" : realCwd === "/tmp" || realCwd === "/var/tmp"
            ? " — die SDK-CLI ist aus dem Home nach /tmp umgezogen (maybeAutoChdir ohne --allow-home)"
            : realCwd !== guestHomeOfTenant
              ? " — das echte cwd ist nicht das Gast-Home des Mandanten"
              : " — das cwd stimmt, aber $PWD behauptet etwas anderes (die Umgebung luegt)")
        : `bash -> ${a7.status}`);

    // A12: kann sich der Mandant mit einer selbst geschriebenen Kopfzeile eine
    // Datei-Wurzel verschaffen?
    //
    // Das ist der Befund, den die Fertigstellung des Branches aufgedeckt hat,
    // und er war ausnutzbar: das Archiv des Kontos liegt in **seinem** Home
    // (0700, aber von seiner eigenen Bash beschreibbar). Eine Datei darin,
    // deren zweite Zeile `{"type":"session","cwd":"/"}` ist, trug ihren `cwd`
    // ungefiltert in `getAllowedFileRoots` — gemessen antwortete danach
    // `GET /api/files/etc/passwd?type=read` mit **200**, und dieselbe Route
    // gab die 44-Byte-Datei `omp-web-session-key` heraus (Admin-Cookies).
    //
    // Die Zeile schreibt den Kopfzeilen-Angriff in das **eigene** Archiv und
    // prueft danach beides: die Wurzel ist nicht da, und die Datei bleibt
    // verschlossen. Ein Test, der nur die Session-Liste prueft, waere zu
    // schwach — der Schaden entsteht in `getAllowedFileRoots`.
    const forgedId = "01a1bbf1-0000-4000-8000-00000000dead";
    const forgedName = `--a12-forged--/${forgedId}.jsonl`;
    const forgedWrite = await tenantShell(opts, alpha.cookie, sessionId,
      `mkdir -p "$HOME/.omp/agent/sessions/--a12-forged--"`
      + ` && printf '%s\\n' '{"type":"session","version":3,"id":"${forgedId}","timestamp":"2026-11-08T16:00:00.000Z","cwd":"/"}'`
      + ` > "$HOME/.omp/agent/sessions/${forgedName}"`
      + ` && echo WROTE || echo DENIED`);
    if (!/WROTE/.test(forgedWrite.output)) {
      // Kann der Mandant sein eigenes Archiv nicht beschreiben, ist der Angriff
      // nicht durchfuehrbar — das ist keine offene Zeile, sondern eine
      // staerkere Lage. Gemeldet wird sie trotzdem, damit sie sichtbar bleibt.
      na("A12", "Selbst geschriebene Kopfzeile verschafft keine Wurzel",
        `Archiv nicht schreibbar: ${forgedWrite.output.trim().slice(0, 90)}`);
    } else {
      // Der Wurzel-Cache haelt 5 s (lib/file-access.ts:16); ohne diese Pause
      // prueft die Zeile den Stand von vor dem Angriff.
      await new Promise((r) => setTimeout(r, 6_000));
      const probes = ["/etc/passwd", "/proc/self/environ"];
      const results = [];
      for (const target of probes) {
        const res = await request(opts, `/api/files${target}?type=read`, {}, alpha.cookie);
        results.push({ target, status: res.status });
      }
      const leaked = results.filter((r) => r.status === 200);
      (leaked.length === 0 ? pass : fail)(
        "A12", "Selbst geschriebene Kopfzeile verschafft keine Wurzel",
        `Kopfzeile mit cwd=/ geschrieben, /api/files -> ${results.map((r) => `${r.target}=${r.status}`).join(", ")}`
        + (leaked.length > 0 ? " — AUSBRUCH: der gefaelschte cwd wurde zur Datei-Wurzel" : "")
        + ` (Datei: ${forgedName})`,
      );
    }

    // A10: erreicht A die Dateien der anderen Konten? Gemessen wird dort, wo
    // B's Archiv WIRKLICH liegt — im Home, sonst im Dienstverzeichnis. Ein
    // `find` ueber ein leeres Home waere gruen, ohne etwas zu sagen.
    const foreignRoot = peerHomeArchives.length > 0 ? peerHome : (opts.serviceAgentDir ?? peerHome);
    const a10 = await tenantShell(opts, alpha.cookie, sessionId,
      `find ${foreignRoot} -type f -readable 2>/dev/null | wc -l`);
    const foreignReadable = Number(a10.output.trim());
    optOutEvidence.foreignFilesReadable = a10.ok ? foreignReadable : null;
    (a10.ok && foreignReadable === 0 ? pass : fail)(
      "A10", "Keine lesbare Datei im Bereich des anderen Kontos",
      a10.ok ? `${Number.isNaN(foreignReadable) ? a10.output.trim().slice(0, 60) : foreignReadable} fremde lesbare Datei(en) unter ${foreignRoot}`
        : `bash -> ${a10.status}`,
    );
  }

  // --- 5 / 6 ---------------------------------------------------------------
  if (opts.mode === "fail-closed") {
    const started = agentRes.status === 200 && sessionId !== null;
    // Der Status ist Teil der Aussage, nicht nur "nicht 200": ein fehlendes
    // bwrap ist ein Zustand des Hosts (503, "kommt wieder, sobald jemand es
    // installiert"), kein Serverfehler (500, "der Code ist kaputt"). Beide
    // Ziffern machen die Zeile rot, weil ein Betreiber sonst im Log sucht,
    // obwohl der Grund im Koerper steht.
    const boundary503 = !started && agentRes.status === 503;
    (boundary503 ? pass : fail)("5a", "Agent-Request scheitert mit 503 bei fehlendem bwrap",
      `POST /api/agent/new -> ${agentRes.status}${started ? " (Session angelegt)" : ""}`
      + (agentRes.status === 503 ? "" : ` — erwartet 503, nicht ${agentRes.status}`));
    const reason = agentRes.json?.reason ?? null;
    (reason ? pass : fail)("5b", "Fehlerkoerper nennt einen `reason`",
      reason === null ? `kein reason; Body ${(agentRes.text ?? "").slice(0, 120)}` : JSON.stringify(reason).slice(0, 120));
    const remediation = agentRes.json?.remediation ?? null;
    (remediation ? pass : fail)("5c", "Fehlerkoerper nennt eine `remediation`",
      remediation === null ? "kein remediation" : JSON.stringify(remediation).slice(0, 120));
    // Nur Worker, die zu **diesem** Server gehoeren: ihr argv bindet die
    // Home-Wurzel dieses Laufs. Ohne diese Einschraenkung zaehlt die Zeile die
    // Worker eines zweiten Scratch-Servers auf demselben Host mit und wird rot,
    // obwohl dieser Server keinen einzigen gestartet hat (gemessen: 2 fremde
    // Worker, 5d rot). Das ist ein Fehler der Zeile, nicht des Codes.
    const after = workersFor(opts.tenant, rpcProcesses() ?? [])
      .filter(({ argv }) => argv.some((value) => value.includes(opts.homeRoot))).length;
    (after === 0 ? pass : fail)("5d", "Kein ungesandboxter Mandanten-Worker entsteht",
      `${after} Worker fuer ${opts.tenant}`);
  }

  if (opts.mode === "opt-out") {
    const started = agentRes.status === 200 && sessionId !== null;
    // 6a allein beweist nichts: auf einem Stand ohne jede Grenze startet die
    // Session ohnehin. Aussagekraeftig wird die Zeile nur zusammen mit 6b
    // (die Meldung nennt den Ausstieg) und mit `--mode fail-closed`, das zeigt,
    // dass ohne den Ausstieg eben *nicht* gestartet wird.
    (started ? pass : fail)("6a", "OMP_WEB_ALLOW_UNSANDBOXED_TENANT=1 laesst die Session starten",
      `POST /api/agent/new -> ${agentRes.status}`
      + (started ? " (nur aussagekraeftig zusammen mit 6b und --mode fail-closed)" : ""));

    // 6c: der Ausstieg muss **wirken**, nicht bloss gesetzt sein.
    //
    // Ohne diese Zeile waere der Modus auch dann gruen, wenn der Code den
    // Schalter ignoriert: 6a wuerde starten (weil die Grenze ohnehin nicht
    // greift) und 6b wuerde die Zeile finden (weil sie aus dem Flag kommt).
    // Beides zusammen bewiese nur, dass jemand das Flag setzt — nicht, dass es
    // die Grenze abschaltet. Gemessen wird deshalb das Gegenteil der A-Zeilen:
    // das fremde Konto **muss** sichtbar sein, wenn die Grenze aus ist.
    const { foreignAccountVisible, peerArchiveReadable, sessionKeyReadable, foreignFilesReadable } = optOutEvidence;
    const effectObserved = foreignAccountVisible === true
      && peerArchiveReadable === true
      && foreignFilesReadable !== null && foreignFilesReadable > 0;
    (effectObserved ? pass : fail)("6c", "Der Ausstieg schaltet die Grenze wirklich ab",
      `fremdes Konto sichtbar=${foreignAccountVisible}, fremdes Archiv lesbar=${peerArchiveReadable}, `
      + `Session-Key lesbar=${sessionKeyReadable}, fremde lesbare Dateien=${foreignFilesReadable}`
      + (effectObserved ? "" : " — das Flag zeigt keine Wirkung; die Grenze steht also entweder noch oder war nie da"));

    // 6b: Die Zeile muss der Server **selbst** schreiben, auf stderr, beim
    // Start. Es gibt keine eigene Log-Variable dafuer und soll keine geben —
    // eine Variable, die nur der Test setzt, beweist nichts ueber den Betrieb.
    // Gelesen wird deshalb der abgefangene stderr des Laufs unter Test
    // (`--server-log <datei>`, typisch `2> server.stderr`).
    // Kein Log uebergeben -> SKIP. Log uebergeben, Zeile fehlt -> FAIL.
    if (opts.serverLog === null) {
      skip("6b", "Server meldet den Ausstieg auf stderr",
        "kein --server-log uebergeben (z.B. --server-log /tmp/ti/server.stderr)");
    } else if (!existsSync(opts.serverLog)) {
      fail("6b", "Server meldet den Ausstieg auf stderr", `${opts.serverLog} existiert nicht`);
    } else {
      const text = readFileSync(opts.serverLog, "utf8");
      // Gesucht wird die Ausstiegsmeldung. Sie muss **beim Start** entstehen und
      // deshalb zwei Dinge sagen: den Variablennamen und dass Mandanten-Sessions
      // ohne Grenze laufen. Den **Mandantennamen** kann sie nicht nennen — beim
      // Start ist noch kein Konto angemeldet, und eine Zeile pro Konto waere
      // genau das Rauschen, das die eine wichtige Zeile verdeckt.
      //
      // Die fruehere Fassung verlangte den Mandantennamen in derselben Zeile und
      // war damit nicht erfuellbar (gemessen am 2026-11-08: die Meldung stand
      // korrekt auf stderr, die Zeile blieb rot). Das war die Zeile falsch, nicht
      // der Code.
      const lines = text.split("\n");
      const named = lines.filter((entry) => /OMP_WEB_ALLOW_UNSANDBOXED_TENANT/.test(entry));
      const unconfined = named.filter((entry) =>
        /(UNSANDBOX|unsandbox|ohne (Sandbox|Grenze)|unconfined|Mandanten-Sessions)/i.test(entry));
      const line = unconfined[0] ?? null;
      (line !== null ? pass : fail)("6b", "Server meldet den Ausstieg auf stderr",
        line !== null
          ? line.trim().slice(0, 200)
          : `${opts.serverLog}: ${named.length} Zeile(n) mit OMP_WEB_ALLOW_UNSANDBOXED_TENANT, `
            + `davon ${unconfined.length} mit der Aussage "Mandanten-Sessions ohne Grenze"`
            + (text.length === 0 ? " (Datei leer)" : ""));
    }
  }

  return finish(opts, cleanup, rpcBaseline, accountsFile, accountsFileExisted);
}

// ---------------------------------------------------------------------------
// Aufraeumen + Bericht
// ---------------------------------------------------------------------------

function finish(opts, cleanup, rpcBaseline, accountsFile, accountsFileExisted) {
  // Eigenes aufraeumen: die Homes, die dieser Lauf angelegt hat, und die
  // Kontendatei, wenn es sie vorher nicht gab. Prozesse werden nicht
  // abgeschossen — der Server gehoert dem Aufrufer.
  for (const home of cleanup.createdHomes) {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* reported by the count below */ }
  }
  let storeRemoved = false;
  if (cleanup.seededAccountsFile && accountsFile !== null && !accountsFileExisted && existsSync(accountsFile)) {
    try { rmSync(accountsFile, { force: true }); storeRemoved = true; } catch { /* reported */ }
  }
  const leftoverHomes = cleanup.createdHomes.filter((home) => existsSync(home)).length;
  const after = rpcProcesses()?.length ?? null;
  const delta = rpcBaseline === null || after === null ? null : after - rpcBaseline;

  const failures = rows.filter((r) => r.status === "FAIL");
  const skips = rows.filter((r) => r.status === "SKIP");
  const unmeasured = rows.filter((r) => r.status === "N/A");
  const passed = rows.length - failures.length - skips.length - unmeasured.length;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      mode: opts.mode,
      baseUrl: opts.baseUrl,
      homeRoot: opts.homeRoot,
      rows,
      summary: {
        pass: passed,
        fail: failures.length,
        skip: skips.length,
        notMeasuredInThisMode: unmeasured.length,
        incomplete: skips.length > 0,
      },
      cleanup: {
        homesRemoved: cleanup.createdHomes.length - leftoverHomes,
        homesLeftover: leftoverHomes,
        accountsStoreRemoved: storeRemoved,
        rpcProcessesBefore: rpcBaseline,
        rpcProcessesAfter: after,
        rpcDelta: delta,
      },
    }, null, 2)}\n`);
  } else {
    const idWidth = Math.max(3, ...rows.map((r) => r.id.length));
    process.stdout.write(`${"id".padEnd(idWidth)}  ${"status"}  claim -> observed\n`);
    process.stdout.write(`${"-".repeat(idWidth)}  ${"-".repeat(6)}  ${"-".repeat(70)}\n`);
    for (const r of rows) {
      process.stdout.write(`${r.id.padEnd(idWidth)}  ${r.status.padEnd(6)}  ${r.claim}\n`);
      process.stdout.write(`${" ".repeat(idWidth)}  ${" ".repeat(6)}  -> ${r.observed}\n`);
    }
    note("\n");
    process.stdout.write(`cleanup: homes removed ${cleanup.createdHomes.length - leftoverHomes}`
      + `${leftoverHomes ? ` (${leftoverHomes} LEFT OVER)` : ""}`
      + `, accounts store ${storeRemoved || !cleanup.seededAccountsFile ? "untouched" : "kept"}\n`);
    process.stdout.write(`cleanup: rpc processes ${rpcBaseline} -> ${after}`
      + `${delta === null ? "" : ` (delta ${delta})`} = \`pgrep -fc 'mode rpc'\` equivalent\n`);
    process.stdout.write(`${passed} PASS, ${failures.length} FAIL, ${skips.length} SKIP`
      + (unmeasured.length ? `, ${unmeasured.length} N/A (in diesem Modus nicht gemessen)` : ""));
    process.stdout.write(skips.length > 0 ? "\nINCOMPLETE\n" : "\n");
  }

  process.exit(failures.length > 0 || skips.length > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`harness error: ${error?.stack ?? error}\n`);
  process.exit(1);
});
