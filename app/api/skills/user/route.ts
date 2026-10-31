import { NextResponse } from "next/server";
import { getRequestIdentity } from "@/lib/request-identity";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  createUserSkill,
  ensureTenantSkillsRegistration,
  isValidSkillName,
  listUserSkills,
  MAX_SKILL_DESCRIPTION_CHARS,
  SkillManagerError,
} from "@/lib/skills-manager";

export const dynamic = "force-dynamic";

/**
 * The caller's own skill store.
 *
 * Deliberately a sibling of `/api/skills` rather than a `type=` on it: the
 * existing list is omp's multi-source discovery (`.omp/skills`, plugins,
 * `.agents/skills`, …), while this route answers the different question
 * "which skills belong to *this account*". Mixing the two would make one
 * response mean two things.
 *
 * No admin gate: writing your own account's store is not writing the shared
 * one. `PATCH /api/skills` stays admin-only because it edits any path the
 * process-wide discovery produced, including the operator's.
 */

function failure(error: unknown) {
  if (error instanceof SkillManagerError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = getRequestIdentity(request.headers);
  if (!identity) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  try {
    // Idempotent, and the reason a tenant's sessions see the folder at all:
    // `loadSkills` finds `<agent dir>/skills` only through customDirectories.
    await ensureTenantSkillsRegistration(identity);
    return NextResponse.json(listUserSkills(identity));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = getRequestIdentity(request.headers);
  if (!identity) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await request.json().catch(() => null) as {
      name?: unknown;
      description?: unknown;
    } | null;
    if (!body || typeof body.name !== "string") {
      return NextResponse.json({ error: "name must be a string" }, { status: 400 });
    }
    if (!isValidSkillName(body.name)) {
      return NextResponse.json(
        {
          error:
            "Skill names use lowercase letters, digits and hyphens (1-64 chars, starting with a letter or digit)",
        },
        { status: 400 },
      );
    }
    if (typeof body.description !== "string" || body.description.trim() === "") {
      return NextResponse.json({ error: "description is required" }, { status: 400 });
    }
    if (body.description.trim().length > MAX_SKILL_DESCRIPTION_CHARS) {
      return NextResponse.json(
        { error: `The description is longer than ${MAX_SKILL_DESCRIPTION_CHARS} characters` },
        { status: 400 },
      );
    }

    const skill = createUserSkill(identity, body.name, body.description);
    return NextResponse.json({ skill }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
