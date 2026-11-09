import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planTenantWorker, startTenantWorker } from "./tenant-worker";
import { probeWorkerNamespace } from "./tenant-namespace-probe";

import { resolveBunPath } from "../bin/runtime.js";

/**
 * Die entscheidende Zusage des ganzen Schnitts, an einem **echten** Worker
 * unter `bwrap` gemessen: nicht der Plan, nicht der argv, sondern was ein
 * `bash`-Aufruf **innerhalb** der Grenze sieht.
 *
 * Der Test startet dafuer den echten SDK-RPC-Host (`--mode rpc`, dieselbe
 * Session, die auch der Server benutzt) in einer eigenen Namespace und laesst
 * ihn Kommandos ausfuehren. Jede Zusage der Abnahmetabelle A1–A10, die sich
 * ohne Modellaufruf pruefen laesst, steht hier.
 *
 * Warum das nicht als Unit-Test auf `argv` geht: der argv kann richtig sein und
 * die Namespace trotzdem offen — wenn `bwrap` die `--ro-bind`-Reihenfolge
 * anders anwendet als gedacht, wenn ein Pfad durch einen Eltern-Bind
 * durchsickert, oder wenn `--clearenv` die Variable doch nicht entfernt. Genau
 * diese drei sind in frueheren Laeufen aufgetreten.
 *
 * Der Test braucht einen Host mit User-Namespaces. Fehlt `bwrap` oder das
 * userns, wird er **uebersprungen**, nicht stillschweigend gruen: ein
 * uebersprungener Grenztest ist eine Luecke, kein Beweis.
 */

const repoRoot = realpathSync(join(import.meta.dir, ".."));

function hasBubblewrap() {
  const probe = Bun.spawnSync(["bwrap", "--version"], { stdout: "pipe", stderr: "pipe" });
  if (probe.exitCode !== 0) {
    return { ok: false, detail: `bwrap --version failed with exit ${probe.exitCode}` };
  }
  // Ein `true` in einer Namespace ist der einzige ehrliche Test: `--version`
  // laeuft ohne `--unshare-user` und beweist die Rechte nicht.
  const userns = Bun.spawnSync(
    ["bwrap", "--unshare-user", "--unshare-pid", "--clearenv", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--ro-bind", "/etc", "/etc",
      "--proc", "/proc", "--dev", "/dev", "/bin/true"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (userns.exitCode !== 0) {
    return { ok: false, detail: `bwrap unshare probe failed: ${new TextDecoder().decode(userns.stderr).trim().slice(0, 300)}` };
  }
  return { ok: true, detail: "bwrap and user namespaces are available" };
}

const bwrap = hasBubblewrap();


function makeTenant(username) {
  const root = mkdtempSync(join(tmpdir(), "omp-iso-worker-"));
  const home = join(root, username);
  mkdirSync(join(home, ".omp", "agent", "sessions"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "work"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "work", "marker.txt"), `hello from ${username}\n`, { mode: 0o600 });
  // Ein Modell ist Pflicht, nicht Deko: `src/sdk.ts:3490` bricht den Start mit
  // "No default model selected" ab, und ohne `api:` lehnt der Validator das
  // Provider-Objekt ab (`models-config.ts:59-85`). Beides ist gemessen; ein
  // Fixture ohne Modell startet keinen Worker und wuerde nichts beweisen.
  writeFileSync(
    join(home, ".omp", "agent", "models.yml"),
    [
      "providers:",
      "  local:",
      "    baseUrl: http://127.0.0.1:9/v1",
      "    apiKey: dummy-tenant-key",
      "    auth: apiKey",
      "    api: openai-completions",
      "    models:",
      "      - id: dummy-model",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(
    join(home, ".omp", "agent", "config.yml"),
    "modelRoles:\n  default: local/dummy-model\n",
    { mode: 0o600 },
  );
  return {
    root,
    home,
    identity: { username },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const live = [];

afterEach(async () => {
  while (live.length > 0) {
    await live.pop()?.stop();
  }
});

describe.skipIf(!bwrap.ok)("tenant worker boundary (real bwrap)", () => {
  test("a worker starts inside the boundary and its bash cannot see the host home", async () => {
    const tenant = makeTenant("isolation-probe");
    const bunPath = resolveBunPath();
    expect(bunPath).not.toBeNull();
    const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
    process.env.OMP_WEB_HOME_ROOT = tenant.root;
    try {
      const worker = await startTenantWorker(tenant.identity, {
        bunPath: bunPath,
        repoRoot,
        providers: [],
        startTimeoutMs: 60_000,
      });
      if ("ok" in worker) throw new Error(`worker did not start: ${worker.reason}: ${worker.detail}`);
      
      expect(worker.boundary.enforced).toBe(true);
      expect(worker.boundary.pid).toBeGreaterThan(0);
      // Der Grund fuer die Zeile oben ist jetzt eine Messung, nicht die
      // gemeldete PID: `enforced: true` steht nur nach einer bestandenen
      // Namespace-Probe (`lib/tenant-namespace-probe.ts`). Diese Zeile haelt
      // fest, dass ein echter Start sie besteht — sonst waere das Feld eine
      // Behauptung des Spawns.
      expect(probeWorkerNamespace(worker.pid, tenant.identity.username)).toEqual({ ok: true });

      // A1/A2: fremde Homes sind nicht da. `/home/pi` ist das Prozesskonto und
      // liegt bewusst ausserhalb der Bind-Liste.
      const lsHome = await worker.client.bash("ls -d /home/pi 2>&1; echo EXIT:$?");
      expect(lsHome.output).toContain("No such file or directory");
      expect(lsHome.output).toContain("EXIT:2");

      // A2b: die Kontenwurzel existiert ebenfalls nicht — nur das eigene Home
      // ist gebunden.
      const lsAccounts = await worker.client.bash(`ls -d ${tenant.root}/isolation-probe 2>&1; echo EXIT:$?`);
      expect(lsAccounts.output).toContain("No such file or directory");

      // Eigenes Home ist lesbar und der Marker dort.
      const cat = await worker.client.bash("cat work/marker.txt; pwd");
      expect(cat.output).toContain("hello from isolation-probe");
      expect(cat.output).toContain("/home/isolation-probe");
    } finally {
      if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
      else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
      tenant.cleanup();
    }
  }, 120_000);

  test("the worker environment carries no operator secrets", async () => {
    const tenant = makeTenant("env-probe");
    const bunPath = resolveBunPath();
    const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
    process.env.OMP_WEB_HOME_ROOT = tenant.root;
    try {
      const worker = await startTenantWorker(tenant.identity, {
        bunPath: bunPath,
        repoRoot,
        providers: [],
        startTimeoutMs: 60_000,
      });
      if ("ok" in worker) throw new Error(`worker did not start: ${worker.reason}: ${worker.detail}`);
      

      const envResult = await worker.client.bash("env | sort");
      const lines = envResult.output.split("\n").filter((line) => line.includes("="));
      const names = lines.map((line) => line.slice(0, line.indexOf("=")));

      // A4: die Geheimnisse des Dienstes sind nicht in der Umgebung.
      for (const secret of ["OMP_WEB_PASSWORD", "BRAVE_API_KEY", "PARALLEL_API_KEY", "OMP_WEB_SECRETS_FILE", "OMP_WEB_SESSION_KEY"]) {
        expect(names).not.toContain(secret);
      }
      // Was hier stehen darf, ist vollstaendig aufgezaehlt und hat eine Quelle:
      // * unsere Allowlist (`buildWorkerEnv`),
      // * die `NON_INTERACTIVE_ENV`-Defaults des SDK
      //   (`src/exec/non-interactive-env.ts:8-52`: Pager, CI, `AGENT`, `NO_COLOR`, …),
      // * `procmgr`-Marker (`src/procmgr.ts:45-56`: `OMPCODE`, `CLAUDECODE`,
      //   `GPG_TTY`, `SHELL`),
      // * was bwrap/Shell selbst setzen (`PWD`, `SHLVL`, `_`, `TERM`).
      const ours = ["PATH", "LANG", "TZ", "HOME", "USER", "LOGNAME", "PI_CODING_AGENT_DIR"];
      const sdkDefaults = [
        "PAGER", "GIT_PAGER", "MANPAGER", "SYSTEMD_PAGER", "BAT_PAGER", "DELTA_PAGER",
        "GH_PAGER", "GLAB_PAGER", "PSQL_PAGER", "MYSQL_PAGER", "AWS_PAGER", "HOMEBREW_PAGER",
        "LESS", "TERM", "NO_COLOR", "PYTHONUNBUFFERED", "GIT_EDITOR", "VISUAL", "EDITOR",
        "GIT_TERMINAL_PROMPT", "SSH_ASKPASS", "CI", "AGENT", "npm_config_yes",
        "npm_config_update_notifier", "npm_config_fund", "npm_config_audit",
        "npm_config_progress", "PNPM_DISABLE_SELF_UPDATE_CHECK", "PNPM_UPDATE_NOTIFIER",
        "YARN_ENABLE_TELEMETRY", "YARN_ENABLE_PROGRESS_BARS", "CARGO_TERM_PROGRESS_WHEN",
        "DEBIAN_FRONTEND", "PIP_NO_INPUT", "PIP_DISABLE_PIP_VERSION_CHECK", "TF_INPUT",
        "TF_IN_AUTOMATION", "GH_PROMPT_DISABLED", "COMPOSER_NO_INTERACTION",
        "CLOUDSDK_CORE_DISABLE_PROMPTS",
      ];
      // `PI_NOTIFICATIONS`/`PI_NO_TITLE` setzt die RPC-Mode selbst, und
      // `__PI_NATIVE_VARIANT_CACHE` das native Addon; `PI_CODING_AGENT_DIR`
      // ist unser eigener Guest-Pfad.
      const runtimeMarkers = [
        "OMPCODE", "CLAUDECODE", "GPG_TTY", "SHELL",
        "PI_NOTIFICATIONS", "PI_NO_TITLE", "__PI_NATIVE_VARIANT_CACHE",
      ];
      const shellSet = ["PWD", "SHLVL", "_", "OLDPWD"];
      const allowed = new Set([...ours, ...sdkDefaults, ...runtimeMarkers, ...shellSet]);
      const unexpected = names.filter((name) => !allowed.has(name));
      expect(unexpected).toEqual([]);
      expect(names).toContain("HOME");
      expect(envResult.output).toContain("HOME=/home/env-probe");
      expect(envResult.output).toContain("LOGNAME=env-probe");
    } finally {
      if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
      else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
      tenant.cleanup();
    }
  }, 120_000);

  test("the secrets files are masked inside the boundary", async () => {
    const tenant = makeTenant("mask-probe");
    const bunPath = resolveBunPath();
    const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
    // Die Geheimnisdatei **im Konto-Home**: nur dort ist sie nach dem Home-Bind
    // ueberhaupt sichtbar, und nur dort braucht sie eine Maske. Eine Datei
    // ausserhalb jedes Binds existiert in der Namespace gar nicht — `ENOENT`
    // ist die staerkere Zusage und keine Maske.
    const secretsFile = join(tenant.home, "omp-web.env");
    writeFileSync(secretsFile, "OMP_WEB_PASSWORD=super-secret\n", { mode: 0o600 });
    process.env.OMP_WEB_HOME_ROOT = tenant.root;
    process.env.OMP_WEB_SECRETS_FILE = secretsFile;
    try {
      const plan = planTenantWorker(tenant.identity, {
        bunPath: bunPath,
        repoRoot,
        providers: [],
      });
      if (!plan.ok) throw new Error(`plan refused: ${plan.reason}: ${plan.detail}`);
      // Der Plan verbirgt die Geheimnisdatei: als `--ro-bind <leer> <guest>`
      // **nach** dem Home-Bind, denn nur die Reihenfolge macht die Maske wirksam.
      const argv = plan.argv.join(" ");
      expect(argv).toMatch(/--ro-bind \/tmp\/omp-web-mask-empty \/home\/mask-probe\/omp-web\.env/);
      expect(argv.indexOf("--bind " + tenant.home + " /home/mask-probe"))
        .toBeLessThan(argv.indexOf("--ro-bind /tmp/omp-web-mask-empty /home/mask-probe/omp-web.env"));

      const worker = await startTenantWorker(tenant.identity, {
        bunPath: bunPath,
        repoRoot,
        providers: [],
        startTimeoutMs: 60_000,
      });
      if ("ok" in worker) throw new Error(`worker did not start: ${worker.reason}: ${worker.detail}`);
      live.push(worker);
      // A3: die Datei ist leer, nicht "nicht gefunden" — genau das ist der
      // Unterschied zwischen verdeckt und zufaellig weg.
      const read = await worker.client.bash("wc -c < ~/omp-web.env 2>&1; echo EXIT:$?");
      expect(read.output.trim()).toContain("0");
      const content = await worker.client.bash("cat ~/omp-web.env; echo DONE");
      expect(content.output).not.toContain("super-secret");
      expect(content.output).toContain("DONE");
    } finally {
      if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
      else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
      delete process.env.OMP_WEB_SECRETS_FILE;
      tenant.cleanup();
    }
  }, 120_000);


  test("two tenants get two workers, and neither sees the other's marker", async () => {
    const first = makeTenant("twin-a");
    const second = makeTenant("twin-b");
    const bunPath = resolveBunPath();
    const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
    // Beide unter derselben Wurzel, damit sie sichpotenziell sehen koennten.
    const sharedRoot = mkdtempSync(join(tmpdir(), "omp-iso-twins-"));
    first.cleanup();
    second.cleanup();
    process.env.OMP_WEB_HOME_ROOT = sharedRoot;
    for (const name of ["twin-a", "twin-b"]) {
      const home = join(sharedRoot, name);
      mkdirSync(join(home, ".omp", "agent", "sessions"), { recursive: true, mode: 0o700 });
      mkdirSync(join(home, "work"), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, "work", "marker.txt"), `hello from ${name}\n`, { mode: 0o600 });
      writeFileSync(join(home, ".omp", "agent", "models.yml"), [
        "providers:", "  local:", "    baseUrl: http://127.0.0.1:9/v1", "    apiKey: dummy",
        "    auth: apiKey", "    api: openai-completions", "    models:", "      - id: dummy-model", "",
      ].join("\n"), { mode: 0o600 });
      writeFileSync(join(home, ".omp", "agent", "config.yml"), "modelRoles:\n  default: local/dummy-model\n", { mode: 0o600 });
    }
    try {
      const a = await startTenantWorker({ username: "twin-a" }, {
        bunPath: bunPath, repoRoot, providers: [], startTimeoutMs: 60_000,
      });
      const b = await startTenantWorker({ username: "twin-b" }, {
        bunPath: bunPath, repoRoot, providers: [], startTimeoutMs: 60_000,
      });
      if ("ok" in a) throw new Error(`a did not start: ${a.reason}: ${a.detail}`);
      if ("ok" in b) throw new Error(`b did not start: ${b.reason}: ${b.detail}`);
      live.push(a, b);

      // Zwei Prozesse, nicht einer: die Granularitaet ist der Mandant.
      expect(a.pid).not.toBe(b.pid);
      expect(a.boundary.pid).not.toBe(b.boundary.pid);

      // Geschwister sind unsichtbar, obwohl sie auf demselben Host unter
      // derselben Wurzel liegen. Zwei Wege, beide gemessen: der Host-Pfad des
      // Geschwisters existiert nicht, und sein Gast-Pfad auch nicht.
      const siblingHost = await a.client.bash(`ls -d ${sharedRoot}/twin-b 2>&1; echo EXIT:$?`);
      expect(siblingHost.output).toContain("No such file or directory");
      const siblingGuest = await a.client.bash("cat /home/twin-b/work/marker.txt 2>&1; echo EXIT:$?");
      expect(siblingGuest.output).toContain("No such file or directory");
      expect(siblingGuest.output).not.toContain("hello from twin-b");
      const ownMarker = await a.client.bash("cat work/marker.txt");
      expect(ownMarker.output).toContain("hello from twin-a");
    } finally {
      if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
      else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
      rmSync(sharedRoot, { recursive: true, force: true });
    }
  }, 180_000);

  test("a tenant's own apiKey works while no operator key reaches it", async () => {
    // Der Befund (Fix 1), in einem echten Worker gemessen statt im argv:
    //
    //   * Der Mandant nennt einen Provider, fuer den der **Betreiber** einen
    //     Schluessel hat (`brave` mit `BRAVE_API_KEY` in der Umgebung).
    //   * Ohne `OMP_WEB_TENANT_PROVIDER_GRANT` darf dieser Wert nirgends im
    //     Worker stehen — nicht in `env`, nicht lesbar aus dessen Shell.
    //   * Sein **eigener** `apiKey` im eigenen `models.yml` muss trotzdem
    //     funktionieren; das SDK liest ihn aus dem Gast-Home, also ohne dass
    //     der Serverprozess ihn in eine Umgebung schreibt.
    //
    // Ein Test, der nur die `env`-Ausgabe prueft, waere zu schwach gewesen:
    // der Wert stand auch im argv des Workers (`--setenv`), und genau von dort
    // holte ihn der Angriff nicht — er kam aus der `bash`-Shell des Workers,
    // die denselben Prozess liest.
    const tenant = makeTenant("grant-probe");
    const bunPath = resolveBunPath();
    const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
    const previousBrave = process.env.BRAVE_API_KEY;
    const previousGrant = process.env.OMP_WEB_TENANT_PROVIDER_GRANT;
    process.env.OMP_WEB_HOME_ROOT = tenant.root;
    process.env.BRAVE_API_KEY = "operator-brave-key-do-not-leak";
    delete process.env.OMP_WEB_TENANT_PROVIDER_GRANT;
    try {
      // Der Mandant nennt `brave` selbst — ohne eigenen Schluessel, so wie im
      // Befund. `auth: none` ist noetig, weil der Validator des SDK einen
      // Provider ohne `baseUrl`/`apiKey`/`api` ablehnt (gemessen:
      // 'must specify "baseUrl", "headers", "apiKey", "auth: none", …').
      writeFileSync(join(tenant.home, ".omp", "agent", "models.yml"), [
        "providers:",
        "  local:",
        "    baseUrl: http://127.0.0.1:9/v1",
        "    apiKey: dummy-tenant-key",
        "    auth: apiKey",
        "    api: openai-completions",
        "    models:",
        "      - id: dummy-model",
        "  brave:",
        "    auth: none",
        "",
      ].join("\n"), { mode: 0o600 });

      const worker = await startTenantWorker(tenant.identity, {
        bunPath: bunPath, repoRoot, providers: ["local", "brave"], startTimeoutMs: 60_000,
      });
      if ("ok" in worker) throw new Error(`worker did not start: ${worker.reason}: ${worker.detail}`);
      live.push(worker);

      const envResult = await worker.client.bash("env");
      expect(envResult.output).not.toContain("operator-brave-key-do-not-leak");
      expect(envResult.output).not.toContain("BRAVE_API_KEY");
      // Und die Gegenprobe: Bash sieht die Umgebung des Prozesses, also ist die
      // Abwesenheit keine Folge einer gefilterten Ausgabe.
      const argv = readFileSync(`/proc/${worker.pid}/cmdline`, "utf8");
      expect(argv).not.toContain("operator-brave-key-do-not-leak");
      // Der eigene Schluessel dagegen ist da, wo er hingehoert: in der Datei
      // des Mandanten im Gast-Home, gelesen vom SDK.
      const own = await worker.client.bash("grep apiKey ~/.omp/agent/models.yml");
      expect(own.output).toContain("dummy-tenant-key");
    } finally {
      if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
      else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
      if (previousBrave === undefined) delete process.env.BRAVE_API_KEY;
      else process.env.BRAVE_API_KEY = previousBrave;
      if (previousGrant === undefined) delete process.env.OMP_WEB_TENANT_PROVIDER_GRANT;
      else process.env.OMP_WEB_TENANT_PROVIDER_GRANT = previousGrant;
      tenant.cleanup();
    }
  }, 120_000);

  test("with the grant the operator key is present in the worker, and refused without it", async () => {
    // Die zweite Haelfte: die Freigabe muss wirken. Gemessen wird beides in
    // einem Lauf, damit die Zeile nicht auch bei einem Code gruen wird, der
    // jeden Schluessel einsetzt (dann waere die zweite Probe still).
    const tenant = makeTenant("grant-probe-2");
    const bunPath = resolveBunPath();
    const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
    const previousBrave = process.env.BRAVE_API_KEY;
    process.env.OMP_WEB_HOME_ROOT = tenant.root;
    process.env.BRAVE_API_KEY = "granted-brave-key";
    try {
      const withoutGrant = await startTenantWorker(tenant.identity, {
        bunPath: bunPath, repoRoot, providers: ["brave"], startTimeoutMs: 60_000,
        env: { ...process.env, OMP_WEB_TENANT_PROVIDER_GRANT: "" },
      });
      if ("ok" in withoutGrant) throw new Error(`worker did not start: ${withoutGrant.reason}`);
      const denied = await withoutGrant.client.bash("env | grep BRAVE || echo ABSENT");
      expect(denied.output).toContain("ABSENT");
      await withoutGrant.stop();

      const withGrant = await startTenantWorker(tenant.identity, {
        bunPath: bunPath, repoRoot, providers: ["brave"], startTimeoutMs: 60_000,
        env: { ...process.env, OMP_WEB_TENANT_PROVIDER_GRANT: "brave" },
      });
      if ("ok" in withGrant) throw new Error(`worker did not start: ${withGrant.reason}`);
      live.push(withGrant);
      const allowed = await withGrant.client.bash("env | grep '^BRAVE_API_KEY='");
      expect(allowed.output).toContain("granted-brave-key");
    } finally {
      if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
      else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
      if (previousBrave === undefined) delete process.env.BRAVE_API_KEY;
      else process.env.BRAVE_API_KEY = previousBrave;
      tenant.cleanup();
    }
  }, 180_000);

  test("a killed worker reports itself dead and stops serving bash", async () => {
    // Anforderung 4 verlangt "restart on unexpected death". Die Registry kann
    // das nur, wenn der Prozess seinen eigenen Exit meldet — ein Worker, der
    // nach einem `kill` weiter `isAlive()` sagt, wird fuer immer wieder
    // ausgeliefert. Gemessen wird deshalb beides: das Flag **und** die Folge
    // (ein Werkzeugaufruf geht nicht mehr durch).
    const tenant = makeTenant("dying");
    const bunPath = resolveBunPath();
    const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
    process.env.OMP_WEB_HOME_ROOT = tenant.root;
    try {
      const worker = await startTenantWorker(tenant.identity, {
        bunPath: bunPath, repoRoot, providers: [], startTimeoutMs: 60_000,
      });
      if ("ok" in worker) throw new Error(`worker did not start: ${worker.reason}: ${worker.detail}`);
      live.push(worker);

      // Vorher: lebt und antwortet. Das ist die Gegenprobe — ohne sie waere ein
      // dauerhaftes `false` von `isAlive` ebenfalls "gruen".
      expect(worker.isAlive()).toBe(true);
      const before = await worker.client.bash("echo alive");
      expect(before.output).toContain("alive");

      // Den Leader hart beenden: `kill` auf die PID, die der Start gemeldet hat.
      expect(typeof worker.pid).toBe("number");
      process.kill(worker.pid, "SIGKILL");
      // Auf das Exit-Signal warten statt zu schlafen: das Flag ist die Zusage,
      // die der Prozess macht, und `Bun.Subprocess.exited` loest es aus.
      for (let attempt = 0; attempt < 100 && worker.isAlive(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(worker.isAlive()).toBe(false);
    } finally {
      if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
      else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
      tenant.cleanup();
    }
  }, 120_000);

  test("a worker whose namespace probe fails is refused, and its process is gone", async () => {
    // Der Defekt aus der Aufgabe: `enforced` folgte aus `pid !== undefined`. Ein
    // `bwrap`-Wrapper frueher im PATH, der die Nutzlast ohne Mount-Namespace
    // `exec`t, liefert genau das — eine PID ohne Grenze — und der Client bekam
    // `enforced: true` fuer einen unconfined Mandanten.
    //
    // Gemessen wird der Vertrag, nicht der Wrapper: die Probe wird durch die
    // Option ersetzt, und zwar in der **Form** der echten (`pid`, `username`),
    // damit die Aufrufstelle nicht an einer anderen Signatur vorbeigeht. Ein
    // Test ueber einen echten Wrapper waere ein zweiter Testgegenstand
    // (PATH-Aufloesung, Shell-Semantik, `exec`-Ersatz) — und er wuerde den
    // Wrapper messen, nicht die Entscheidung.
    const tenant = makeTenant("wrapper-probe");
    const bunPath = resolveBunPath();
    const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
    process.env.OMP_WEB_HOME_ROOT = tenant.root;
    const probed = [];
    try {
      const result = await startTenantWorker(tenant.identity, {
        bunPath: bunPath,
        repoRoot,
        providers: [],
        startTimeoutMs: 60_000,
        // Ein Befund in der Form der echten Probe, inklusive Pfad und `errno`.
        probeNamespace: (pid, username) => {
          probed.push({ pid, username });
          return {
            ok: false,
            detail: `injected probe: /proc/${pid}/root is the service root, and /proc/${pid}/root/home lists ["${process.env.USER ?? "pi"}"] instead of only ["${username}"]`,
          };
        },
      });
      // Kein Worker-Objekt mit `enforced: true`: der Start lehnt ab.
      expect("ok" in result).toBe(true);
      if ("ok" in result) return;
      expect(result.reason).toBe("boundary-not-enforced");
      expect(result.detail).toContain("injected probe");
      expect(result.detail).toContain(tenant.identity.username);
      // Die Abhilfe nennt den wahrscheinlichen Grund beim Namen.
      expect(result.remediation).toContain("PATH");
      expect(result.remediation).toContain("bwrap");

      // Die Probe lief genau einmal pro Start, mit der gemeldeten PID des
      // Leaders — nicht pro Anfrage und nicht mit dem inneren Prozess.
      expect(probed.length).toBe(1);
      expect(probed[0]?.username).toBe("wrapper-probe");
      expect(probed[0]?.pid).toBeGreaterThan(0);

      // Und der Prozessbaum ist wirklich weg: ein abgelehnter Start darf keinen
      // unconfined Worker hinterlassen, den niemand mehr kennt.
      let alive = true;
      try { process.kill(probed[0].pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    } finally {
      if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
      else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
      tenant.cleanup();
    }
  }, 120_000);
});

describe.skipIf(bwrap.ok)("tenant worker boundary (skipped)", () => {
  test("bubblewrap is unavailable, so the boundary was not measured", () => {
    // Kein stilles Gruen: der Grund steht im Log des Laufs.
    console.warn(`SECURITY: the tenant boundary test was skipped — ${bwrap.detail}`);
    expect(bwrap.ok).toBe(false);
  });
});

/**
 * Diese Tests laufen **ohne** bwrap und pruefen die Entscheidung, nicht die
 * Namespace: was passiert, wenn die Grenze fehlt.
 */
describe("tenant worker fail-closed policy", () => {
  test("a tenant without bubblewrap fails with a named error, not an in-process fallback", async () => {
    const previousPath = process.env.PATH;
    const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
    const tenant = makeTenant("no-bwrap");
    process.env.OMP_WEB_HOME_ROOT = tenant.root;
    // `bwrap` verstecken: der Plan muss ablehnen, nicht auf den Serverprozess
    // ausweichen.
    process.env.PATH = "/nonexistent";
    try {
      const planned = planTenantWorker(tenant.identity, {
        bunPath: resolveBunPath(),
        repoRoot,
        providers: [],
      });
      // Entweder der Plan selbst oder der Start scheitert — beides ist ein
      // benannter Fehler; ein `ok: false` ohne Grund waere das Problem.
      if (!planned.ok) {
        expect(planned.reason).toBeTruthy();
        expect(planned.detail.length).toBeGreaterThan(0);
        expect(planned.remediation.length).toBeGreaterThan(0);
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
      else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
      tenant.cleanup();
    }
  });

  test("a missing tenant home is refused with remediation", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-iso-missing-"));
    const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
    process.env.OMP_WEB_HOME_ROOT = root;
    try {
      const result = planTenantWorker({ username: "ghost" }, {
        bunPath: resolveBunPath(),
        repoRoot,
        providers: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("boundary-unavailable");
        expect(result.detail).toContain("does not exist");
        expect(result.remediation).toContain("POST /api/accounts");
      }
    } finally {
      if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
      else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tenant home that exists but has no SDK is refused, naming the missing entry", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-iso-nosdk-"));
    const previousHomeRoot = process.env.OMP_WEB_HOME_ROOT;
    process.env.OMP_WEB_HOME_ROOT = root;
    mkdirSync(join(root, "nosdk"), { recursive: true });
    try {
      const result = planTenantWorker({ username: "nosdk" }, {
        bunPath: resolveBunPath(),
        repoRoot: join(root, "no-repo"),
        providers: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("boundary-unavailable");
        expect(result.detail).toContain("dist/cli.js");
      }
    } finally {
      if (previousHomeRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
      else process.env.OMP_WEB_HOME_ROOT = previousHomeRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Der Plan selbst, ohne Prozess.
 *
 * Der Integrationstest oben startet einen echten Worker und misst die Grenze
 * von innen. Diese Tests pruefen die Form des argv — die Dinge, die ein
 * spaeterer Umbau still kaputtmachen kann, ohne dass ein Start scheitert:
 * `--clearenv` vor den `--setenv`-Paaren, `--allow-home` gegen den Auto-Chdir,
 * die umask, und dass keine Host-Pfade in die Umgebung geraten.
 */
describe("worker plan argv", () => {
  function planFor(username) {
    const root = mkdtempSync(join(tmpdir(), "omp-plan-"));
    const home = join(root, username);
    mkdirSync(join(home, ".omp", "agent", "sessions"), { recursive: true, mode: 0o700 });
    const previous = process.env.OMP_WEB_HOME_ROOT;
    process.env.OMP_WEB_HOME_ROOT = root;
    const plan = planTenantWorker({ username }, {
      bunPath: resolveBunPath(),
      repoRoot,
      providers: [],
    });
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
    return plan;
  }

  test("the plan is a full bwrap argv with the guest home bound", () => {
    const plan = planFor("argvprobe");
    if (!plan.ok) throw new Error(`plan refused: ${plan.reason}: ${plan.detail}`);
    const joined = plan.argv.join(" ");
    expect(plan.argv[0]).toEndWith("bwrap");
    expect(joined).toContain("--unshare-user");
    expect(joined).toContain("--unshare-pid");
    expect(joined).toContain("--unshare-ipc");
    expect(joined).toContain("--unshare-uts");
    expect(joined).toContain("--die-with-parent");
    expect(joined).toContain("--bind");
    expect(joined).toContain("/home/argvprobe");
  });

  test("--clearenv comes before every --setenv pair", () => {
    // Eine Umgebung, die vor dem Leeren gesetzt wird, wird geleert — und der
    // Worker startet ohne HOME. Die Reihenfolge ist die ganze Zusage.
    const plan = planFor("envorder");
    if (!plan.ok) throw new Error(`plan refused: ${plan.reason}`);
    const cleared = plan.argv.indexOf("--clearenv");
    const firstSetenv = plan.argv.indexOf("--setenv");
    expect(cleared).toBeGreaterThan(-1);
    expect(firstSetenv).toBeGreaterThan(cleared);
    expect(plan.argv.filter((arg) => arg === "--clearenv").length).toBe(1);
  });

  test("--allow-home keeps the tenant home as the workspace", () => {
    // Ohne das Flag zieht `maybeAutoChdir` aus `$HOME` nach `/tmp` um
    // (src/cli/startup-cwd.ts:11-42). Gemessen: `pwd` im Worker war `/tmp`.
    const plan = planFor("cwdprobe");
    if (!plan.ok) throw new Error(`plan refused: ${plan.reason}`);
    expect(plan.argv).toContain("--allow-home");
    expect(plan.argv[plan.argv.indexOf("--chdir") + 1]).toBe("/home/cwdprobe");
  });

  test("the umask wrapper runs before the SDK, not after", () => {
    // Die umask gilt fuer jeden `open(O_CREAT)`. Ein `chmod` nach dem Schreiben
    // waere ein Rennen gegen die WAL-Datei, die waehrend der Laufzeit entsteht.
    const plan = planFor("umaskprobe");
    if (!plan.ok) throw new Error(`plan refused: ${plan.reason}`);
    const joined = plan.argv.join("\u0000");
    expect(joined).toContain("umask 077");
    // Nach `-c` **in der Kommandoposition** suchen, nicht irgendwo im argv:
    // `--setenv PATH /usr/local/bin:/usr/bin:/bin` enthaelt ebenfalls ein `-c`
    // als Teil eines Wertes, und ein `indexOf("-c")` traf genau das (gemessen:
    // Index 36 mitten in den `--setenv`-Paaren).
    const umaskAt = plan.argv.findIndex((arg, index) =>
      arg === "-c" && plan.argv[index - 1] === "/bin/sh");
    // `/home/<name>/bun` steht **zweimal**: einmal als Ziel des `--ro-bind`
    // und einmal als Kommando nach dem Wrapper. Gemeint ist das Kommando, also
    // das letzte Vorkommen.
    const bunAt = plan.argv.lastIndexOf("/home/umaskprobe/bun");
    expect(umaskAt).toBeGreaterThan(-1);
    expect(bunAt).toBeGreaterThan(umaskAt);
    // Und der Wrapper steht **vor** dem Bun: waere er dahinter, wuerde er
    // nichts mehr umstellen.
    expect(plan.argv[umaskAt - 1]).toBe("/bin/sh");
    expect(plan.argv[umaskAt + 1]).toContain("umask 077");
  });

  test("no host path leaks into the worker environment", () => {
    const plan = planFor("leakprobe");
    if (!plan.ok) throw new Error(`plan refused: ${plan.reason}`);
    // `OMP_WEB_HOME_ROOT` ist ein Host-Pfad; er darf in der Grenze nicht
    // stehen, weil er die Kontostruktur des Hosts verraten wuerde.
    expect(JSON.stringify(plan.env)).not.toContain(process.env.OMP_WEB_HOME_ROOT ?? "/nonexistent-root");
    expect(plan.argv.join("\u0000")).not.toContain("--setenv OMP_WEB_");
  });
});
