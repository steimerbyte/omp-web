import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getOmpRuntime, invalidateOmpRuntime } from "@/lib/omp-runtime";
import { requireAdmin, requireIdentity } from "@/lib/request-identity";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

/**
 * Der Modellschluessel ist **prozessweit**, nicht pro Konto.
 *
 * `authStorage.set()` schreibt in das `agent.db` des Prozesskontos — dieselbe
 * Datei, aus der `omp` auf der Kommandozeile liest. Es gibt fuer diese Route
 * keine Mandanten-Alternative: `lib/tenant-config.ts` hat `resolveTenantAgentDir`
 * zwar schon, aber die Route benutzt den Prozess-Runtime aus `getOmpRuntime()`,
 * also das globale Verzeichnis. Solange das so ist, gehoert der Schluessel dem
 * Betreiber und nicht dem anfragenden Konto, und ein Schreibzugriff darauf ist
 * eine hostweite Aenderung: **Admin**.
 *
 * Das ist die ehrliche Antwort fuer die heutige Ablage. Die Alternative waere,
 * hier `requireIdentity` zu setzen und damit den Befund bestehen zu lassen —
 * ein Mandant, der seinen "eigenen" Schluessel eintraegt, verdraendert das
 * Guthaben des Betreibers. Beides gleichzeitig waere nicht moeglich: solange
 * eine Zeile fuer alle gilt, ist "mein Schluessel" eine Behauptung des Clients
 * und keine Eigenschaft des Datensatzes.
 *
 * Was die Umstellung auf echten Mandantenbesitz kostet, steht in
 * `lib/omp-runtime.ts`: es gibt dort `getSettingsForIdentity` fuer die
 * `config.yml` je Konto, aber noch kein Gegenstueck fuer `AuthStorage` und
 * `ModelRegistry`. Bis dahin ist Admin die richtige Rolle und nicht die
 * bequemere.
 */

// GET /api/auth/api-key/[provider] — returns auth status (never returns the actual key)
export async function GET(req: Request, { params }: Params) {
  const denied = requireIdentity(req);
  if (denied) return denied;

  const { provider } = await params;
  const { modelRegistry, authStorage } = await getOmpRuntime();
  const origin = authStorage.keys.source(provider);
  const models = modelRegistry.getAll().filter((model) => model.provider === provider).length;
  return NextResponse.json({
    provider,
    displayName: provider,
    // `keys.source` is the whole cascade answer (runtime → config → OAuth →
    // login key → env → stored key), so "configured" is that answer existing.
    // `keys.keyless` adds the keyless-mode marker, which `source` skips but
    // which the old `hasAuth` counted as a stored credential.
    configured: origin !== undefined || authStorage.keys.keyless(provider),
    source: origin?.kind,
    models,
  });
}

// POST /api/auth/api-key/[provider]  body: { apiKey: string }
export async function POST(req: Request, { params }: Params) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const { provider } = await params;
  try {
    const { apiKey } = await req.json() as { apiKey?: string };
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
    }
    const { modelRegistry, authStorage } = await getOmpRuntime();
    if (!modelRegistry.hasProvider(provider)) {
      return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
    }
    // omp stores one row per credential in `agent.db`; writing through
    // `credentials.set` keeps the CLI and omp-web on the same store and lock.
    await authStorage.credentials.set(provider, { type: "api_key", key: apiKey.trim(), source: "login" });
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/auth/api-key/[provider] — removes stored API keys
export async function DELETE(req: Request, { params }: Params) {
  // Loeschen ist derselbe Zugriff wie Setzen, nur in die andere Richtung: es
  // nimmt dem Prozesskonto den Schluessel, mit dem es seine Modelle bezahlt.
  // Wer setzen darf, muss loeschen duerfen — sonst koennte ein Admin den
  // Betrieb wiederherstellen, ein Mandant ihn aber weiter zerstoeren.
  const denied = requireAdmin(req);
  if (denied) return denied;

  const { provider } = await params;
  try {
    const { authStorage } = await getOmpRuntime();
    const stored = authStorage.credentials.list(provider);
    if (stored.some((entry) => entry.credential.type === "oauth")) {
      return NextResponse.json(
        { error: `${provider} is authenticated with OAuth, not an API key` },
        { status: 409 },
      );
    }
    await authStorage.credentials.remove(provider);
    invalidateModelsCache();
    invalidateOmpRuntime();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
