import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { getUserHome, type WebIdentity } from "./request-identity";
import { ScheduledTaskError } from "./scheduled-tasks-store";
import { resolveTenantAgentDir } from "./tenant-config";

/**
 * Der Standard-Arbeitsordner fuer geplante Aufgaben (eine Datei pro Konto) und
 * die Pruefung, die jeder gewaehlte Ordner besteht — der der Aufgabe wie der
 * des Kontos.
 *
 * ### Warum eine eigene Datei und nicht ein Feld in `config.yml`
 *
 * `config.yml` gehoert omp. Ein Feld dort waere eine Einstellung, die omp beim
 * naechsten Speichern nicht kennt und weglaesst. Dieselbe Begruendung wie in
 * `lib/quick-phrases-store.ts`: eine `omp-web-`-Datei im Agent-Verzeichnis,
 * die omp nie liest.
 *
 * ### Warum die Pruefung die Grenze des Aufgabenspeichers erweitert statt sie zu ersetzen
 *
 * `assertCwd` in `lib/scheduled-tasks-store.ts` prueft synchron: absolut und
 * innerhalb der Konto-Home. Das ist die Schicht, die auch den *Lesepfad*
 * schuetzt, wenn jemand die Datei von Hand bearbeitet. Was ihr fehlt, steht
 * hier: dass der Ordner existiert, ein Verzeichnis ist und im Bestand des
 * Kontos liegt — und dafuer braucht man die Sitzungsliste, also `async`.
 *
 * Zwei Grenzen, aber eine Richtung: diese hier ist **enger** als `assertCwd`,
 * nie weiter. Der Speicher prueft danach noch einmal, und eine Anfrage, die
 * hier durchkommt, kann dort nicht mit einer anderen Meldung scheitern.
 */
const STORE_FILE = "omp-web-scheduled-settings.json";

/** Was in der Datei steht. `defaultCwd: null` heisst "Home des Kontos". */
export interface ScheduledSettings {
  schemaVersion: 1;
  /** Absolut und innerhalb der Konto-Home, oder `null`. */
  defaultCwd: string | null;
}

/** Der Pfad der Einstellungsdatei einer Identitaet. */
export function getScheduledSettingsPath(identity: WebIdentity): string {
  return join(resolveTenantAgentDir(identity), STORE_FILE);
}

/** `true`, wenn der Pfad der Einstellungsdatei unter der Konto-Home liegt. */
export function isScheduledSettingsPathAllowed(identity: WebIdentity, path: string): boolean {
  return isPathWithinRoots(path, new Set([getUserHome(identity)]));
}

/**
 * Die gespeicherte Einstellung; `defaultCwd: null` bei fehlender oder kaputter
 * Datei.
 *
 * Wirft nie. Der Aufrufer ist auch der Zeitplaner, und eine Ausnahme beim Lesen
 * einer *Vorliebe* wuerde einen ganzen Durchlauf beenden. Eine Datei mit
 * falscher Form oder mit einem Pfad ausserhalb der Konto-Home faellt deshalb
 * auf `null` zurueck — den Zustand vor jeder Einstellung.
 *
 * Die Grenze wird auch beim Lesen geprueft, nicht nur beim Schreiben: eine von
 * Hand bearbeitete Datei geht an jeder API-Pruefung vorbei, und ein Lauf in
 * fremder Home erzeugt eine Sitzung, die `lib/session-reader.ts` einem anderen
 * Konto zurechnet.
 */
export function readScheduledSettings(identity: WebIdentity): ScheduledSettings {
  const path = getScheduledSettingsPath(identity);
  if (!existsSync(path)) return { schemaVersion: 1, defaultCwd: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { schemaVersion: 1, defaultCwd: null };
    const raw = (parsed as Record<string, unknown>).defaultCwd;
    if (typeof raw !== "string" || raw === "" || !isAbsolute(raw)) return { schemaVersion: 1, defaultCwd: null };
    if (!isPathWithinRoots(raw, new Set([getUserHome(identity)]))) return { schemaVersion: 1, defaultCwd: null };
    return { schemaVersion: 1, defaultCwd: raw };
  } catch {
    return { schemaVersion: 1, defaultCwd: null };
  }
}

/** Schreibt die Einstellung atomar und mit `0o600`, wie die anderen Speicher. */
export function writeScheduledSettings(identity: WebIdentity, defaultCwd: string | null): ScheduledSettings {
  const path = getScheduledSettingsPath(identity);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stored: ScheduledSettings = { schemaVersion: 1, defaultCwd };
  writePrivateFileAtomicSync(path, JSON.stringify(stored, null, 2) + "\n");
  return stored;
}

/**
 * Der gepruefte Arbeitsordner; `null` fuer "keine Angabe".
 *
 * Der Fehler ist ein `ScheduledTaskError("cwd", …)`, damit `POST`, `PATCH` und
 * die Einstellungen ihn ueber `scheduledTaskErrorResponse` als `400` mit
 * `field: "cwd"` beantworten — dieselbe Form, die `name` und `cron` schon
 * haben.
 *
 * ### Warum die Grenze genau die Konto-Home ist
 *
 * `assertCwd` im Aufgabenspeicher zieht dieselbe Grenze, und `withAllowedCwd`
 * verwirft beim Lesen jeden `cwd` ausserhalb davon. Eine *weitere* Grenze hier
 * — etwa `getAllowedFileRoots`, das auch Projektordner ausserhalb der Home
 * kennt — wuerde einen Pfad speichern, den der Speicher beim naechsten Lesen
 * stillschweigend wegwirft. Der Lauf fiele dann ohne Meldung auf die Home
 * zurueck, obwohl der Nutzer einen Ordner gewaehlt und "gespeichert" gesehen
 * hat. Warum der Speicher so streng ist, steht dort: der *Besitz* einer
 * Sitzung wird aus ihrem `cwd` abgeleitet (`lib/session-reader.ts`), ein Lauf
 * in fremder Home waere eine Sitzung eines anderen Kontos.
 *
 * Es gibt also eine Grenze, nicht zwei: dieselbe wie im Speicher, hier nur um
 * die Fragen erweitert, die der Speicher nicht beantworten kann (existiert,
 * ist ein Verzeichnis, kein Symlink-Ausbruch).
 *
 * Die Reihenfolge ist die der Frage "darf dieser Aufrufer hier starten": erst
 * die Form (absolut), dann die Grenze (lexikalisch, ohne die Platte
 * anzufassen), dann der Bestand, zuletzt die aufgeloeste Grenze gegen
 * Symlinks. Die Grenze steht bewusst **vor** dem Bestand: andernfalls verriete
 * der Unterschied zwischen "gibt es nicht" und "ist kein Verzeichnis", was
 * ausserhalb der Home liegt.
 */
export function assertUsableCwd(value: unknown, identity: WebIdentity): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ScheduledTaskError("cwd", "The working directory must be a string");
  const cwd = value.trim();
  if (cwd === "") return null;
  if (!isAbsolute(cwd)) throw new ScheduledTaskError("cwd", "The working directory must be an absolute path");

  const roots = new Set([getUserHome(identity)]);
  if (!isPathWithinRoots(cwd, roots)) {
    throw new ScheduledTaskError("cwd", "The working directory must be inside your home directory");
  }

  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new ScheduledTaskError("cwd", "The working directory must be an existing directory");
  }
  if (!isDirectory) throw new ScheduledTaskError("cwd", "The working directory must be a directory");
  if (!isExistingPathWithinRoots(cwd, roots)) {
    // Ein Symlink, der aus der Home herauszeigt: lexikalisch drinnen, echt draussen.
    throw new ScheduledTaskError("cwd", "The working directory must be inside your home directory");
  }
  return cwd;
}
