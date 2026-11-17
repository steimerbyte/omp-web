import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { isMCPToolName, xdDeviceName, toolDisplayName } = await jiti.import("./tool-names.ts");

test("isMCPToolName matches only the mcp__ prefix", () => {
  assert.equal(isMCPToolName("mcp__ghidra_mcp_get_functions"), true);
  assert.equal(isMCPToolName("mcp__"), true);
  assert.equal(isMCPToolName("mcp"), false);
  assert.equal(isMCPToolName("write"), false);
  assert.equal(isMCPToolName(""), false);
});

test("xdDeviceName reads the device out of a write/read transport call", () => {
  assert.equal(xdDeviceName("write", { path: "xd://mcp__openrouter_ping", content: "{}" }), "mcp__openrouter_ping");
  assert.equal(xdDeviceName("read", { path: "xd://mcp__openrouter_ping" }), "mcp__openrouter_ping");
  assert.equal(xdDeviceName("write", { file_path: "xd://sudo_run" }), "sudo_run");
  assert.equal(xdDeviceName("read", { path: "xd://lsp/status" }), "lsp");
  assert.equal(xdDeviceName("write", { path: "XD://mcp__openrouter_ping" }), "mcp__openrouter_ping");
});

test("xdDeviceName is null for files, non-transport tools and empty devices", () => {
  assert.equal(xdDeviceName("write", { path: "out/report.html" }), null);
  assert.equal(xdDeviceName("write", { file_path: "/abs/a.ts" }), null);
  assert.equal(xdDeviceName("write", { content: "hi" }), null);
  assert.equal(xdDeviceName("write", undefined), null);
  assert.equal(xdDeviceName("bash", { path: "xd://mcp__x" }), null);
  assert.equal(xdDeviceName("write", { path: "xd://" }), null);
});

test("toolDisplayName shows the device name and leaves other names alone", () => {
  assert.equal(toolDisplayName("write", { path: "xd://mcp__openrouter_ping" }), "mcp__openrouter_ping");
  assert.equal(toolDisplayName("write", { path: "out/report.html" }), "write");
  assert.equal(toolDisplayName("mcp__ghidra_mcp_get_functions", {}), "mcp__ghidra_mcp_get_functions");
});
