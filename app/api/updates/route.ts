import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { requireAdmin } from "@/lib/request-identity";
import { getOmpWebUpdateStatus, installOmpWebUpdate } from "@/lib/omp-updates";
import { redactNpxOutput } from "@/lib/npx";

export const dynamic = "force-dynamic";

/**
 * Nur die POST-Methode aendert etwas, das dem ganzen Host gehoert: sie ruft
 * `installOmpWebUpdate` auf, ein `npx`, das den **laufenden** Server ersetzt.
 * Jedes angemeldete Konto ein Update ausloesen zu lassen heisst, dass ein
 * Mandant den Betreiber zum Installieren einer Version bewegen kann, die er
 * geprueft und freigegeben hat — also Admin.
 *
 * GET bleibt offen. `getOmpWebUpdateStatus()` liest die lokale Paketversion und
 * den Git-Zustand, schreibt nichts und legt kein Geheimnis offen; es ist der
 * Status fuer die Update-Anzeige, die jedes Konto sehen darf. Die Route
 * beantwortet damit genau die Frage, die nicht hostweit ist.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const status = await getOmpWebUpdateStatus();
    return NextResponse.json(status, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message || "Unable to check for updates" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const status = await getOmpWebUpdateStatus();
    if (!status.install.canInstall) {
      return NextResponse.json(
        {
          error: "No installable omp-web update is available",
          status,
        },
        { status: 409 },
      );
    }

    const result = await installOmpWebUpdate({ manager: status.install.manager });
    return NextResponse.json({
      success: true,
      output: result.output,
      restartRequired: status.install.restartRequired,
      installedVersion: status.install.packageVersion,
      command: status.install.command,
    });
  } catch (error: unknown) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const output = redactNpxOutput(`${detail.stdout ?? ""}${detail.stderr ?? ""}`).trim();
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: output || message || "Unable to install the update",
      },
      { status: 500 },
    );
  }
}

