import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSessionHeader, guestSessionDir, toGuestPath, toHostPath } from "./tenant-worker-session";

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

/**
 * Die Identitaet: die Id, die der Client bekommt, ist die Id der Liste.
 *
 * Gemessen am 2026-11-09: `POST /api/agent/new` gab die Worker-Id zurueck
 * (`…-8787…`), `GET /api/sessions` zeigte dieselbe Datei unter einer zweiten Id
 * (`…-8831…`), und `GET /api/sessions/<8787>` fand nichts. Ursache war die
 * Kopfzeile, die der Server beim Anlegen der Datei selbst vergab.
 */
describe("seedSessionHeader", () => {
  test("das neu angelegte Transcript traegt die uebergebene Id, und open uebernimmt sie", async () => {
    const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
    const root = mkdtempSync(join(tmpdir(), "omp-seed-"));
    try {
      const tenantHome = join(root, "tenant");
      mkdirSync(tenantHome, { recursive: true, mode: 0o700 });
      const workerId = "01a1bfbb-8787-7460-9397-693a73ba7016";
      // Derselbe Pfad, den der Worker meldet: `<verzeichnis>/<ts>_<id>.jsonl`.
      const file = join(root, "sessions", `2026-11-09T09-55-00-615Z_${workerId}.jsonl`);

      seedSessionHeader(file, workerId, tenantHome);
      expect(readFileSync(file, "utf8").includes(`"id":"${workerId}"`)).toBe(true);

      const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: tenantHome });
      expect(manager.getHeader()?.id).toBe(workerId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ein vorhandenes Transcript bleibt unveraendert", async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-seed-"));
    try {
      const tenantHome = join(root, "tenant");
      mkdirSync(tenantHome, { recursive: true, mode: 0o700 });
      // Eine Session von der Platte: ihre Id ist die Wahrheit, auch wenn der
      // Aufrufer eine andere mitbringt.
      const onDisk = "01a1bfb1-1111-7000-8000-00000000aaaa";
      const file = join(root, "sessions", `2026-11-01T00-00-00-000Z_${onDisk}.jsonl`);
      seedSessionHeader(file, onDisk, tenantHome);
      const before = readFileSync(file, "utf8");

      seedSessionHeader(file, "01a1bfbb-8787-7460-9397-693a73ba7016", tenantHome);
      expect(readFileSync(file, "utf8")).toBe(before);

      const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
      const reopened = await SessionManager.open(file, undefined, undefined, { initialCwd: tenantHome });
      expect(reopened.getHeader()?.id).toBe(onDisk);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
