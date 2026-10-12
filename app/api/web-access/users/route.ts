import { NextResponse } from "next/server";
import {
  createWebAccount,
  listWebAccounts,
  resolveHomeRoot,
  setWebAccountEnabled,
  setWebAccountPassword,
  setWebAccountRole,
  validateAccountName,
  validatePassword,
} from "@/bin/web-auth-store.js";
import { hasJsonContentType } from "@/lib/request-security";
import { requireAdmin } from "@/lib/request-identity";

/**
 * Kontenverwaltung, ausschliesslich fuer Admins.
 *
 * Warum hier und nicht in `/api/settings`: diese Route ist der einzige Ort, an
 * dem Rechte vergeben werden, und sie gehoert nicht in die allgemeine
 * Einstellungsverwaltung, die ein anderer Agent parallel umbaut. Sie haengt
 * sich stattdessen an `/api/web-access/*`, wo die Nachbarschaft stimmt — das
 * sind die anderen Zugangskontroll-Routen (`/login`, `/recovery`).
 *
 * Drei Regeln, die jede Aktion hier einhalten muss:
 *
 *  1. **Wer Admin ist, wird aus der Identitaet gelesen, nie aus einem
 *     Request-Feld.** Die Identitaet kommt aus dem Header, den `proxy.ts` nach
 *     dem Pruefen der Anmeldedaten gesetzt hat. Die neue Aktion `set-admin`
 *     aendert daran nichts: ihr `body.isAdmin` ist kein Anspruch des Aufrufers,
 *     sondern die **Zielrolle eines anderen Kontos**. Genau diese Unterscheidung
 *     ist der Grund, warum die Regel hier noch gilt und nicht faellt — ein
 *     Aufrufer kann eine Rolle nur setzen, weil er selbst durch `requireAdmin`
 *     gekommen ist, und `requireAdmin` steht vor jeder Verzweigung in diesem
 *     Handler, nicht in der Rolle.
 *  2. **Kein Klartext-Passwort in der Antwort.** Zurueck kommt der Eintrag mit
 *     dem scrypt-Digest, genau in dem Format, in dem er gespeichert liegt —
 *     sonst steht das Passwort im Terminal-Scrollback des Admins und danach in
 *     irgendeinem Log.
 *  3. **Kein Self-Service und keine Registrierungsroute.** Es gibt genau einen
 *     Weg, auf dem ein Konto entsteht, und der laeuft durch diese Datei. Wer sich
 *     anmelden kann, muss vorher hier eingetragen worden sein.
 *
 * Die Sperren des Stores — letzter Admin, `OMP_WEB_ADMINS` — stehen in
 * `bin/web-auth-store.js` und nicht hier. Diese Datei ist der einzige *heutige*
 * Aufrufer, nicht der einzige moegliche; eine Sperre, die an einem Aufrufer
 * haengt, verschwindet mit dem naechsten.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type AccountAction = "set-password" | "set-enabled" | "set-admin";

/** Die Aktionen, die es gibt. Ein Lookup, keine Liste zum Durchiterieren. */
const ACCOUNT_ACTIONS: Record<string, AccountAction> = {
  "set-password": "set-password",
  "set-enabled": "set-enabled",
  "set-admin": "set-admin",
};

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const list = listWebAccounts();
  if (list.status === "unreadable") {
    return NextResponse.json(
      { error: `The account file at ${list.file} could not be read. Repair or remove it.` },
      { status: 500, headers: NO_STORE },
    );
  }
  return NextResponse.json(
    {
      // `WebAccount` traegt den scrypt-Digest, nicht das Passwort. Der Store
      // kann das Klartext gar nicht liefern, es wurde beim Anlegen zu einem
      // Digest gehasht und danach nie gespeichert — deshalb steht hier kein
      // Filter, der Felder wegnimmt, sondern genau der Datensatz, der auch auf
      // der Platte liegt.
      accounts: list.accounts,
      homeRoot: resolveHomeRoot(),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json() as { username?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  // Reihenfolge: erst der Name, dann das Passwort. `validateAccountName` ist die
  // Absicherung gegen `../etc` und `a/b` — es muss *vor* jedem `mkdir` laufen,
  // und `createWebAccount` prueft es ein zweites Mal, direkt bevor es das
  // Verzeichnis anlegt. Ein 400 hier darf kein Verzeichnis hinterlassen.
  if (typeof body.username !== "string" || body.username.trim() !== body.username) {
    return NextResponse.json(
      { error: "The username cannot start or end with a space." },
      { status: 400 },
    );
  }
  const invalidName = validateAccountName(body.username);
  if (invalidName) return NextResponse.json({ error: invalidName }, { status: 400 });

  if (typeof body.password !== "string") {
    return NextResponse.json({ error: "A password is required." }, { status: 400 });
  }
  const invalidPassword = validatePassword(body.password);
  if (invalidPassword) return NextResponse.json({ error: invalidPassword }, { status: 400 });

  try {
    return NextResponse.json(
      { account: createWebAccount(body.username, body.password) },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}

export async function PATCH(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  }

  let body: { action?: unknown; username?: unknown; password?: unknown; enabled?: unknown; isAdmin?: unknown };
  try {
    body = await request.json() as {
      action?: unknown;
      username?: unknown;
      password?: unknown;
      enabled?: unknown;
      isAdmin?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? ACCOUNT_ACTIONS[body.action] : undefined;
  if (action === undefined) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  if (typeof body.username !== "string" || validateAccountName(body.username) !== null) {
    return NextResponse.json({ error: "A valid username is required." }, { status: 400 });
  }

  try {
    if (action === "set-enabled") {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "`enabled` must be true or false." }, { status: 400 });
      }
      return NextResponse.json(
        { account: setWebAccountEnabled(body.username, body.enabled) },
        { headers: NO_STORE },
      );
    }

    if (action === "set-admin") {
      // `boolean` und nichts anderes. Ein `"true"` als String, eine Zahl oder
      // `null` waeren hier ein Weg, auf dem eine Rolle unklar bleibt und der
      // Store trotzdem schreibt — die Ablehnung ist billig und eindeutig.
      if (typeof body.isAdmin !== "boolean") {
        return NextResponse.json({ error: "`isAdmin` must be true or false." }, { status: 400 });
      }
      // Der Store entscheidet, ob das geht (letzter Admin, `OMP_WEB_ADMINS`) und
      // wirft mit einer Erklaerung. Der `catch` unten macht daraus eine 400 mit
      // genau diesem Text — dieselbe Antwort wie bei `set-enabled`, damit die
      // Oberflaeche fuer beide Sperren einen Pfad hat und nicht zwei.
      return NextResponse.json(
        { account: setWebAccountRole(body.username, body.isAdmin) },
        { headers: NO_STORE },
      );
    }

    if (typeof body.password !== "string") {
      return NextResponse.json({ error: "A password is required." }, { status: 400 });
    }
    const invalidPassword = validatePassword(body.password);
    if (invalidPassword) return NextResponse.json({ error: invalidPassword }, { status: 400 });
    return NextResponse.json(
      { account: setWebAccountPassword(body.username, body.password) },
      { headers: NO_STORE },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
