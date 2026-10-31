import { resolve } from "node:path";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { getAdditionalAllowedRoots } from "./allowed-roots";
import { isPathInUserHome, isPathWithinRoots } from "./path-security";
import { getUserHome, type WebIdentity } from "./request-identity";

/**
 * Die eine Grenze, die der Agent-`bash` einer Mandanten-Sitzung bekommt.
 *
 * Das SDK 18.14.0 hat **keine** Sandbox fuer sein `bash`-Tool
 * (`SHELL-ISOLATION-SCAN.md` §5): weder `CreateAgentSessionOptions` noch
 * `BashExecutorOptions` kennen `sandbox`, `allowedPaths` oder `noNewPrivs`, und
 * `executeBash({env})` ist eine Overlay-Map, kein Ersatz. Die Brush-Shell laeuft
 * ausserdem im Prozess, es gibt also kein `bash`-Binaerprogramm, um das man
 * `bwrap` legen koennte.
 *
 * Was es gibt, ist ein `tool_call`-Haken, der **blocken** kann — und er laesst
 * sich pro Sitzung registrieren: `CreateAgentSessionOptions.extensions` nimmt
 * fertige Factories (in 18.14.0 gelesen: `sdk.ts:679, 2880-2897`; die Inline-
 * Factories landen in `preparedExtensions`, also erben Subagenten sie). Damit
 * ist die Sitzungswurzel dasselbe Kriterium wie beim Zeitplaner
 * (`assertCwd` in `lib/scheduled-tasks-store.ts`): Home des Kontos oder eine
 * ausdruecklich vergebene Wurzel.
 *
 * Was das **nicht** ist: eine Sandbox. Ein `cd /` im Kommandotext sieht der
 * Haken nicht — er sieht den Aufruf, nicht die Shellsprache. Das bleibt offen,
 * bis das SDK einen Spawn-Haken anbietet; es steht so in `docs/inventory-tools.md`.
 *
 * Die gemessene Grenze (18.14.0): das Parameter-Schema des `bash`-Werkzeugs ist
 * `{command, timeout}` — es gibt **kein** `cwd` im Aufruf. `BashToolInput`
 * deklariert zwar ein optionales `cwd`, das Schema reicht es aber nicht durch,
 * also ist `event.input.cwd` im Normalfall leer und der Haken entscheidet
 * einmal pro Aufruf gegen `ctx.cwd` (die Sitzungswurzel). Ein Modell, das ein
 * `cwd` erfindet, wird daran gemessen; das Werkzeug selbst ignoriert das Feld.
 * Mehr als "diese Sitzung wurde in einem erlaubten Verzeichnis geoeffnet"
 * behauptet der Haken deshalb nicht.
 */
export function makeSessionShellGuard(identity: WebIdentity): ExtensionFactory {
  const home = getUserHome(identity);
  const grants = new Set(
    [...getAdditionalAllowedRoots(identity)].filter((root) => root !== home),
  );

  return (pi) => {
    // Ein Admin ist der Host; `getUserHome` gibt ihm `/`, und eine Grenze gegen
    // `/` waere keine. Dieselbe Entscheidung wie im Terminal: unconfined, aber
    // ausgesprochen.
    if (identity.isAdmin) return;

    pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "bash") return;
      const requested = typeof event.input.cwd === "string" ? event.input.cwd.trim() : "";
      // Ein `scheme://`-cwd (das SDK erlaubt URLs als Arbeitsverzeichnis) laesst
      // sich nicht gegen ein Dateisystem pruefen und ist in einer Mandanten-
      // Sitzung kein Arbeitsverzeichnis, sondern ein Ausgang.
      if (requested.includes("://")) {
        return { block: true, reason: `This session may only run bash inside ${home}; a URL working directory is not allowed.` };
      }
      const sessionCwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
      const target = requested.length > 0 ? resolve(sessionCwd, requested) : sessionCwd;
      // Das Home wird per realpath geprueft (`isPathInUserHome`), eine vom
      // Betreiber vergebene Wurzel lexikalisch — dieselbe Regel wie in
      // `/api/cwd/validate`.
      if (isPathInUserHome(identity, target) || isPathWithinRoots(target, grants)) return;
      return {
        block: true,
        reason: `This account may only run bash inside ${home}. ${target} is outside it. `
          + "Run the command from the home directory; an operator can grant another root with OMP_WEB_ALLOWED_ROOTS.",
      };
    });
  };
}
