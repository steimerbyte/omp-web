import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * U13 aus `SHELL-ISOLATION-SCAN.md`: gibt es ueberhaupt einen Haken pro Sitzung?
 *
 * Die Antwort haengt an einer Frage, die man einem Typ nicht ansieht: fuehrt
 * `createAgentSession` die Fabriken aus `options.extensions` wirklich aus, oder
 * wandern sie nur in ein Feld? Der Scan konnte das offen lassen, weil er die
 * SDK-Typen gelesen hat und nicht den Aufruf.
 *
 * Der Test setzt eine Sonde als Inline-Extension in eine echte Sitzung und
 * prueft, ob sie mit einem Objekt aufgerufen wird, das `on` anbietet — das ist
 * die Voraussetzung dafuer, dass `makeSessionShellGuard` ueberhaupt greifen
 * kann. Die Sitzung braucht ein Modell; ohne Katalog (CI) wird uebersprungen.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-shell-guard-sdk-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
process.env.PI_CODING_AGENT_DIR = join(HOME_ROOT, "process-agent");
mkdirSync(join(HOME_ROOT, "process-agent"), { recursive: true });
mkdirSync(join(HOME_ROOT, "alice"), { recursive: true });
const project = join(HOME_ROOT, "alice", "project");
mkdirSync(project, { recursive: true });

const { makeSessionShellGuard } = await jiti.import("@/lib/session-shell-guard.ts");
const { getSettingsForIdentity, getOmpRuntime } = await jiti.import("@/lib/omp-runtime.ts");
const { createAgentSession, getAgentDir, SessionManager } = await jiti.import("@oh-my-pi/pi-coding-agent");

const alice = { username: "alice", isAdmin: false };
const runtime = await getOmpRuntime();
const sessionModel = runtime.modelRegistry.getAll()[0];

test(
  "eine Inline-Extension aus options.extensions wird pro Sitzung ausgefuehrt",
  { skip: sessionModel ? false : "no model catalogue" },
  async () => {
    let invokedWith = null;
    const handlers = {};
    const probe = (pi) => {
      invokedWith = pi;
      // `on` kapern, falls das API-Objekt es zulaesst — dann laesst sich der
      // geblockte Aufruf sogar direkt ausloesen. Wenn nicht, bleibt es beim
      // Nachweis, dass die Fabrik lief und `on` existiert.
      try {
        const original = pi.on.bind(pi);
        pi.on = (event, handler) => {
          (handlers[event] ??= []).push(handler);
          return original(event, handler);
        };
      } catch {
        // schreibgeschuetzt: der Nachweis unten bleibt gueltig
      }
      makeSessionShellGuard(alice)(pi);
    };

    const settings = await getSettingsForIdentity(alice, project);
    const sessionsDir = mkdtempSync(join(tmpdir(), "omp-web-shell-guard-sessions-"));
    const created = await createAgentSession({
      cwd: project,
      agentDir: getAgentDir(),
      settings,
      sessionManager: SessionManager.create(project, sessionsDir),
      authStorage: runtime.authStorage,
      modelRegistry: runtime.modelRegistry,
      model: sessionModel,
      hasUI: true,
      extensions: [probe],
    });

    assert.ok(invokedWith, "options.extensions wurde nicht ausgefuehrt — der Haken gaebe es nicht");
    assert.equal(typeof invokedWith.on, "function", "das API-Objekt muss `on` anbieten");

    const toolCallHandlers = handlers.tool_call ?? [];
    assert.equal(toolCallHandlers.length, 1, "der Shell-Haken muss sich als tool_call-Handler registrieren");
    const blocked = await toolCallHandlers[0]({ toolName: "bash", input: { command: "ls" } }, { cwd: "/etc" });
    assert.equal(blocked?.block, true, "ein bash-Aufruf ausserhalb des Homes muss durch denselben Haken fallen");
    const allowed = await toolCallHandlers[0]({ toolName: "bash", input: { command: "ls" } }, { cwd: join(HOME_ROOT, "alice") });
    assert.equal(allowed, undefined, "im eigenen Home darf nichts geblockt werden");

    await created.session.dispose?.();
    rmSync(sessionsDir, { recursive: true, force: true });
  },
);

test("startRpcSession haengt den Haken an die Sitzungsoptionen", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  assert.match(
    startupSource,
    /extensions: \[makeSessionShellGuard\(options\.identity\)\]/,
    "ohne diese Zeile hat der Agent-bash gar keine Grenze",
  );
});
