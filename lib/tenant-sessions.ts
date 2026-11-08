import { chmodSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { getAgentDir, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { isAdminIdentity, type WebIdentity } from "./request-identity";
import { resolveTenantAgentDir } from "./tenant-config";

/**
 * Wo das Session-Archiv eines Kontos liegt.
 *
 * ### Das Problem, das diese Datei loest
 *
 * Das SDK legt jede Session unter `<Agent-Dir>/sessions/<cwd-kodiert>/` ab, und
 * fuer alle Konten ist `<Agent-Dir>` heute dasselbe Prozessverzeichnis. Gemessen
 * am 2026-11-08 (`docs/plans/tenant-isolation.md` §1): das Transcript eines
 * fremden Kontos lag als `0644` da und liess sich aus einer Mandanten-Session
 * vollstaendig lesen — 43 066 Byte, Inhalt „Wetter Berlin". Der Modus ist dabei
 * nur die zweite Haelfte des Befunds: auch eine `0600`-Datei waere lesbar, weil
 * alle Konten dieselbe uid sind.
 *
 * Der Schnitt, der hier gezogen wird, ist deshalb **nicht** der Modus allein,
 * sondern der **Pfad**: ein Nicht-Admin bekommt sein Archiv unter seinem eigenen
 * Agent-Verzeichnis (`resolveTenantAgentDir`), ein Admin bleibt beim
 * Prozessverzeichnis.
 *
 * ### Warum der Admin beim Prozessverzeichnis bleibt
 *
 * `docs/plans/tenant-isolation.md` §9: ein Admin *ist* das Prozesskonto. Sein
 * Bestand an Sessions ist der des Betreibers, er liegt seit jeher im globalen
 * Verzeichnis, und ihn umzuziehen waere eine Migration von Fremdbestand ohne
 * Sicherheitsgewinn — der Admin darf per Definition alles lesen. Die Ausnahme
 * steht bewusst hier und nicht in jeder Aufrufstelle: eine zweite Stelle, die
 * dieselbe Ausnahme macht, ist eine zweite Wahrheit.
 *
 * ### Warum der Bucket-Name vom SDK kommt und nicht hier
 *
 * `SessionManager.getDefaultSessionDir(cwd, agentDir)` ist die Encoding-Regel
 * des SDK: `cwd` → Verzeichnisname, inklusive Legacy-Praefixen, gehashten
 * Varianten und Home-Shadowing, und inklusive der Migrationen, die beim ersten
 * Zugriff laufen. Eine eigene Kopie waere beim naechsten SDK-Update still
 * falsch — und zwar so, dass die Session einfach unsichtbar wird statt zu
 * scheitern. Der einzige eigene Beitrag hier ist der **Elternpfad**.
 *
 * ### Warum 0700/0600 und wo das erzwungen wird
 *
 * Das SDK legt Verzeichnisse mit `fs.mkdirSync(dir, { recursive: true })` und
 * Dateien mit `fs.openSync(path, O_CREAT)` an — also mit der umask des
 * Prozesses. Gemessen auf diesem Host (`umask 0022`): `sessions/` kommt als
 * `755`, der Bucket als `644` und die `.jsonl` als `644` heraus. Der Modus ist
 * damit keine Eigenschaft, die man vom SDK erben kann; er wird hier gesetzt,
 * und zwar an zwei Stellen mit verschiedenen Zeitpunkten:
 *
 * 1. **Vor** dem ersten Schreibzugriff das Verzeichnis (`prepareTenantSessionDir`),
 *    weil `mkdir` mit `mode` nur beim Anlegen wirkt und ein vorhandenes
 *    `0755`-Verzeichnis sonst `0755` bliebe.
 * 2. **Nach** dem Schreiben die Dateien (`tightenTenantSessionTree`), weil das
 *    SDK die Datei selbst oeffnet. Ein `mode` an `open` gibt es dort nicht, und
 *    eine zweite Schreibimplementierung waere genau der Fork, den diese Datei
 *    vermeiden soll.
 *
 * Beides ist idempotent und billig: `chmod` auf einen bereits richtigen Modus
 * ist ein Syscall ohne Aenderung.
 */

/**
 * Das Session-Archiv einer Identitaet, oder `null` wenn keins bestimmbar ist.
 *
 * `null` gibt es nur fuer eine fehlende Identitaet — der interne Startpfad
 * ohne Konto — und fuer einen Admin. Dann bleibt es beim Prozessverzeichnis,
 * weil es keinen Eigentuemer gibt, dessen Verzeichnis gemeint sein koennte, und
 * weil ein Admin das Prozesskonto *ist*. Ein `throw` waere hier falsch: derselbe
 * Aufruf passiert auf dem Admin-Pfad, und ein Fehler dort waere eine
 * Verhaltensaenderung fuer den Betreiber.
 */
export function tenantSessionsRoot(identity: WebIdentity | null): string | null {
  if (!identity) return null;
  if (isAdminIdentity(identity)) return null;
  return join(resolveTenantAgentDir(identity), "sessions");
}

/** Das Agent-Verzeichnis des Mandanten, aus dem sich das Archiv herleitet. */
export function tenantSessionsAgentDir(identity: WebIdentity | null): string | null {
  if (!identity) return null;
  if (isAdminIdentity(identity)) return null;
  return resolveTenantAgentDir(identity);
}

/**
 * Das konkrete Bucket-Verzeichnis fuer `cwd` innerhalb des Mandanten-Archivs.
 *
 * Delegiert an die SDK-Regel; siehe Kopfkommentar. Gibt `null` fuer Admin und
 * fehlende Identitaet — der Aufrufer laesst dann `undefined` an
 * `SessionManager.create`, was exakt das heutige Verhalten ist.
 */
export function tenantSessionDirForCwd(identity: WebIdentity | null, cwd: string): string | null {
  const agentDir = tenantSessionsAgentDir(identity);
  if (agentDir === null) return null;
  return SessionManager.getDefaultSessionDir(cwd, agentDir);
}

/**
 * Das Verzeichnis anlegen und auf `0700` bringen, bevor das SDK hineinschreibt.
 *
 * Gibt den Pfad zurueck, damit der Aufrufer ihn direkt an
 * `SessionManager.create(cwd, dir)` geben kann — die Funktion ist bewusst
 * `string | null` und kein Objekt, weil dieser Wert unveraendert in eine
 * SDK-Signatur geht.
 */
export function prepareTenantSessionDir(
  identity: WebIdentity | null,
  cwd: string,
): string | null {
  const dir = tenantSessionDirForCwd(identity, cwd);
  if (dir === null) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `mode` wirkt nur beim Anlegen. Ein Bucket, den das SDK vorher mit 0755
  // angelegt hat, bliebe sonst der Welt zugaenglich, obwohl der Pfad jetzt
  // richtig ist.
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Ein nicht setzbarer Modus ist kein Grund, die Session zu verweigern: der
    // Pfad ist die Grenze, der Modus ist die zweite Haelfte. Der Zustand ist
    // ueber `tightenTenantSessionTree` und die Tests sichtbar.
  }
  return dir;
}

/**
 * Dateien unter einem Mandanten-Archiv auf `0600` bringen, Verzeichnisse auf `0700`.
 *
 * Bewusst rekursiv und bewusst nachsichtig: eine Datei, die waehrend des Laufs
 * verschwindet (das SDK kompaktiert, verschiebt, raeumt auf), ist kein Fehler.
 * Was nicht mehr da ist, kann nicht mehr gelesen werden.
 *
 * Die Funktion ist der Gegenpol zu `prepareTenantSessionDir` und laeuft nach
 * einem Schreibvorgang. Sie fasst **nur** den uebergebenen Baum an; der Aufrufer
 * entscheidet, welcher das ist, und fuer einen Admin ist es keiner.
 */
export function tightenTenantSessionTree(root: string): { dirs: number; files: number } {
  let dirs = 0;
  let files = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        try {
          chmodSync(full, 0o700);
          dirs += 1;
        } catch { /* verschwunden oder nicht unser Eigentum */ }
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        chmodSync(full, 0o600);
        files += 1;
      } catch { /* siehe oben */ }
    }
  };
  walk(root);
  return { dirs, files };
}

/**
 * Das Prozess-Archiv, als Gegenstueck zum Mandanten-Archiv.
 *
 * Fuer den Admin und fuer den internen Startpfad ohne Konto ist das der Pfad,
 * den das SDK selbst waehlt (`<Agent-Dir>/sessions`). Die Funktion existiert
 * nur, damit ein Aufrufer beide Faelle gleich ausdruecken kann, ohne den
 * `isAdmin`-Test zu wiederholen.
 */
export function processSessionsRoot(): string {
  return join(getAgentDir(), "sessions");
}
