/**
 * End-to-end verification of the Thunderbird MCP wiring in omp.
 *
 * Runs omp's own discovery + connect path (exactly what a session does) and
 * invokes two real tools against the live Thunderbird profile.
 *
 * Throwaway diagnostic — delete when the wiring is no longer in flux.
 */
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";

const mgr = new MCPManager(process.cwd());
const result = await mgr.discoverAndConnect();

console.log("connected servers:", mgr.getConnectedServers().join(", ") || "(none)");
const errors = Object.entries(result.errors ?? {});
if (errors.length > 0) {
	console.log("connection errors:", JSON.stringify(errors));
}

const tools = mgr.getTools();
const tbTools = tools.filter(t => /^mcp__thunderbird_/i.test(t.name));
console.log(`tools: ${tools.length} total, ${tbTools.length} from thunderbird`);

// MCP bridge tools take (toolCallId, params, onUpdate, ctx, signal) — params is
// the second argument, so calling with args alone sends an empty query.
const invoke = async (tool: string, args: Record<string, unknown>): Promise<string> => {
	const entry = tools.find(t => t.name === `mcp__thunderbird_${tool}`.toLowerCase()) as
		| {
				execute?: (
					id: string,
					params: unknown,
					onUpdate: undefined,
					ctx: unknown,
					signal?: AbortSignal,
				) => Promise<unknown>;
		  }
		| undefined;
	if (!entry?.execute) throw new Error(`tool not registered: ${tool}`);
	const out = (await entry.execute("probe", args, undefined, {})) as {
		content?: Array<{ text?: string }>;
	};
	return String(out?.content?.[0]?.text ?? JSON.stringify(out));
};

const accounts = JSON.parse(await invoke("listAccounts", {})) as Array<{
	id: string;
	name: string;
	identities: Array<{ email: string }>;
}>;
console.log(`\naccounts (${accounts.length}):`);
for (const a of accounts) {
	console.log(`  ${a.id.padEnd(9)} ${a.name} <${a.identities.map(i => i.email).join(", ")}>`);
}

const recent = JSON.parse(
	await invoke("getRecentMessages", { maxResults: 3, daysBack: 14 }),
) as Array<{ subject: string; author: string; date: string; read: boolean }>;
console.log(`\nrecent messages (last 14d, max 3) -> ${recent.length}:`);
for (const m of recent) {
	console.log(`  [${m.read ? "read" : "UNREAD"}] ${m.date.slice(0, 10)}  ${m.author}`);
	console.log(`      ${m.subject}`);
}

const rawHits = await invoke("searchMessages", { query: "Rechnung", countOnly: true });
const hitCount = /"count"\s*:\s*(\d+)/.exec(rawHits)?.[1] ?? "unparsed";
console.log(`\nfull-text search "Rechnung": ${hitCount} hits`);
if (hitCount === "unparsed") console.log("raw:", rawHits.slice(0, 300));

await mgr.disconnectAll();