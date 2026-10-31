import { NextResponse } from "next/server";
import { getRequestIdentity } from "@/lib/request-identity";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  deleteUserSkill,
  readUserSkill,
  SkillManagerError,
  writeUserSkill,
} from "@/lib/skills-manager";

export const dynamic = "force-dynamic";

/**
 * One skill in the caller's own store, addressed by name only.
 *
 * The name is validated against the managed-skill rule before it is joined to
 * any path (`^[a-z0-9][a-z0-9-]{0,63}$`): no `/`, no `\`, no `..`, no absolute
 * path, no encoded separator after Next has decoded the segment. A tenant who
 * names another tenant's skill gets **404**, because the path is derived from
 * their own agent directory and simply does not contain it — the existence of
 * a foreign skill is never confirmed.
 */

type Params = { params: Promise<{ name: string }> };

function failure(error: unknown) {
  if (error instanceof SkillManagerError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

export async function GET(request: Request, { params }: Params) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = getRequestIdentity(request.headers);
  if (!identity) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  try {
    const { name } = await params;
    const result = readUserSkill(identity, name);
    if (!result) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request, { params }: Params) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = getRequestIdentity(request.headers);
  if (!identity) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const { name } = await params;
    const body = await request.json().catch(() => null) as {
      content?: unknown;
      expectedMtimeMs?: unknown;
    } | null;
    if (typeof body?.content !== "string") {
      return NextResponse.json({ error: "content must be a string" }, { status: 400 });
    }
    const expectedMtimeMs =
      typeof body.expectedMtimeMs === "number" && Number.isFinite(body.expectedMtimeMs)
        ? body.expectedMtimeMs
        : null;
    const skill = writeUserSkill(identity, name, body.content, expectedMtimeMs);
    return NextResponse.json({ ok: true, skill });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = getRequestIdentity(request.headers);
  if (!identity) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  try {
    const { name } = await params;
    const directory = deleteUserSkill(identity, name);
    return NextResponse.json({ ok: true, directory });
  } catch (error) {
    return failure(error);
  }
}
