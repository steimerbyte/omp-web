import { buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { requireIdentity } from "@/lib/request-identity";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts.
//
// Lese-Route: sie schreibt nichts und gibt kein Geheimnis heraus. Sie braucht
// deshalb **Identitaet, nicht Admin** — die Liste beantwortet "welche Login-
// Wege gibt es ueberhaupt", und das ist eine Eigenschaft des Hosts, nicht des
// Kontos.
//
// Identitaet trotzdem ja, und nicht aus Paranoia: `collectProviderListingInputs`
// haengt `status.configured` und `credentialType` an jeden Eintrag. Das sind
// Angaben ueber die Credentials des Prozesskontos. Anonym waere das eine
// Auskunft darueber, welche Konten der Betreiber bei welchen Anbietern hat.
export async function GET(req: Request) {
  const denied = requireIdentity(req);
  if (denied) return denied;

  const providers = buildOAuthProviderList(await collectProviderListingInputs());
  return Response.json({ providers });
}
