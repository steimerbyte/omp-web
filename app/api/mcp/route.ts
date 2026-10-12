import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { NextResponse } from "next/server";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { setMcpServerEnabled } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getRequestIdentity, isAdminIdentity, type WebIdentity } from "@/lib/request-identity";
import { resolveTenantAgentDir } from "@/lib/tenant-config";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import type { McpConfigResponse, McpScopeConfig, McpServerConfig, McpServerEntry } from "@/lib/settings-api";

export const dynamic = "force-dynamic";

/**
 * MCP-Konfiguration: pro Projekt mandantenfaehig, auf Prozessebene Admin-only.
 *
 * ### Der Befund, den diese Datei einmal hatte
 *
 * `configPath` las fuer `scope: "user"` `getAgentDir()` — das Agent-Verzeichnis
 * des **Prozesskontos** — und `validatedCwd` rief `getRequestIdentity` nur dann
 * auf, wenn ueberhaupt ein `cwd`-Parameter mitkam. `PUT` mit
 * `{ scope: "user" }` und ohne `cwd` lief damit durch *keine* Identitaets- und
 * *keine* Mandantenpruefung: jedes angemeldete Konto, auch ein Nicht-Admin,
 * schrieb in die gemeinsame `mcp.json` aller. Ein Eintrag darin traegt `command`,
 * `args` und `env`, und MCP-Server werden als Kindprozesse gestartet — das war
 * ein Schreibpfad in eine prozessweite Ausfuehrungskonfiguration.
 *
 * ### Warum das nicht `requireIdentity` sein kann
 *
 * `lib/tenant-config.ts` hat `resolveTenantAgentDir` schon, und der naheliegende
 * Fix waere gewesen, `scope: "user"` darueber zu loesen: ein Mandanten schreibt
 * dann in `$HOME/<name>/.omp/agent/mcp.json` und niemand sonst. Das schliesst den
 * Zugriff, **aber es liefert eine Datei, die niemand liest.** Zwei Belege aus
 * diesem Repo:
 *
 * 1. `lib/rpc-manager.ts:1840` startet jede Session mit
 *    `const agentDir = getAgentDir()` und reicht genau dieses `agentDir` an
 *    `createAgentSession` weiter. Der User-Scope einer MCP-Konfiguration wird
 *    fuer *jede* Session, auch die eines Mandanten, aus dem Prozessverzeichnis
 *    gelesen. Eine Mandantendatei wuerde dort nie aufgeruegt.
 * 2. `addDiscoveredServers` ruft `loadCapability("mcps", …)` ohne `home`-
 *    Override; das SDK loest `~` ueber `os.homedir()` des Prozesses auf und
 *    entdeckt ebenfalls nur die globale Datei.
 *
 * Ein Mandant, der einen MCP-Server eintraegt, bekam damit eine Erfolgsmeldung
 * und einen Server, den keine Session startet — das ist kein Rechtefehler,
 * sondern eine **Luege in der Oberflaeche**, und sie ist genau die, vor der
 * `app/api/auth/api-key/[provider]/route.ts` warnt: "solange eine Zeile fuer
 * alle gilt, ist 'mein Key' eine Behauptung des Clients und keine Eigenschaft
 * des Datensatzes."
 *
 * Deshalb ist der User-Scope hier `requireAdmin`, aus **demselben** Grund und mit
 * **derselben** Begruendung wie beim Modellschluessel: die Konfiguration ist
 * prozessweit, es gibt heute keine Mandanten-Alternative, und ein Eintrag darin
 * ist eine Ausfuehrungsanweisung. Was ein Mandanten *wirklich* besitzt, ist der
 * Projekt-Scope — und der gehoert weiterhin jedem, dessen `cwd` die
 * `validatedCwd`-Pruefung besteht.
 *
 * ### Warum `configPath` trotzdem die Identity braucht
 *
 * Der Admin-Guard und die Pfadableitung sind zwei unabhaengige Schichten, und
 * die zweite ist hier keine Dekoration:
 *
 * `setMcpServerEnabled` faellt bei einem nicht gefundenen Server auf `userPath`
 * zurueck und schreibt dort `disabledServers`/`enabledServers`
 * (`@oh-my-pi/pi-coding-agent/mcp/config-writer`: `XB(userPath, …)` /
 * `SAe(userPath, …)`). Ein Mandant, der `PATCH { scope: "project" }` mit einem
 * **fremden** Servernamen schickt, landet damit auch bei `scope: "project"` in
 * `userPath` — ein Admin-Guard auf `body.scope` allein wuerde daran vorbeigehen.
 * Mit `resolveTenantAgentDir(identity)` ist `userPath` auch auf diesem Weg die
 * Datei des Absenders.
 *
 * ### Fuer einen Admin aendert sich nichts
 *
 * `resolveTenantAgentDir` gibt fuer einen Admin `getAgentDir()` zurueck — der
 * Prozess *ist* der Admin. Ein Admin schreibt also weiterhin in genau dieselbe
 * globale Datei, in die er heute schreibt; das ist dieselbe Regel wie in
 * `app/api/models-config/route.ts` und `lib/quick-phrases-store.ts`.
 */

/** Identitaet, oder `null` — und `null` ist hier 403. Muster wie `quick-phrases/route.ts`. */
function requireIdentity(req: Request): WebIdentity | null {
  return getRequestIdentity(req.headers);
}

const SERVER_NAME = /^[a-zA-Z0-9_.:-]{1,100}$/;
const REDACTED_VALUE = "••••••••";
const SECRET_ENV_KEY = /(token|key|secret|password|credential|auth)/i;
const SERVER_KEYS: Record<string, true> = {
  enabled: true,
  timeout: true,
  type: true,
  command: true,
  args: true,
  env: true,
  cwd: true,
  url: true,
  headers: true,
  auth: true,
  oauth: true,
};

type McpDocument = {
  $schema?: string;
  mcpServers?: Record<string, McpServerConfig>;
  disabledServers?: string[];
  enabledServers?: string[];
};

function redactNestedStrings(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    typeof item === "string"
      ? REDACTED_VALUE
      : item && typeof item === "object" && !Array.isArray(item)
        ? redactNestedStrings(item as Record<string, unknown>)
        : item,
  ]));
}

function redactConfig(config: McpServerConfig): McpServerConfig {
  return {
    ...config,
    ...(config.headers && {
      headers: Object.fromEntries(Object.keys(config.headers).map((key) => [key, REDACTED_VALUE])),
    }),
    ...(config.env && {
      env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [
        key,
        SECRET_ENV_KEY.test(key) ? REDACTED_VALUE : value,
      ])),
    }),
    ...(config.auth && { auth: redactNestedStrings(config.auth) }),
    ...(config.oauth && { oauth: redactNestedStrings(config.oauth) }),
  };
}

function restoreRedactedValues(submitted: unknown, existing: unknown, path: string): unknown {
  if (submitted === REDACTED_VALUE) {
    if (existing === undefined) throw new Error(`${path}: re-enter the stored secret after renaming this server`);
    return existing;
  }
  if (Array.isArray(submitted)) {
    const previous = Array.isArray(existing) ? existing : [];
    return submitted.map((item, index) => restoreRedactedValues(item, previous[index], `${path}[${index}]`));
  }
  if (submitted && typeof submitted === "object") {
    const previous = existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {};
    return Object.fromEntries(Object.entries(submitted).map(([key, value]) => [
      key,
      restoreRedactedValues(value, previous[key], `${path}.${key}`),
    ]));
  }
  return submitted;
}

/**
 * Der Pfad einer MCP-Konfiguration — **mit** der Identitaet als Parameter.
 *
 * Bewusst kein Parameter-Default und kein `getRequestIdentity()` im Inneren:
 * eine Ableitung, die ihre eigene Identitaet zieht, ist eine, die man beim
 * Aufruf uebersieht. `models-config` und `quick-phrases` machen es genauso.
 *
 * Fuer `scope: "user"` ist das `resolveTenantAgentDir(identity)` — Admin
 * bleibt global (Prozess = Admin), ein Mandanten bekommt sein eigenes
 * Verzeichnis. Damit kann **kein** Aufrufer mehr in einen Pfad schreiben, der
 * nicht der eigene ist, auch nicht der `setMcpServerEnabled`-Rueckfall auf
 * `userPath` in `PATCH`.
 */
function configPath(identity: WebIdentity, scope: "user" | "project", cwd?: string): string {
  return scope === "user"
    ? join(resolveTenantAgentDir(identity), "mcp.json")
    : join(cwd!, ".omp", "mcp.json");
}

function readScope(identity: WebIdentity, scope: "user" | "project", cwd?: string): McpScopeConfig {
  const path = configPath(identity, scope, cwd);
  if (!existsSync(path)) return { scope, path, servers: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as McpDocument;
    const servers = parsed.mcpServers && typeof parsed.mcpServers === "object"
      ? Object.entries(parsed.mcpServers).map(([name, config]) => ({
          name,
          config: redactConfig(config),
          enabled: config.enabled !== false,
          editable: true,
          source: { path, provider: "OMP", level: scope },
        }))
      : [];
    return { scope, path, servers };
  } catch (error) {
    return { scope, path, servers: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function discoveredConfig(server: MCPServer): McpServerConfig {
  return redactConfig({
    ...(server.enabled !== undefined && { enabled: server.enabled }),
    ...(server.timeout !== undefined && { timeout: server.timeout }),
    ...(server.transport && { type: server.transport }),
    ...(server.command !== undefined && { command: server.command }),
    ...(server.args !== undefined && { args: server.args }),
    ...(server.env !== undefined && {
      env: Object.fromEntries(Object.keys(server.env).map((key) => [key, REDACTED_VALUE])),
    }),
    ...(server.cwd !== undefined && { cwd: server.cwd }),
    ...(server.url !== undefined && { url: server.url }),
    ...(server.headers !== undefined && { headers: server.headers }),
    ...(server.auth !== undefined && { auth: server.auth }),
    ...(server.oauth !== undefined && { oauth: server.oauth }),
  });
}

/**
 * Die gefundenen Server in die Antwort einsortieren.
 *
 * `loadCapability` loest `~` ueber `os.homedir()` des **Prozesses** auf und
 * entdeckt darum die globale `mcp.json` wieder — unabhaengig davon, welchen
 * Pfad `configPath` zurueckgibt. Ohne den `filter` unten waere der Leseweg also
 * trotz korrektem `configPath` offen: der Mandant bekaeme die Server des
 * Prozesskontos als *entdeckt* zurueck, nur mit `editable: false`. Der Filter
 * ist deshalb kein Feinschliff, sondern die Haelfte derselben Korrektur.
 *
 * `filter` und nicht `suppress`, weil ein verworfener Eintrag seinen
 * Dedupe-Schluessel nicht beansprucht: ein gleichnamiger Server aus dem
 * Projekt des Mandanten bleibt dadurch sichtbar, statt vom globalen Eintrag
 * verdeckt zu werden.
 *
 * Nur der User-Scope wird gefiltert. `project` gehoert dem cwd und ist ueber
 * `validatedCwd` geprueft, `native` wird ohnehin nicht einsortiert.
 */
async function addDiscoveredServers(
  identity: WebIdentity,
  response: McpConfigResponse,
  cwd?: string,
): Promise<void> {
  const discovered = await loadCapability<MCPServer>("mcps", {
    cwd: cwd ?? process.cwd(),
    includeDisabled: true,
    includeInvalid: true,
    ...(isAdminIdentity(identity)
      ? {}
      : { filter: (item: MCPServer & { _source: { level: string } }) => item._source.level !== "user" }),
  });
  for (const server of discovered.items) {
    const target = server._source.level === "project"
      ? response.project
      : server._source.level === "user"
        ? response.user
        : null;
    if (!target || target.servers.some((entry) => entry.name === server.name)) continue;
    target.servers.push({
      name: server.name,
      config: discoveredConfig(server),
      enabled: server.enabled !== false,
      editable: false,
      source: {
        path: server._source.path,
        provider: server._source.providerName,
        level: server._source.level,
      },
    });
  }
}

function applyEffectiveEnabledState(identity: WebIdentity, response: McpConfigResponse): void {
  const userPath = configPath(identity, "user");
  let document: McpDocument = {};
  if (existsSync(userPath)) {
    try {
      document = JSON.parse(readFileSync(userPath, "utf8")) as McpDocument;
    } catch {
      return;
    }
  }
  const disabled = new Set(document.disabledServers ?? []);
  const forced = new Set(document.enabledServers ?? []);
  for (const scope of [response.user, response.project]) {
    for (const server of scope?.servers ?? []) {
      server.enabled = !disabled.has(server.name) && (server.config.enabled !== false || forced.has(server.name));
    }
  }
}

function validateStringRecord(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (Object.values(value).some((item) => typeof item !== "string")) throw new Error(`${label} values must be strings`);
}

function validateServer(entry: McpServerEntry): McpServerEntry {
  const name = entry.name.trim();
  if (!SERVER_NAME.test(name)) throw new Error(`Invalid MCP server name: ${name || "(empty)"}`);
  const config = entry.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${name}: config must be an object`);
  const unknown = Object.keys(config).find((key) => !SERVER_KEYS[key]);
  if (unknown) throw new Error(`${name}: unknown property ${unknown}`);
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error(`${name}: enabled must be boolean`);
  if (config.timeout !== undefined && (typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout < 0)) {
    throw new Error(`${name}: timeout must be a non-negative number`);
  }
  if (config.command && config.url) throw new Error(`${name}: choose command or URL, not both`);
  if (!config.command && !config.url) throw new Error(`${name}: command or URL is required`);
  if (config.command) {
    if (typeof config.command !== "string" || !config.command.trim()) throw new Error(`${name}: command is required`);
    if (config.type !== undefined && config.type !== "stdio") throw new Error(`${name}: command transport must be stdio`);
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string"))) {
      throw new Error(`${name}: args must be a string array`);
    }
    if (config.cwd !== undefined && typeof config.cwd !== "string") throw new Error(`${name}: cwd must be text`);
    validateStringRecord(config.env, `${name}: env`);
  } else {
    if (typeof config.url !== "string" || !config.url.trim()) throw new Error(`${name}: URL is required`);
    if (config.type !== "http" && config.type !== "sse") throw new Error(`${name}: URL transport must be http or sse`);
    validateStringRecord(config.headers, `${name}: headers`);
  }
  if (config.auth !== undefined && (!config.auth || typeof config.auth !== "object" || Array.isArray(config.auth))) {
    throw new Error(`${name}: auth must be an object`);
  }
  if (config.oauth !== undefined && (!config.oauth || typeof config.oauth !== "object" || Array.isArray(config.oauth))) {
    throw new Error(`${name}: oauth must be an object`);
  }
  return { name, config, enabled: config.enabled !== false };
}

/**
 * Das `cwd` eines Requests, oder `undefined` — **mit** der bereits festgestellten
 * Identitaet.
 *
 * Der Parameter ist nicht optional. Vorher zog diese Funktion die Identitaet
 * selbst, aber nur in einem Zweig: `getRequestIdentity` wurde erst dann gerufen,
 * wenn ueberhaupt ein `cwd` mitkam. Genau darin lag der Einbruch — `scope:
 * "user"` ohne `cwd` lief an der Pruefung vorbei, ohne dass irgendetwas es
 * gemerkt haette. Die Identitaet ist jetzt eine Tatsache des Requests, bevor
 * irgendein Pfad abgeleitet wird, und `configPath` bekommt dieselbe.
 */
async function validatedCwd(identity: WebIdentity, req: Request): Promise<string | undefined> {
  const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
  if (!cwd) return undefined;
  const allowedRoots = await getAllowedFileRoots(identity);
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new Error("Access denied");
  return cwd;
}

/**
 * Der Guard fuer den User-Scope, und die Begruendung, warum er nicht in
 * `requireAdmin` aufgeht.
 *
 * `requireAdmin` allein wuerde reichen, wenn der Guard vor jeder Verwendung von
 * `configPath` stuende. Er steht es — in `PUT`. Der Weg, den er nicht sieht,
 * ist `PATCH`: `setMcpServerEnabled` schreibt bei einem unbekannten Servernamen
 * in `userPath`, auch wenn `body.scope === "project"` ist. Deshalb wird der
 * User-Scope in **beiden** Mutationen geprueft, und `configPath` traegt die
 * Identitaet zusaetzlich in sich: die Pfadableitung ist die zweite Schicht, und
 * sie haengt nicht davon ab, dass jemand an den Guard gedacht hat.
 */
function requireUserScope(identity: WebIdentity, scope: "user" | "project"): Response | null {
  if (scope !== "user") return null;
  return isAdminIdentity(identity)
    ? null
    : Response.json(
      { error: "Administrator access is required." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
}

export async function GET(req: Request) {
  const identity = requireIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  try {
    const cwd = await validatedCwd(identity, req);
    const response: McpConfigResponse = {
      user: readScope(identity, "user"),
      project: cwd ? readScope(identity, "project", cwd) : null,
    };
    await addDiscoveredServers(identity, response, cwd);
    applyEffectiveEnabledState(identity, response);
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 500 });
  }
}

export async function PATCH(req: Request) {
  const identity = requireIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  try {
    const body = await req.json() as {
      scope?: "user" | "project";
      name?: string;
      enabled?: boolean;
    };
    if (body.scope !== "user" && body.scope !== "project") throw new Error("Invalid MCP scope");
    const denied = requireUserScope(identity, body.scope);
    if (denied) return denied;
    const cwd = await validatedCwd(identity, req);
    if (body.scope === "project" && !cwd) throw new Error("cwd required for project MCP settings");
    if (typeof body.name !== "string" || !SERVER_NAME.test(body.name)) throw new Error("Invalid MCP server name");
    if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");

    const userPath = configPath(identity, "user");
    const projectPath = configPath(identity, "project", cwd ?? process.cwd());
    const scopedPath = body.scope === "user" ? userPath : projectPath;
    let sourcePath: string | undefined;
    if (existsSync(scopedPath)) {
      const document = JSON.parse(readFileSync(scopedPath, "utf8")) as McpDocument;
      if (document.mcpServers?.[body.name]) sourcePath = scopedPath;
    }

    await setMcpServerEnabled({
      userPath,
      projectPath,
      sourcePath,
      name: body.name,
      enabled: body.enabled,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function PUT(req: Request) {
  const identity = requireIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  try {
    const body = await req.json() as { scope?: "user" | "project"; servers?: McpServerEntry[] };
    if (body.scope !== "user" && body.scope !== "project") throw new Error("Invalid MCP scope");
    const denied = requireUserScope(identity, body.scope);
    if (denied) return denied;
    const cwd = await validatedCwd(identity, req);
    if (body.scope === "project" && !cwd) throw new Error("cwd required for project MCP settings");
    if (!Array.isArray(body.servers)) throw new Error("servers must be an array");
    const servers = body.servers.map(validateServer);
    if (new Set(servers.map(({ name }) => name)).size !== servers.length) throw new Error("MCP server names must be unique");

    const path = configPath(identity, body.scope, cwd);
    let existing: McpDocument = {};
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, "utf8")) as McpDocument;
      } catch {
        throw new Error(`Cannot overwrite invalid JSON: ${path}`);
      }
    }
    const restoredServers = servers.map(({ name, config }) => ({
      name,
      config: restoreRedactedValues(config, existing.mcpServers?.[name], name) as McpServerConfig,
    }));
    const document: McpDocument = {
      ...existing,
      $schema: existing.$schema ?? "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
      mcpServers: Object.fromEntries(restoredServers.map(({ name, config }) => [name, config])),
    };
    mkdirSync(dirname(path), { recursive: true });
    writePrivateFileAtomicSync(path, `${JSON.stringify(document, null, 2)}\n`);
    return NextResponse.json({ success: true, scope: readScope(identity, body.scope, cwd) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
