import { buildApiKeyProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { requireIdentity } from "@/lib/request-identity";

export const dynamic = "force-dynamic";

// Providers that accept an API key, including dual-auth ones such as anthropic —
// see lib/provider-listing.ts for why membership is capability-based.
//
// Identitaet, nicht Admin — dieselbe Begruendung wie in
// `/api/auth/providers`: reine Lese-Route, kein Geheimnis in der Antwort, aber
// `collectProviderListingInputs` haengt `status.configured` an. Diese Liste
// gehoert dem eingeloggten Konto, das Modell-Anzeige aufbaut, nicht dem
// Betreiber allein.
export async function GET(req: Request) {
  const denied = requireIdentity(req);
  if (denied) return denied;

  const providers = buildApiKeyProviderList(await collectProviderListingInputs());
  return Response.json({ providers });
}
