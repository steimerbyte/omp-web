/**
 * Tool-name predicates shared by the chat views.
 *
 * Pi's built-in names are plain `write` / `edit`, but MCP servers expose the
 * same operations under prefixed or namespaced names, so each predicate also
 * accepts the common decorated forms.
 */

export function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" ||
    name.startsWith("write_") ||
    name.endsWith(".write") ||
    name.endsWith("_write");
}

export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

/**
 * MCP tools register as `mcp__<server>_<tool>` (the SDK's `createMCPToolName`
 * joins the sanitized server and tool with a single underscore). Mirrors the
 * SDK's own `isMCPToolName`.
 */
export function isMCPToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

/** `read` and `write` are the `xd://` transport; everything else only has a path. */
function isXdTransportToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return isWriteToolName(name) || name === "read" || name.endsWith(".read") || name.endsWith("_read");
}

/**
 * The device a `read`/`write` call addressed through the `xd://` transport,
 * or null when the call carried a filesystem path. `write xd://<device>` runs
 * a mounted tool — an MCP tool arrives this way when it is presented under
 * `xd://` instead of the top-level schema.
 */
export function xdDeviceName(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!isXdTransportToolName(toolName) || !input) return null;
  const value = input.path ?? input.file_path;
  if (typeof value !== "string" || !value.toLowerCase().startsWith("xd://")) return null;
  const name = value.slice("xd://".length).split(/[/?#]/)[0].trim();
  return name.length > 0 ? name : null;
}

/** The name a tool call should be shown under: its device name when bridged. */
export function toolDisplayName(toolName: string, input: Record<string, unknown> | undefined): string {
  return xdDeviceName(toolName, input) ?? toolName;
}
