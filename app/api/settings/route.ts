import { NextResponse } from "next/server";
// Settings sind seit 18.14 keine Schema-Tabelle mehr, sondern typisierte
// Handles pro Einstellung (`Setting.get(scope)` / `.set(scope, value)`). Die
// Handles liegen bei ihrer Domaene, `orderedSettings()` liefert alle in
// Panel-Reihenfolge — dieselbe Reihenfolge, die das Schema frueher hatte.
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import type { AnySetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { SETTING_TABS, TAB_GROUPS, TAB_METADATA } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { getSettingsForIdentity } from "@/lib/omp-runtime";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getRequestIdentity, isAdminIdentity, requireAdmin } from "@/lib/request-identity";
import { getAvailableWebThemes, getWebThemeConfig } from "@/lib/omp-theme";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isAdminOnlySetting } from "@/lib/settings-api";
import type {
  SettingsField,
  SettingsFieldType,
  SettingsOption,
  SettingsResponse,
  SettingsValue,
} from "@/lib/settings-api";

export const dynamic = "force-dynamic";

const SETTINGS_BY_ID = new Map<string, AnySetting>(orderedSettings().map((setting) => [setting.id, setting]));
/** Panel-Einstellungen nach Tab, in `orderedSettings()`-Reihenfolge. */
const SETTINGS_BY_TAB = new Map<string, AnySetting[]>(
  SETTING_TABS.map((tab) => [tab, orderedSettings().filter((setting) => setting.ui?.tab === tab)]),
);

async function validateCwd(cwd: string | null, req: Request): Promise<string | undefined> {
  if (!cwd) return undefined;
  const allowedRoots = await getAllowedFileRoots(getRequestIdentity(req.headers));
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new Error("Access denied");
  return cwd;
}

function optionsFor(setting: AnySetting, runtimeThemes: string[]): SettingsOption[] | undefined {
  const ui = setting.ui;
  if (!ui) return undefined;
  if (ui.options === "runtime") {
    return setting.id === "theme.dark" || setting.id === "theme.light"
      ? runtimeThemes.map((value) => ({ value, label: value }))
      : [];
  }
  if (Array.isArray(ui.options)) return ui.options.map((option) => ({ ...option }));
  return setting.enumValues?.map((value) => ({ value, label: value }));
}

function fieldTypeFor(setting: AnySetting): SettingsFieldType | null {
  const ui = setting.ui;
  if (!ui) return null;
  if (setting.type === "boolean") return "boolean";
  if (setting.type === "enum") return "select";
  if (setting.type === "string") return setting.isCredential ? "secret" : ui.options ? "select" : "text";
  if (setting.type === "number") return ui.options ? "select" : null;
  if (setting.type === "array") return ui.options ? "multiselect" : null;
  if (setting.type === "record") return setting.id === "providers.maxInFlightRequests" ? "providerLimits" : "text";
  return null;
}

function serializableValue(value: unknown): SettingsValue {
  if (value === undefined) return null;
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
    || typeof value === "number"
    || Array.isArray(value)
  ) return value as SettingsValue;
  return value as Record<string, number>;
}

function validateSettingValue(setting: AnySetting, value: unknown): SettingsValue {
  const ui = setting.ui;
  if (!ui) throw new Error("Setting is not exposed by /settings");

  if (setting.type === "boolean") {
    if (typeof value !== "boolean") throw new Error("Expected a boolean");
    return value;
  }
  if (setting.type === "string") {
    if (typeof value !== "string") throw new Error("Expected text");
    const allowed = optionsFor(setting, []);
    if (ui.options !== "runtime" && allowed?.length && !allowed.some((option) => option.value === value)) {
      throw new Error("Invalid option");
    }
    return value;
  }
  if (setting.type === "enum") {
    if (typeof value !== "string" || !setting.enumValues?.includes(value)) throw new Error("Invalid option");
    return value;
  }
  if (setting.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a finite number");
    const allowed = Array.isArray(ui.options) ? ui.options.map((option) => Number(option.value)) : [];
    if (allowed.length && !allowed.includes(value)) throw new Error("Invalid option");
    return value;
  }
  if (setting.type === "array") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Expected a string list");
    const allowed = Array.isArray(ui.options) ? new Set(ui.options.map((option) => option.value)) : null;
    if (!allowed || value.some((item) => !allowed.has(item))) throw new Error("Invalid list option");
    return [...new Set(value)] as string[];
  }
  if (setting.type === "record" && setting.id === "providers.maxInFlightRequests") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected provider limits");
    const result: Record<string, number> = {};
    for (const [provider, limit] of Object.entries(value)) {
      if (!provider.trim() || typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
        throw new Error("Provider limits must be positive numbers");
      }
      result[provider.trim()] = Math.floor(limit);
    }
    return result;
  }
  throw new Error("Unsupported setting type");
}

export async function GET(req: Request) {
  try {
    const cwd = await validateCwd(new URL(req.url).searchParams.get("cwd"), req);
    // Die Identitaet wird hier wie beim cwd-Pfad ueber den Header gelesen und
    // durchgereicht: ohne sie sieht ein Mandant die `config.yml` des
    // Prozesskontos, also auch dessen gespeicherte Werte.
    const identity = getRequestIdentity(req.headers);
    const settings = await getSettingsForIdentity(identity, cwd);
    const isAdmin = isAdminIdentity(identity);
    const [availableThemes, theme] = await Promise.all([
      getAvailableWebThemes(),
      getWebThemeConfig(settings),
    ]);
    const themeNames = availableThemes.map(({ name }) => name);
    const fields: SettingsField[] = [];

    for (const tab of SETTING_TABS) {
      for (const setting of SETTINGS_BY_TAB.get(tab) ?? []) {
        const fieldType = fieldTypeFor(setting);
        const ui = setting.ui;
        if (!fieldType || !ui) continue;
        const secret = setting.isCredential;
        fields.push({
          path: setting.id,
          tab,
          group: ui.group,
          label: ui.label,
          description: ui.description,
          type: fieldType,
          value: secret ? null : serializableValue(setting.get(settings)),
          defaultValue: secret ? null : serializableValue(setting.default),
          configured: setting.isConfigured(settings),
          // Dieselbe Frage, die `PATCH` stellt: was hier `false` ist, weist die
          // Schreibroute mit 403 ab. Die Anzeige darf nicht klickbar sein, wenn
          // der Server sie ohnehin ablehnt.
          writable: isAdmin || !isAdminOnlySetting(setting.id),
          options: optionsFor(setting, themeNames),
          ordered: ui.ordered === true,
          condition: ui.condition,
        });
      }
    }

    const response: SettingsResponse = {
      tabs: SETTING_TABS.map((id) => ({ id, label: TAB_METADATA[id].label, groups: [...TAB_GROUPS[id]] })),
      fields,
      availableThemes,
      theme,
    };
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 500 });
  }
}

export async function PATCH(req: Request) {
  // Ohne `isApiRequestAllowed` war dies eine POST-als-GET-Woerterbuchlücke auf
  // dem einen Endpunkt, der fremde Herkunft überhaupt bemerken wuerde. Und
  // `identity === null` heisst 403, nicht Default-Benutzer: die
  // Mandantengrenze darf keinen Fallback haben.
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = getRequestIdentity(req.headers);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { path?: string; value?: unknown };
    const setting = body.path ? SETTINGS_BY_ID.get(body.path) : undefined;
    if (!setting || !setting.ui) {
      return NextResponse.json({ error: "Unknown setting" }, { status: 400 });
    }
    // Einstellungen, die bestimmen, was eine Sitzung laedt, gelten fuer den
    // ganzen Host (siehe `isAdminOnlySetting`): `autolearn` schaltet
    // `manage_skill` frei, das in den Prozess-Store schreibt, `memory.backend`
    // laesst eine Sitzung den Speicher des Betreibers lesen, `skills.*` und
    // `commands.*` verschieben die Discovery. `requireAdmin` ist die Antwort des
    // Repos auf eine hostweite Aenderung — und sie gilt nur fuer diese Pfade,
    // damit ein Mandant Theme und Anzeige weiter selbst stellt.
    if (isAdminOnlySetting(setting.id)) {
      const denied = requireAdmin(req);
      if (denied) return denied;
    }
    const value = validateSettingValue(setting, body.value);
    if (
      (setting.id === "theme.dark" || setting.id === "theme.light")
      && (typeof value !== "string" || !(await getAvailableWebThemes()).some(({ name }) => name === value))
    ) {
      throw new Error("Unknown omp theme");
    }
    // `setting.set()` schreibt in die globale Ebene der Instanz und `flush()`
    // auf die Platte. Mit der pro-Konto-Instanz aus `getSettingsForIdentity()`
    // landet der Wert in der `config.yml` **dieses** Kontos; mit der
    // Prozess-Singleton waere es die `config.yml` des Betreibers gewesen —
    // derselbe Leck-Typ wie bei `models.yml`, nur eine Ebene hoeher.
    const settings = await getSettingsForIdentity(identity, undefined);
    setting.set(settings, value as never);
    await settings.flush();
    return NextResponse.json({ success: true, value: serializableValue(setting.get(settings)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
