/**
 * Register the Thunderbird MCP server in omp's user-level mcp.json using omp's
 * own writer, so the file matches exactly what `/api/mcp` produces.
 *
 * Transport is HTTP, not stdio: the thunderbird-mcp add-on serves MCP directly
 * from inside its container. Going through mcp-bridge.cjs would add a process
 * whose only job is re-reading a connection file that lives in the container's
 * /tmp and is therefore unreachable from the host.
 */
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import {
	addMCPServer,
	listMCPServers,
	removeMCPServer,
} from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

const NAME = "thunderbird";
const configPath = getMCPConfigPath("user");

// Must match extensions.thunderbird-mcp.stableAuthToken in the container
// profile's user.js — the add-on regenerates its token per boot otherwise, and
// the bearer header would silently start failing with 403.
const TOKEN = "b9322d02ee8920b00ee920741e9f9bcfd62ef6389e5d5dc5c93677c78626e696";

const existing = await listMCPServers(configPath);
if (existing.includes(NAME)) {
	await removeMCPServer(configPath, NAME);
	console.log(`removed stale "${NAME}"`);
}

const config: MCPServerConfig = {
	enabled: true,
	type: "http",
	url: "http://127.0.0.1:8765/",
	headers: {
		Authorization: `Bearer ${TOKEN}`,
	},
	timeout: 180_000,
};

await addMCPServer(configPath, NAME, config);
console.log(`registered "${NAME}" in ${configPath}`);
console.log(`servers now: ${(await listMCPServers(configPath)).join(", ")}`);