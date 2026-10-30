import { NextResponse } from "next/server";
import { getRequestIdentity, getUserHome, requireIdentity, type WebIdentity } from "@/lib/request-identity";
import { readProjectsFile } from "@/lib/projects-store";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { scheduledTaskErrorResponse } from "@/lib/scheduled-tasks-http";
import {
  assertUsableCwd,
  getScheduledSettingsPath,
  isScheduledSettingsPathAllowed,
  readScheduledSettings,
  writeScheduledSettings,
} from "@/lib/scheduled-settings";

export const dynamic = "force-dynamic";

// GET/PUT /api/scheduled-settings — der Standard-Arbeitsordner des Kontos.
//
// Dieselbe Form wie `app/api/quick-phrases/route.ts`: eine Einstellung pro
// Konto, eine Datei pro Konto, und der Guard aus `lib/request-identity.ts`
// statt einer eigenen Kopie.

/**
 * Die Identitaet, oder `null` — und `null` ist hier schon abgelehnt.
 *
 * Die zweite Schicht: der abgeleitete Pfad wird gegen die Konto-Home geprueft,
 * **bevor** ein Verzeichnis entsteht. `resolveTenantAgentDir` ist die
 * Herleitung, nicht die Abnahme.
 */
function identityFor(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isScheduledSettingsPathAllowed(identity, getScheduledSettingsPath(identity)) ? identity : null;
}

/**
 * Die Antwort mit dem, was der Client zum Anzeigen braucht.
 *
 * `home` steht mit drin, weil `defaultCwd: null` allein nicht sagt, *wohin* der
 * Lauf dann geht. Der Client soll "Home des Kontos" beschriften koennen, ohne
 * die Home zu raten — `/api/home` liefert `os.homedir()`, also die Home des
 * Prozesses, und das ist fuer einen Mieter die falsche.
 *
 * `folders` ist dieselbe Liste fuer beide Stellen, an denen ein Ordner gewaehlt
 * wird (Dialog und Einstellungen): das Projektregister des Kontos plus dessen
 * Home. Der Dialog kann damit ein Auswahlfeld anbieten, ohne `/api/projects`
 * ein zweites Mal zu laden — und die Auswahl ist garantiert eine, die
 * `assertUsableCwd` auch akzeptiert.
 */
function body(identity: WebIdentity, defaultCwd: string | null) {
  const home = getUserHome(identity);
  const projects = readProjectsFile(identity)?.projects.map((project) => project.root) ?? [];
  const folders = [...new Set([home, ...projects])].sort();
  return { defaultCwd, home, folders };
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const denied = requireIdentity(req);
  if (denied) return denied;
  const identity = identityFor(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return NextResponse.json(body(identity, readScheduledSettings(identity).defaultCwd));
}

/**
 * PUT /api/scheduled-settings — den Standardordner setzen oder loeschen.
 *
 * `defaultCwd: null` **loescht** die Angabe; das ist die ausdrueckliche
 * Entscheidung "wieder Home des Kontos" und nicht dasselbe wie ein fehlendes
 * Feld. Ein fehlendes Feld waere ein Client-Fehler, und ihn stillschweigend als
 * "loeschen" zu lesen hiesse, einen Tippfehler als Entscheidung zu verbuchen.
 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const denied = requireIdentity(req);
  if (denied) return denied;
  const identity = identityFor(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }
  if (!("defaultCwd" in raw)) {
    return NextResponse.json({ error: "defaultCwd must be a string or null", field: "cwd" }, { status: 400 });
  }

  try {
    const defaultCwd = assertUsableCwd((raw as Record<string, unknown>).defaultCwd, identity);
    const stored = writeScheduledSettings(identity, defaultCwd);
    return NextResponse.json(body(identity, stored.defaultCwd));
  } catch (error) {
    return scheduledTaskErrorResponse(error);
  }
}
