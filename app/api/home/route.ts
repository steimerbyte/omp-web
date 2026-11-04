import { NextResponse } from "next/server";
import os from "os";
import { getRequestIdentity, getUserHome, isAdminIdentity } from "@/lib/request-identity";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // The home the UI displays is the account's, not the process user's. `null`
  // (open mode) and admin keep `homedir()`: for them the account root is `/`,
  // and `/` is not a home (`SessionSidebar.displayCwd` would prefix every
  // absolute path with `~`).
  const identity = getRequestIdentity(req.headers);
  return NextResponse.json({
    home: identity !== null && !isAdminIdentity(identity) ? getUserHome(identity) : os.homedir(),
  });
}
