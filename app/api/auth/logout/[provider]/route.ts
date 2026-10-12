import { invalidateModelsCache } from "@/lib/models-cache";
import { getOmpRuntime, invalidateOmpRuntime } from "@/lib/omp-runtime";
import { requireAdmin } from "@/lib/request-identity";
import { resolveOAuthLoginId } from "@/lib/provider-listing-runtime";

export const dynamic = "force-dynamic";

/**
 * `authStorage.logout()` loescht die gespeicherte Zeile aus dem `agent.db` des
 * Prozesskontos. Das ist dieselbe hostweite resource wie beim Setzen eines
 * API-Schluessels in `app/api/auth/api-key/[provider]`, nur in die andere
 * Richtung — und die Regel ist dieselbe: wer einen fremden Mandanten damit den
 * Betrieb seiner Modelle kappen kann, ist Admin.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const { provider } = await params;
  if (!resolveOAuthLoginId(provider)) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }

  const { authStorage } = await getOmpRuntime();
  const stored = authStorage.listStoredCredentials(provider);
  if (stored.length > 0 && !stored.some((entry) => entry.credential.type === "oauth")) {
    return Response.json({ error: `${provider} is authenticated with an API key, not OAuth` }, { status: 409 });
  }

  await authStorage.logout(provider);
  invalidateModelsCache();
  invalidateOmpRuntime();
  return Response.json({ ok: true });
}
