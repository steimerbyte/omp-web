import type { SubagentSnapshot } from "./types";

/** The one definition of "active", shared by the panel's groups and the pill's count. */
export function isSubagentActive(subagent: Pick<SubagentSnapshot, "status">): boolean {
  return subagent.status === "pending" || subagent.status === "running";
}

/**
 * Rows spawned by one task batch share `parentToolCallId`; keep a batch's rows
 * adjacent without inventing a hierarchy the flat roster does not carry.
 * Reorders only: every input row comes back exactly once.
 */
export function groupSubagentRows(subagents: SubagentSnapshot[]): SubagentSnapshot[] {
  const batches = new Map<string, SubagentSnapshot[]>();
  for (const subagent of subagents) {
    const key = subagent.parentToolCallId ?? `id:${subagent.id}`;
    const batch = batches.get(key);
    if (batch) batch.push(subagent);
    else batches.set(key, [subagent]);
  }
  return [...batches.values()].flat();
}
