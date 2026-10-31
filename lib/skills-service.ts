import { readFileSync } from "fs";
import { getAgentDir, loadSkills } from "@oh-my-pi/pi-coding-agent";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import type { Skill, SkillWarning } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { cfgDisabledExtensions, cfgSkills } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getProjectTrustStatus, trustedProjectSkills } from "@/lib/project-trust";
import { getSettingsForIdentity } from "@/lib/omp-runtime";
import type { WebIdentity } from "@/lib/request-identity";

/**
 * Skills exactly as an omp session would see them.
 *
 * `loadSkills` is the same entry point `createAgentSession` uses, so the panel
 * lists `.omp/skills`, `~/.omp/agent/skills`, `.claude/skills`, plugin skills
 * and `.agents/skills` with omp's own precedence and collision warnings.
 *
 * ### Projekt-Skills folgen dem Projekt-Vertrauen
 *
 * Was hier herausfaellt, ist in einer Sitzung ebenfalls nicht da: derselbe
 * Filter (`trustedProjectSkills`) laeuft im Sitzungsstart
 * (`lib/rpc-manager.ts`). Zwei Ansichten ueber denselben Bestand waeren genau
 * der Fehler, den die Leiste ueber dem Panel dann anzeigt. Der Filter laesst
 * globale Skills stehen — nur projektgebundene gehen.
 *
 * ### Der Bestand ist pro Konto; die Liste bleibt die Vereinigung
 *
 * `loadSkills` bekommt die Settings des Aufrufers. Deren
 * `skills.customDirectories` macht den eigenen Ordner `<agent dir>/skills` als
 * `custom:user` sichtbar; die native Wurzel (`native:user`) und die verwalteten
 * Skills bleiben zusaetzlich geladen, weil der Prozess-Agent-Ort derselbe
 * bleibt. Ein Mandant sieht also seine eigenen Skills **und** die des
 * Betreibers — letztere nur lesend. Geschrieben wird ausschliesslich ueber
 * `/api/skills/user[...]`, nie ueber diese Lesesicht.
 *
 * `identity` geht in die Lock-Datei (welche Installationen *dieses* Konto als
 * die eigenen sieht) und in `getSettingsForIdentity`; letzteres entscheidet
 * ueber die sichtbaren Quellen, waehrend `agentDir` fuer die
 * Projekt-Vertrauensabfrage der globale des Prozesses bleibt.
 */
export async function loadSkillsWithInstallInfo(
  cwd: string,
  identity: WebIdentity | null,
): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const settings = await getSettingsForIdentity(identity, cwd);
  // `skills.*` sind einzelne Handles; `cfgSkills` fasst sie zu genau dem
  // Optionsobjekt zusammen, das `loadSkills` erwartet (dieselbe Projektion,
  // die `createAgentSession` intern benutzt). Derselbe Aufruf, den der
  // Sitzungsstart benutzt — eine Discovery, ein Filter, zwei Ansichten.
  const { skills, warnings, trusted, withheld } = await loadSessionSkills(cwd, settings);

  const infos: SkillInfo[] = skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    disableModelInvocation: readDisableModelInvocation(skill.filePath),
    sourceInfo: {
      ...(skill.source ? { source: skill.source } : {}),
      ...(skill._source?.level ? { scope: skill._source.level } : {}),
    },
  }));

  return {
    skills: annotateSkillsWithInstallInfo(infos, { cwd, agentDir, identity }),
    diagnostics: [
      ...warnings.map((warning) => ({
        type: "warning" as const,
        message: warning.message,
        path: warning.skillPath,
      })),
      // Warum die Liste kuerzer ist als das Verzeichnis, ist keine stille
      // Entscheidung: das Panel zeigt die Diagnose, und die Leiste darueber
      // sagt bereits, dass Projekt-Ressourcen nicht geladen werden.
      ...(withheld > 0
        ? [{
            type: "info" as const,
            message: `${withheld} project skill${withheld === 1 ? "" : "s"} not loaded because this project is not trusted.`,
            path: cwd,
          }]
        : []),
    ],
    projectResourcesLoaded: trusted,
  };
}

/** What a session for one `cwd` may load, after project trust has been applied. */
export interface SessionSkills {
  skills: Skill[];
  warnings: SkillWarning[];
  /** Whether the project is trusted; `false` means project-scoped skills were dropped. */
  trusted: boolean;
  /** How many project-scoped skills trust removed; `0` when it removed none. */
  withheld: number;
}

/**
 * The skill list a session for `cwd` starts with, and the trust decision it was
 * filtered by.
 *
 * This exists so `lib/rpc-manager.ts` does not have to re-derive the trust
 * check, the settings projection and the filter in its own order: the panel
 * (`loadSkillsWithInstallInfo`) and the session both call this, so "what the
 * panel lists" and "what the agent can use" cannot drift apart.
 */
export async function loadSessionSkills(
  cwd: string,
  settings: Settings,
): Promise<SessionSkills> {
  const agentDir = getAgentDir();
  // Same options `createAgentSession` projects internally: without
  // `disabledExtensions` a hand-supplied list would re-enable skills the user
  // switched off, so the session's list must be discovery's list.
  const { skills: discovered, warnings } = await loadSkills({
    cwd,
    ...cfgSkills.get(settings),
    disabledExtensions: cfgDisabledExtensions.get(settings),
  });
  const trusted = getProjectTrustStatus(cwd, agentDir).trusted;
  // `undefined` means "no filter applies" — hand back the discovered list
  // itself rather than a copy nothing would tell apart.
  const skills = trustedProjectSkills(cwd, agentDir, discovered) ?? discovered;
  return { skills, warnings, trusted, withheld: discovered.length - skills.length };
}

/**
 * omp's `Skill` does not carry the raw frontmatter, and the toggle in the panel
 * edits exactly one key, so read it back from the file the skill came from.
 */
function readDisableModelInvocation(filePath: string): boolean {
  try {
    const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf8"));
    return Boolean(frontmatter["disable-model-invocation"]);
  } catch {
    return false;
  }
}
