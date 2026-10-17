import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import {
	addMCPServer,
	listMCPServers,
	removeMCPServer,
} from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

const NAME = "minimax";
const configPath = getMCPConfigPath("user");

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
	console.error("MINIMAX_API_KEY not set in env — refusing to write an empty credential");
	process.exit(1);
}

const config: MCPServerConfig = {
	enabled: true,
	type: "stdio",
	command: "/home/pi/.npm-global/bin/minimax-mcp-js",
	args: [],
	env: {
		MINIMAX_API_HOST: "https://api.minimax.io",
		MINIMAX_API_KEY: apiKey,
		MINIMAX_MCP_BASE_PATH: "/home/pi/workspace/generated-images/minimax",
		MINIMAX_RESOURCE_MODE: "local",
	},
	timeout: 180000,
};

const existing = await listMCPServers(configPath);
if (existing.includes(NAME)) {
	await removeMCPServer(configPath, NAME);
	console.log(`replaced existing "${NAME}"`);
}
await addMCPServer(configPath, NAME, config);
console.log(`registered "${NAME}" -> ${configPath}`);
console.log("servers:", (await listMCPServers(configPath)).join(", "));