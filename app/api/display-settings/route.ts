import { NextResponse } from "next/server";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getRequestIdentity } from "@/lib/request-identity";
import { getSettingsForIdentity } from "@/lib/omp-runtime";
import { isApiRequestAllowed } from "@/lib/request-security";
import type { DisplaySettings } from "@/lib/settings-api";

export const dynamic = "force-dynamic";

/**
 * The subset of omp settings that changes how the web client renders a
 * transcript. The Settings panel writes these through /api/settings; the
 * client reads them back here instead of pulling the whole settings payload.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
    if (cwd) {
      const allowedRoots = await getAllowedFileRoots(getRequestIdentity(req.headers));
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }
    // The Settings panel writes this value into the caller's `config.yml`.
    // Reading it back from the process singleton made the toggle a no-op for
    // every tenant whose session now uses their own Settings instance.
    const settings = await getSettingsForIdentity(getRequestIdentity(req.headers), cwd);
    const payload: DisplaySettings = {
      hideThinkingBlock: cfgHideThinkingBlock.get(settings) === true,
    };
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
