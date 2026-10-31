export type SettingsValue = boolean | string | number | string[] | Record<string, number> | null;

export interface SettingsOption {
  value: string;
  label: string;
  description?: string;
}

export type SettingsFieldType =
  | "boolean"
  | "select"
  | "text"
  | "secret"
  | "multiselect"
  | "providerLimits";

export interface SettingsField {
  path: string;
  tab: string;
  group?: string;
  label: string;
  description: string;
  type: SettingsFieldType;
  value: SettingsValue;
  defaultValue: SettingsValue;
  configured: boolean;
  /** Whether the caller may write it; `false` means the panel must disable it. */
  writable: boolean;
  options?: SettingsOption[];
  ordered?: boolean;
  condition?: string;
}

/**
 * Settings that decide what *every* session loads.
 *
 * They are per-account config (`config.yml` of the caller's agent directory),
 * but their effect reaches past one screen: `skills.*` moves skill discovery,
 * `commands.*` which command directories load, `autolearn.enabled` gates
 * `learn` and `manage_skill` — and `manage_skill` writes into the *process*
 * `managed-skills` directory, i.e. the operator's store (measured: a tenant's
 * mint landed in `…/proc-agent/managed-skills/`, `LOAD-LEVEL-SCAN.md` §3(ii)).
 * `memory.backend` makes a session read the operator's memory root, and
 * `extensions`/`disabledExtensions`/`enabledProviders` select modules and
 * providers. Writing them is an admin change for the same reason `PATCH
 * /api/skills` is: the value is read by code the caller does not own.
 *
 * One prefix list, not an enum of ids: a new `skills.*` key is admin-only by
 * default instead of open until someone remembers it.
 */
const ADMIN_ONLY_SETTINGS = [
  "skills",
  "commands",
  "autolearn",
  "memory",
  "extensions",
  "disabledExtensions",
  "enabledProviders",
  "disabledProviders",
] as const;

/** Whether `path` is a setting only an admin may write. */
export function isAdminOnlySetting(path: string): boolean {
  return ADMIN_ONLY_SETTINGS.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}

export interface SettingsTab {
  id: string;
  label: string;
  groups: string[];
}

export interface WebThemePalette {
  name: string;
  colorScheme: "dark" | "light";
  variables: Record<string, string>;
}

export interface WebThemeConfig {
  names: { dark: string; light: string };
  palettes: { dark: WebThemePalette; light: WebThemePalette };
}

/** Render-affecting settings the transcript view reads from omp's config. */
export interface DisplaySettings {
  hideThinkingBlock: boolean;
}

export interface SettingsResponse {
  tabs: SettingsTab[];
  fields: SettingsField[];
  availableThemes: Array<{ name: string; colorScheme: "dark" | "light" }>;
  theme: WebThemeConfig;
}

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  enabled?: boolean;
  timeout?: number;
  type?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: Record<string, unknown>;
  oauth?: Record<string, unknown>;
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  editable?: boolean;
  source?: {
    path: string;
    provider: string;
    level: "user" | "project" | "native";
  };
}

export interface McpScopeConfig {
  scope: "user" | "project";
  path: string;
  servers: McpServerEntry[];
  error?: string;
}

export interface McpConfigResponse {
  user: McpScopeConfig;
  project: McpScopeConfig | null;
}
