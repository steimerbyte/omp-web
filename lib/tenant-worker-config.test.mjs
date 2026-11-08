import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WORKER_IDLE_MS,
  DEFAULT_WORKER_MAX,
  allowUnsandboxedTenant,
  buildWorkerEnv,
  isTenantWorkerIdentity,
  resolveWorkerIdleMs,
  resolveWorkerMax,
  tenantProviders,
  unsandboxedTenantWarning,
  workerGuestPaths,
} from "./tenant-worker-config";
import { tenantBoundaryPolicy } from "./tenant-worker";

/**
 * Die Entscheidungen der Grenze, ohne Prozess und ohne Namespace.
 *
 * Was hier steht, ist bewusst das, was sich **ohne** `bwrap` entscheiden laesst:
 * die Zahlen, die Allowlist, der Ausstieg und die Frage "Worker oder
 * Serverprozess". Die Grenze selbst wird in `tenant-worker.test.mjs` gegen einen
 * echten Worker gemessen — ein Unit-Test kann sie nicht sehen.
 */

function identity(username, isAdmin = false) {
  return { username, isAdmin };
}

describe("worker limits", () => {
  test("defaults are the measured ones", () => {
    expect(DEFAULT_WORKER_MAX).toBe(4);
    expect(DEFAULT_WORKER_IDLE_MS).toBe(300_000);
  });

  test("an unset or invalid value falls back to the default, never to zero", () => {
    // Null Worker waere ein Mandant, der nie eine Session bekommt; ein
    // `Number.parseInt("")` ist NaN und darf nicht als 0 durchrutschen.
    for (const env of [{}, { OMP_WEB_TENANT_WORKER_MAX: "" }, { OMP_WEB_TENANT_WORKER_MAX: "abc" },
      { OMP_WEB_TENANT_WORKER_MAX: "0" }, { OMP_WEB_TENANT_WORKER_MAX: "-3" }]) {
      expect(resolveWorkerMax(env )).toBe(DEFAULT_WORKER_MAX);
    }
  });

  test("a too-large value is clamped by the ceiling, not accepted", () => {
    // 64 ist die Obergrenze; 1000 Worker wuerden den Host umbringen, bevor der
    // Betreiber merkt, dass er eine Zahl getippt hat.
    expect(resolveWorkerMax({ OMP_WEB_TENANT_WORKER_MAX: "2" })).toBe(2);
    expect(resolveWorkerMax({ OMP_WEB_TENANT_WORKER_MAX: "1000" })).toBe(DEFAULT_WORKER_MAX);
  });

  test("the idle timeout has a floor so a typo does not thrash processes", () => {
    expect(resolveWorkerIdleMs({ OMP_WEB_TENANT_WORKER_IDLE_MS: "60000" })).toBe(60_000);
    expect(resolveWorkerIdleMs({ OMP_WEB_TENANT_WORKER_IDLE_MS: "1" })).toBe(DEFAULT_WORKER_IDLE_MS);
  });
});

describe("the opt-out", () => {
  test("only the exact value 1 enables it", () => {
    expect(allowUnsandboxedTenant({})).toBe(false);
    expect(allowUnsandboxedTenant({ OMP_WEB_ALLOW_UNSANDBOXED_TENANT: "0" })).toBe(false);
    expect(allowUnsandboxedTenant({ OMP_WEB_ALLOW_UNSANDBOXED_TENANT: "true" })).toBe(false);
    expect(allowUnsandboxedTenant({ OMP_WEB_ALLOW_UNSANDBOXED_TENANT: "1" })).toBe(true);
  });

  test("the warning names the variable and says the sessions are unconfined", () => {
    const warning = unsandboxedTenantWarning({ OMP_WEB_ALLOW_UNSANDBOXED_TENANT: "1" });
    expect(warning).not.toBeNull();
    expect(warning).toContain("OMP_WEB_ALLOW_UNSANDBOXED_TENANT");
    expect(warning?.toLowerCase()).toContain("ohne");
    // Es ist keine Warnung, sondern ein Alarm: der Rahmen ist der Unterschied
    // zwischen "gelesen" und "ueberlesen".
    expect(warning).toContain("!!!!");
  });

  test("no warning when the opt-out is off", () => {
    expect(unsandboxedTenantWarning({})).toBeNull();
  });
});

describe("who gets a worker", () => {
  test("a tenant goes to a worker, an admin stays in the process", () => {
    expect(tenantBoundaryPolicy(identity("hannah"))).toEqual({ mode: "worker" });
    expect(tenantBoundaryPolicy(identity("pi", true))).toEqual({
      mode: "in-process", enforced: false, reason: "admin",
    });
  });

  test("no identity is the in-process path with its own reason", () => {
    expect(tenantBoundaryPolicy(null)).toEqual({ mode: "in-process", enforced: false, reason: "no-identity" });
  });

  test("the opt-out turns every tenant into the in-process path, spelled out", () => {
    const policy = tenantBoundaryPolicy(identity("hannah"), { OMP_WEB_ALLOW_UNSANDBOXED_TENANT: "1" });
    expect(policy).toEqual({ mode: "in-process", enforced: false, reason: "opted-out" });
  });

  test("an admin is not a worker candidate even with the opt-out set", () => {
    expect(isTenantWorkerIdentity(identity("pi", true))).toBe(false);
    expect(isTenantWorkerIdentity(null)).toBe(false);
    expect(isTenantWorkerIdentity(identity("hannah"))).toBe(true);
  });
});

describe("the worker environment", () => {
  test("PATH is fixed, not inherited from the service", () => {
    // Der PATH des Dienstes traegt `/home/pi/.bun/bin` und Verwandte. Er in die
    // Grenze zu setzen verraet die Kontostruktur und hilft dort nicht.
    const { env } = buildWorkerEnv(identity("hannah"), [], {
      PATH: "/home/pi/.bun/bin:/home/pi/.cargo/bin:/usr/bin",
      LANG: "de_DE.UTF-8",
    });
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(env.PATH).not.toContain("/home/pi");
    expect(env.LANG).toBe("de_DE.UTF-8");
  });

  test("HOME, USER, LOGNAME and the agent dir are the guest values", () => {
    const { env } = buildWorkerEnv(identity("hannah"), [], {});
    expect(env.HOME).toBe("/home/hannah");
    expect(env.USER).toBe("hannah");
    expect(env.LOGNAME).toBe("hannah");
    expect(env.PI_CODING_AGENT_DIR).toBe("/home/hannah/.omp/agent");
  });

  test("no service secret is copied, even when the process has one", () => {
    const { env } = buildWorkerEnv(identity("hannah"), [], {
      OMP_WEB_PASSWORD: "operator-password",
      BRAVE_API_KEY: "brave-key",
      PARALLEL_API_KEY: "parallel-key",
    });
    expect(env.OMP_WEB_PASSWORD).toBeUndefined();
    expect(env.BRAVE_API_KEY).toBeUndefined();
    expect(env.PARALLEL_API_KEY).toBeUndefined();
  });

  test("a provider without a resolvable key is reported, not set empty", () => {
    // Ein `KEY=` waere ein gesetzter, aber falscher Wert: der Fehler wandert
    // vom Start in den ersten Modellaufruf, wo er viel teurer ist.
    const { env, missing } = buildWorkerEnv(identity("hannah"), ["openai"], {});
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(missing.map((entry) => entry.provider)).toContain("openai");
  });
});

describe("guest paths", () => {
  test("every path is inside the guest home", () => {
    const guest = workerGuestPaths(identity("hannah"));
    for (const value of Object.values(guest)) {
      expect(value.startsWith("/home/hannah")).toBe(true);
    }
    expect(guest.guestSessions).toBe("/home/hannah/.omp/agent/sessions");
    expect(guest.guestCli.endsWith("@oh-my-pi/pi-coding-agent/dist/cli.js")).toBe(true);
  });
});

/**
 * Die Provider eines Kontos kommen aus **seinem** `models.yml`.
 *
 * Der Punkt ist die Abgrenzung: der Betreiber hat einen Provider, das Konto
 * einen anderen, und der Worker darf nur den des Kontos sehen. Ohne diesen Test
 * waere "die Zugangsdaten dieses Kontos" eine Absicht ohne Beleg — und die
 * naheliegende Abkuerzung (den globalen Bestand nehmen) wuerde den Key des
 * Betreibers an jeden Mandanten weitergeben.
 *
 * `getUserHome` loest unter `OMP_WEB_HOME_ROOT` auf, also wird die Wurzel fuer
 * die Dauer des Tests auf ein Scratch-Verzeichnis gesetzt: sonst liest der Test
 * das echte `/home/<name>` und ist auf jedem Host ein anderer.
 */
describe("providers come from the tenant's own models.yml", () => {
  /**
   * Ein Konto-Home mit optionalem `models.yml`.
   *
   * Gibt die Aufraeumfunktion mit zurueck, weil `bun:test` kein `t.after` hat.
   */
  function withHome(contents) {
    const root = mkdtempSync(join(tmpdir(), "omp-tenant-providers-"));
    const home = join(root, "alice");
    const agentDir = join(home, ".omp", "agent");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    if (contents !== null) writeFileSync(join(agentDir, "models.yml"), contents, { mode: 0o600 });
    const previousRoot = process.env.OMP_WEB_HOME_ROOT;
    process.env.OMP_WEB_HOME_ROOT = root;
    return {
      identity: { username: "alice", isAdmin: false },
      cleanup() {
        if (previousRoot === undefined) delete process.env.OMP_WEB_HOME_ROOT;
        else process.env.OMP_WEB_HOME_ROOT = previousRoot;
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  test("returns exactly the providers the file declares", () => {
    const { identity: id, cleanup } = withHome([
      "providers:",
      "  mine-a:",
      "    baseUrl: http://127.0.0.1:9/v1",
      "    apiKey: dummy",
      "  mine-b:",
      "    baseUrl: http://127.0.0.1:9/v1",
      "    apiKey: dummy",
      "",
    ].join("\n"));
    try {
      expect(tenantProviders(id).sort()).toEqual(["mine-a", "mine-b"]);
    } finally {
      cleanup();
    }
  });

  test("a tenant without a models.yml yields no providers, not the operator's", () => {
    // Der gemessene Erstlauf scheiterte mit "No default model selected", weil
    // der Worker ohne jede Zugangsdaten startete. Die richtige Antwort darauf
    // ist eine leere Liste (der Mandant hat nichts konfiguriert) und **nicht**
    // ein Rueckgriff auf den Bestand des Betreibers.
    const { identity: id, cleanup } = withHome(null);
    try {
      expect(tenantProviders(id)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("an unparsable file yields no providers instead of throwing", () => {
    // Ein kaputtes `models.yml` ist ein Mandantenproblem, kein Serverabsturz:
    // der Worker startet dann ohne Provider, und der Fehler taucht dort auf, wo
    // er hingehoert.
    const { identity: id, cleanup } = withHome("providers: [this is not a mapping\n");
    try {
      expect(tenantProviders(id)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
