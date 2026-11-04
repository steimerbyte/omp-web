import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./projects-sizes.ts");
}

/**
 * Die Sperre "ein Lauf pro Identitaet".
 *
 * Sie ist der Grund, warum zwei parallele Anfragen nicht zwei `du`-Schwaerme
 * starten. Die Sperre haengt am **Registry-Pfad**, nicht am Benutzernamen:
 * zwei Admin-Konten teilen eine Datei, und zwei Schreibvorgaenge auf dieselbe
 * Datei sind genau der Datenverlust, den der zweite Lesevorgang verhindert.
 *
 * Geprueft wird der Lebenslauf: gesetzt, solange der Lauf laeuft; weg, wenn er
 * fertig ist — auch wenn er geworfen hat (der `finally`).
 */
function withHomeRoot(root, run) {
  const previous = process.env.OMP_WEB_HOME_ROOT;
  process.env.OMP_WEB_HOME_ROOT = root;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("the lock is held while a run is in flight and released afterwards", async () => {
  const { isProjectSizeMeasurementRunning, startProjectSizeMeasurement } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "omp-sizes-"));
  const alice = { username: "alice", isAdmin: false };
  const projectRoot = join(root, "alice", "projekt");
  mkdirSync(projectRoot, { recursive: true });
  const gate = deferred();

  try {
    const { writeProjectsFile } = await import("./projects-store.ts");
    withHomeRoot(root, () => writeProjectsFile(alice, { projects: [{ root: projectRoot }] }));

    await withHomeRoot(root, async () => {
      startProjectSizeMeasurement(alice, {
        measure: () => gate.promise,
      });
      assert.equal(isProjectSizeMeasurementRunning(alice), true);

      // Ein zweiter Aufruf darf den ersten nicht verdraengen.
      startProjectSizeMeasurement(alice, { measure: async () => new Map() });
      assert.equal(isProjectSizeMeasurementRunning(alice), true);

      gate.resolve(new Map());
      await tick();
      assert.equal(isProjectSizeMeasurementRunning(alice), false, "nach dem Lauf ist die Sperre weg");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run whose measurement throws still releases the lock", async () => {
  const { isProjectSizeMeasurementRunning, startProjectSizeMeasurement } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "omp-sizes-"));
  const bob = { username: "bob", isAdmin: false };
  const projectRoot = join(root, "bob", "projekt");
  mkdirSync(projectRoot, { recursive: true });

  try {
    const { writeProjectsFile } = await import("./projects-store.ts");
    withHomeRoot(root, () => writeProjectsFile(bob, { projects: [{ root: projectRoot }] }));

    await withHomeRoot(root, async () => {
      // Der Fehlschlag wird protokolliert, nicht verschluckt — sonst bliebe
      // eine Karte fuer immer ohne Groesse und niemand wuesste warum.
      const logged = [];
      const realConsoleError = console.error;
      console.error = (...args) => { logged.push(args); };
      try {
        startProjectSizeMeasurement(bob, {
          measure: async () => { throw new Error("du ist gescheitert"); },
        });
        await tick();
      } finally {
        console.error = realConsoleError;
      }
      assert.equal(isProjectSizeMeasurementRunning(bob), false, "ein Fehler darf die Identitaet nicht verklemmen");
      assert.equal(logged.length, 1);
      assert.match(String(logged[0][0]), /\[projects\]/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two identities have independent locks", async () => {
  const { isProjectSizeMeasurementRunning, startProjectSizeMeasurement } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "omp-sizes-"));
  const alice = { username: "alice", isAdmin: false };
  const bob = { username: "bob", isAdmin: false };
  mkdirSync(join(root, "alice", "projekt"), { recursive: true });
  mkdirSync(join(root, "bob", "projekt"), { recursive: true });
  const gate = deferred();

  try {
    const { writeProjectsFile } = await import("./projects-store.ts");
    withHomeRoot(root, () => {
      writeProjectsFile(alice, { projects: [{ root: join(root, "alice", "projekt") }] });
      writeProjectsFile(bob, { projects: [{ root: join(root, "bob", "projekt") }] });
    });

    await withHomeRoot(root, async () => {
      startProjectSizeMeasurement(alice, { measure: () => gate.promise });
      assert.equal(isProjectSizeMeasurementRunning(alice), true);
      assert.equal(isProjectSizeMeasurementRunning(bob), false, "Bobs Registry ist eine andere Datei");
      gate.resolve(new Map());
      await tick();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
