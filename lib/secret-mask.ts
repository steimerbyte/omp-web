import { resolveSecretsFile } from "./runtime-secrets";
import { sessionKeyFile } from "./web-auth-session";
import { resolveWebAccountsFile, resolveWebAuthFile } from "../bin/web-auth-store.js";

/**
 * Die Dateien, die in **keiner** Grenze lesbar sein duerfen.
 *
 * ### Warum das eine eigene Liste ist
 *
 * `lib/terminal-manager.ts` hatte die vier Pfade inline. Der Agent-Pfad, den
 * `docs/plans/tenant-isolation.md` §7 L1/L2 verlangt, braucht dieselbe Liste —
 * und zwei Listen, die dasselbe meinen, sind zwei Wahrheiten: die naechste
 * Aenderung landet in einer davon, und niemand sieht es, weil die andere
 * weiter funktioniert.
 *
 * ### Was auf der Liste steht und warum
 *
 * | Datei | Warum sie in eine Grenze nicht gehoert |
 * |---|---|
 * | `omp-web.env` (`OMP_WEB_SECRETS_FILE`) | enthaelt `OMP_WEB_PASSWORD`; damit ist man der Betreiber |
 * | `omp-web-auth.json` | die Anmeldedaten des Betreibers |
 * | `omp-web-accounts.json` | die scrypt-Hashes **aller** Konten |
 * | `omp-web-session-key` | mit ihm laesst sich `issueSessionCookie()` fuer jeden Namen nachbauen, auch fuer einen Admin |
 *
 * Gemessen am 2026-11-08 (Plan §1): die vier Dateien lagen mit `0600` unter
 * `/home/pi/.omp/agent`, und der Modus schuetzt nichts, weil alle Konten
 * dieselbe uid sind. Der einzige Schnitt, der dann noch greift, ist der Pfad —
 * die Datei existiert in der Namespace nicht, oder sie wird von einer leeren
 * Datei ueberdeckt.
 *
 * ### Reihenfolge und Duplikate
 *
 * Die Reihenfolge ist stabil (Secrets, Auth, Accounts, Session-Key) und
 * Duplikate sind entfernt: `resolveWebAuthFile` und `resolveWebAccountsFile`
 * koennen in einer Test- oder Sonderinstallation auf denselben Pfad zeigen, und
 * ein doppeltes `--ro-bind` auf dasselbe Ziel ist ein zweiter Mount ohne
 * Wirkung. `Set` haelt beides in einer Zusage.
 */
export interface SecretFilePaths {
  secrets: string;
  auth: string;
  accounts: string;
  sessionKey: string;
}

/** Dieselben vier Pfade, benannt — fuer Diagnose und Tests. */
export function secretFilePaths(env: NodeJS.ProcessEnv = process.env): SecretFilePaths {
  return {
    secrets: resolveSecretsFile(env),
    auth: resolveWebAuthFile(env),
    accounts: resolveWebAccountsFile(env),
    sessionKey: sessionKeyFile(env),
  };
}

/**
 * Die Liste, die in eine Grenze gereicht wird (`maskFiles`).
 *
 * Bewusst **ohne** Filter: ob eine Datei existiert, entscheidet der Aufrufer
 * der Grenze (`planSandboxSpawn` bindet nur existierende Quellen, weil `bwrap`
 * sonst mit `Can't find source path` abbricht). Diese Funktion beantwortet die
 * Frage "welche Pfade muessen verdeckt werden", nicht "welche gibt es".
 */
export function secretMaskFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths = secretFilePaths(env);
  return [...new Set([paths.secrets, paths.auth, paths.accounts, paths.sessionKey])];
}
