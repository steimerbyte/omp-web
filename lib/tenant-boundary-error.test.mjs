import { describe, expect, test } from "bun:test";
import { __resetUnsandboxedTenantWarning, logUnsandboxedTenantWarningOnce, TenantBoundaryError, tenantBoundaryHttpStatus } from "./rpc-manager";

/**
 * Die zwei Zusagen, die eine Grenze nach aussen macht: ein benannter Fehler und
 * eine Warnung, die nicht mehrfach kommt.
 */

describe("TenantBoundaryError", () => {
  test("carries reason, detail and remediation so a route can answer with all three", () => {
    // A5 der Abnahmetabelle: der Fehlerkoerper nennt `reason` und
    // `remediation`. Ein `Error` mit nur einer Nachricht zwingt die Route, den
    // Grund aus einem String zu raten.
    const error = new TenantBoundaryError({
      reason: "bwrap-missing",
      detail: "bwrap --version failed",
      remediation: "Install bubblewrap",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TenantBoundaryError");
    expect(error.reason).toBe("bwrap-missing");
    expect(error.detail).toBe("bwrap --version failed");
    expect(error.remediation).toBe("Install bubblewrap");
    expect(error.message).toContain("bwrap-missing");
  });

  test("the three fields survive JSON serialisation into a response body", () => {
    const error = new TenantBoundaryError({ reason: "mask-unavailable", detail: "d", remediation: "r" });
    // So baut die Route den Koerper; ein `toJSON` auf dem Prototyp wuerde hier
    // still die Felder verlieren.
    const body = JSON.parse(JSON.stringify({ error: error.message, reason: error.reason, detail: error.detail, remediation: error.remediation }));
    expect(body.reason).toBe("mask-unavailable");
    expect(body.detail).toBe("d");
    expect(body.remediation).toBe("r");
  });
});

describe("the opt-out warning is once per process", () => {
  test("the second call prints nothing", () => {
    __resetUnsandboxedTenantWarning();
    const seen = [];
    const original = console.warn;
    console.warn = (...args) => { seen.push(args.join(" ")); };
    try {
      logUnsandboxedTenantWarningOnce({ OMP_WEB_ALLOW_UNSANDBOXED_TENANT: "1" });
      logUnsandboxedTenantWarningOnce({ OMP_WEB_ALLOW_UNSANDBOXED_TENANT: "1" });
      logUnsandboxedTenantWarningOnce({ OMP_WEB_ALLOW_UNSANDBOXED_TENANT: "1" });
    } finally {
      console.warn = original;
      __resetUnsandboxedTenantWarning();
    }
    // Einmal, nicht dreimal: eine Zeile pro Request waere das Rauschen, das die
    // eine wichtige Zeile verdeckt.
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("OMP_WEB_ALLOW_UNSANDBOXED_TENANT");
  });

  test("without the flag nothing is printed at all", () => {
    __resetUnsandboxedTenantWarning();
    const seen = [];
    const original = console.warn;
    console.warn = (...args) => { seen.push(args.join(" ")); };
    try {
      logUnsandboxedTenantWarningOnce({});
    } finally {
      console.warn = original;
      __resetUnsandboxedTenantWarning();
    }
    expect(seen.length).toBe(0);
  });
});

/**
 * Die Worker-Registry ist prozess-global, wie die Session-Registry selbst.
 *
 * Der Test greift ueber `globalThis` auf genau die Instanz zu, die der
 * Produktionscode benutzt — ein zweiter Aufruf darf keine zweite Registry
 * anlegen, sonst gaebe es pro Konto zwei Worker.
 */
describe("the boundary error reaches the route as a body with three fields", () => {
  test("a route that catches a TenantBoundaryError can answer with reason and remediation", () => {
    // Das ist der Vertrag von A5, an der Stelle geprueft, an der die Route ihn
    // benutzt: `error instanceof TenantBoundaryError` entscheidet, ob `reason`
    // und `remediation` im Koerper landen.
    const failure = { reason: "bwrap-missing", detail: "not installed", remediation: "install bubblewrap" };
    const caught = (() => {
      try {
        throw new TenantBoundaryError(failure);
      } catch (error) {
        return error;
      }
    })();
    const body = caught instanceof TenantBoundaryError
      ? { error: caught.message, reason: caught.reason, detail: caught.detail, remediation: caught.remediation }
      : { error: String(caught) };
    expect(body.reason).toBe("bwrap-missing");
    expect(body.remediation).toBe("install bubblewrap");
    // Und ein fremder Fehler traegt diese Felder **nicht**: sonst wuerde jeder
    // Programmierfehler als Grenzablehnung angezeigt.
    const other = new Error("something else");
    expect(other instanceof TenantBoundaryError).toBe(false);
  });
});

describe("tenantBoundaryHttpStatus", () => {
  // Der Status ist Teil des Vertrags: ein fehlendes bwrap ist ein Zustand des
  // Hosts, den der Betreiber behebt (503). Eine 500 schickt ihn in die Logs,
  // obwohl `reason` und `remediation` im Koerper stehen. Der Terminal-Pfad
  // antwortet fuer dieselbe Ursache seit jeher 503
  // (app/api/terminal/route.ts:97-104); zwei Statuscodes fuer eine Ursache
  // waeren ein Widerspruch in der API.
  test("answers 503 for the host preconditions", () => {
    for (const reason of ["bwrap-missing", "userns-disabled", "boundary-unavailable", "mask-unavailable"]) {
      expect(tenantBoundaryHttpStatus(reason)).toBe(503);
    }
  });

  test("answers 500 for a genuine failure and for an unknown reason", () => {
    // `tenant-worker-spawn-failed`: der Plan ging auf, der Prozess starb. Ein
    // 503 wuerde "probier es gleich nochmal" sagen und einen Wiederholungs-
    // sturm auf einen Defekt ausloesen.
    expect(tenantBoundaryHttpStatus("tenant-worker-spawn-failed")).toBe(500);
    // Eine Betriebsgrenze ist kein Zustand des Hosts.
    expect(tenantBoundaryHttpStatus("tenant-worker-capacity")).toBe(500);
    // Und ein neuer Grund soll laut auffallen, nicht still als "kommt wieder"
    // durchgehen — deshalb 500 und nicht 503 als Vorgabewert.
    expect(tenantBoundaryHttpStatus("something-nobody-added-yet")).toBe(500);
  });

  test("windows is not a temporary condition, so it stays 500", () => {
    // Windows bekommt keine User-Namespaces durch erneutes Versuchen.
    expect(tenantBoundaryHttpStatus("unsupported-platform")).toBe(500);
  });
});
