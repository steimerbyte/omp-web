import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guestSessionDir, toGuestPath, toHostPath } from "./tenant-worker-session";

/**
 * Die Pfad-Abbildung zwischen Server und Worker.
 *
 * Das ist die Stelle, an der ein Fehler am teuersten ist und am leisesten
 * aussieht: ein Gast-Pfad, den der Server fuer einen Host-Pfad haelt, ist kein
 * Absturz, sondern eine Datei, die "es nicht gibt" — und irgendwann eine
 * Session, die verloren geht. Gemessen am 2026-11-08: genau das passierte,
 * bevor `toHostPath` existierte.
 */

function withHomeRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "omp-path-"));
  const previous = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = root;
  try {
    return run(root);
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const identity = (username) => ({ username });

describe("toHostPath", () => {
  test("maps a guest path under the tenant home to the host path", () => {
    withHomeRoot((root) => {
      expect(toHostPath("/home/hannah/.omp/agent/sessions/x.jsonl", identity("hannah")))
        .toBe(join(root, "hannah", ".omp", "agent", "sessions", "x.jsonl"));
    });
  });

  test("maps the guest home itself", () => {
    withHomeRoot((root) => {
      expect(toHostPath("/home/hannah", identity("hannah"))).toBe(join(root, "hannah"));
    });
  });

  test("returns null instead of guessing for a path outside the guest home", () => {
    // Der Vertrag aus §7 L4: lieber `null` als eine Vermutung. Ein Pfad
    // ausserhalb ist kein Mandanten-Pfad, und ihn trotzdem zu uebersetzen
    // hiesse, den naechsten zufaelligen String als Datei zu oeffnen.
    withHomeRoot(() => {
      expect(toHostPath("/etc/passwd", identity("hannah"))).toBeNull();
      expect(toHostPath("/home/samuel/.omp/agent/sessions/x.jsonl", identity("hannah"))).toBeNull();
      expect(toHostPath("/home/hannahx/y", identity("hannah"))).toBeNull();
      expect(toHostPath("", identity("hannah"))).toBeNull();
      expect(toHostPath(undefined, identity("hannah"))).toBeNull();
    });
  });
});

describe("toGuestPath", () => {
  test("round-trips with toHostPath", () => {
    withHomeRoot(() => {
      const guest = "/home/hannah/.omp/agent/sessions/x.jsonl";
      expect(toGuestPath(toHostPath(guest, identity("hannah")), identity("hannah"))).toBe(guest);
    });
  });

  test("returns null for a host path outside the tenant home", () => {
    withHomeRoot(() => {
      expect(toGuestPath("/etc/passwd", identity("hannah"))).toBeNull();
      expect(toGuestPath(undefined, identity("hannah"))).toBeNull();
    });
  });
});

describe("guestSessionDir", () => {
  test("is the tenant's sessions directory inside the boundary", () => {
    // Kein `join` auf einem Host-Pfad: das ist der **Gast**-Pfad, und er muss
    // unabhaengig von `OMP_WEB_HOME_ROOT` immer `/home/<name>/…` sein.
    expect(guestSessionDir(identity("hannah"))).toBe("/home/hannah/.omp/agent/sessions");
  });
});

/**
 * Die Kopfzeile, die der **Server** schreibt.
 *
 * `createWorkerBackedSession` oeffnet das Transcript mit `SessionManager.open`.
 * Ohne `initialCwd` faellt das SDK auf `getProjectDir()` zurueck — den cwd des
 * Serverprozesses. Der `cwd` aus der Kopfzeile ist kein Anzeigefeld:
 * `getAllowedFileRoots` macht daraus eine erlaubte Datei-Wurzel, und der
 * Mandant haette damit den Quellbaum des Betreibers lesen koennen (gemessen am
 * 2026-11-08: `roots` enthielt `/home/pi/workspace/omp-web-iso`).
 *
 * Der Test misst die SDK-Zusage, auf die sich die Aufrufstelle verlaesst, und
 * nicht `createWorkerBackedSession` selbst — dazu braeuchte es einen Worker,
 * und der ist hier nicht der Punkt. Geprueft wird die Zeile, die im Code
 * steht: `open(..., { initialCwd })` schreibt **diesen** cwd in die Kopfzeile.
 */
describe("SessionManager.open mit initialCwd", () => {
  test("die Kopfzeile traegt den uebergebenen cwd, nicht den des Prozesses", async () => {
    const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
    const root = mkdtempSync(join(tmpdir(), "omp-header-"));
    try {
      const tenantHome = join(root, "tenant");
      mkdirSync(tenantHome, { recursive: true, mode: 0o700 });
      const file = join(root, "x.jsonl");
      const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: tenantHome });
      expect(manager.getHeader()?.cwd).toBe(tenantHome);
      // Und die Gegenprobe: ohne die Angabe ist es der Prozess-cwd. Damit ist
      // belegt, dass der Parameter die Ursache ist und nicht ein Zufall.
      const bare = await SessionManager.open(join(root, "y.jsonl"), undefined);
      expect(bare.getHeader()?.cwd).toBe(process.cwd());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
