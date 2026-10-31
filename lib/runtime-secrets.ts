import { existsSync } from "node:fs";
import {
  DEFAULT_SECRETS_FILE,
  clearEnvironmentFileCache,
  readEnvironmentFile,
  resolveSecretsFile,
} from "../bin/web-auth-store.js";

/**
 * Wo die Geheimnisse des Dienstes herkommen, und warum nicht aus der Umgebung.
 *
 * Die Umgebung des Dienstes ist keine Ablage, sondern eine Vererbung. Gemessen
 * auf Bun 1.4.4 (`SHELL-ISOLATION-SCAN.md` §2b und der Brush-Probe danach):
 * `delete process.env.X` nimmt den Wert aus `process.env`, aber **nicht** aus
 * `/proc/self/environ` und nicht aus den Kindern, die ohne explizite env-Map
 * starten. Genau so starten der Agent-`bash`-Tool (die Brush-Shell laeuft im
 * Prozess und liest die native Umgebung) und die MCP-stdio-Server des SDK. Ein
 * `Environment=` in der systemd-Unit ist damit ein Geheimnis, das jeder Mandant
 * in `env` sieht — gemessen `BRAVE_API_KEY`, `OPENROUTER_API_KEY`,
 * `OMP_WEB_PASSWORD` in einer Mandanten-Shell.
 *
 * Der einzige Schnitt, der wirklich greift, ist: der Wert existiert nie in der
 * Umgebung. Deshalb liest der Dienst seine Geheimnisse selbst aus einer Datei
 * (`OMP_WEB_SECRETS_FILE`, Vorgabe `/etc/omp-web.env`) und haelt sie in einem
 * Modulwert. Die Unit darf dafuer **weder** `Environment=` **noch**
 * `EnvironmentFile=` benutzen — beide schreiben in die Umgebung.
 *
 * Gelesen wird in `bin/web-auth-store.js`: derselbe Parser muss auch im
 * Launcher laufen, und der kann kein TypeScript laden.
 */

export { DEFAULT_SECRETS_FILE, resolveSecretsFile };

/** Die Geheimnisse aus der Datei. Einmal gelesen (mtime-gecacht), nie in `process.env`. */
export function runtimeSecrets(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  return readEnvironmentFile(resolveSecretsFile(env));
}

/** Nur fuer Tests: den Cache verwerfen, nachdem die Datei umgeschrieben wurde. */
export function __resetRuntimeSecretsCache(): void {
  clearEnvironmentFileCache();
}

/**
 * Der Wert eines Geheimnisses, fuer den Moment des Verbrauchs.
 *
 * Die Datei schlaegt die Umgebung. In einer Installation, die noch
 * `Environment=` benutzt, ist beides derselbe Wert; nach der Umstellung gibt es
 * nur noch die Datei.
 */
export function getRuntimeSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromFile = runtimeSecrets(env).get(name);
  if (typeof fromFile === "string" && fromFile.length > 0) return fromFile;
  const inherited = env[name];
  return typeof inherited === "string" && inherited.length > 0 ? inherited : undefined;
}

/**
 * Die Umgebung, gegen die die Passwort-Pruefung laeuft.
 *
 * `bin/web-auth-store.js` liest `OMP_WEB_PASSWORD` aus der env, die es bekommt.
 * Statt jede Aufrufstelle zu aendern, bekommt sie hier die env, die den Wert
 * aus der Datei traegt — der Prozess-Environment bleibt unberuehrt.
 */
export function webAuthEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const password = getRuntimeSecret("OMP_WEB_PASSWORD", env);
  return password === undefined ? env : { ...env, OMP_WEB_PASSWORD: password };
}

/**
 * Namen, deren Wert nie an ein Kind gehen darf. Das Muster ist derselbe
 * Sperrfilter, den `lib/npx.ts` schon fuer `npx` benutzt; dort schuetzt er
 * Paketcode, hier jeden Prozess, den die App startet.
 */
const SENSITIVE_NAME_RE = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|AUTH|KEY)(?:$|_)/i;

export function isSecretEnvName(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return SENSITIVE_NAME_RE.test(name) || runtimeSecrets(env).has(name);
}

/**
 * Die Umgebung fuer einen Kindprozess, den die App selbst startet.
 *
 * Der Aufruf baut bewusst eine **eigene Map** statt `process.env` zu bearbeiten:
 * gemessen wirkt eine Map, ein `delete` nicht (§2b, Fall C gegen Fall B).
 * `du`, `git`, `npx`, der Export-CLI und die Skill-Aktualisierung bekommen
 * damit eine Umgebung ohne jeden Schluessel, der wie ein Geheimnis heisst.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isSecretEnvName(name, base)) continue;
    env[name] = value;
  }
  // `ProcessEnv` verlangt in dieser Installation ein `NODE_ENV`, weil Next das
  // Interface erweitert. Ein Kindprozess braucht es nicht, und ein gesetzter
  // Platzhalter waere eine Luege. Deshalb der eine Cast an dieser Stelle statt
  // einem an jeder Aufrufstelle.
  return env as NodeJS.ProcessEnv;
}

/**
 * Welche Geheimnisse die Umgebung dieses Prozesses noch erbt.
 *
 * Nicht leer heisst: die Unit setzt weiter `Environment=`, und jeder Pfad ohne
 * eigene env-Map (Agent-Shell, MCP-stdio) traegt sie. Der Start loggt das, weil
 * es sich von aussen nicht erkennen laesst — `sandboxed: true` sagt nichts
 * darueber, was in der Umgebung steht.
 */
const PATH_LIKE_NAME_RE = /_(?:FILE|DIR|PATH|SOCK)$/i;

export function inheritedSecretNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && env[name] !== "")
    .filter((name) => isSecretEnvName(name, env))
    // `OMP_WEB_AUTH_FILE` und `SSH_AUTH_SOCK` heissen nach einem Geheimnis, sind
    // aber Pfade: der Wert ist kein Secret, das man in eine Datei verschieben
    // koennte. Sie aus Kindern zu entfernen ist trotzdem richtig (`childEnv`),
    // nur die Warnung „das steckt in der Umgebung" waere hier falsch.
    .filter((name) => !PATH_LIKE_NAME_RE.test(name))
    .sort();
}

/** Gibt es ueberhaupt eine Geheimnisdatei? Fuer die Diagnose im Log. */
export function secretsFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(resolveSecretsFile(env));
}
