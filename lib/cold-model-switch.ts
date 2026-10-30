import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { getOmpRuntime, getSettingsForCwd } from "./omp-runtime";
import { listModelRoles } from "./model-roles";
import { resolveVisibleModels } from "./model-scope";
import { invalidateSessionListCache } from "./session-reader";
import { invalidateModelsCache } from "./models-cache";

/**
 * Ein Modellwechsel an einer Session **ohne** laufenden Wrapper.
 *
 * ### Warum nicht einfach `startRpcSession`
 *
 * Genau das tat die Route vorher, und es war der teuerste Teil eines Wechsels:
 * `startRpcSession` oeffnet die Session, entdeckt Extensions und Custom-Tools,
 * loest System-Prompts auf, baut die Modell-Scope und ruft
 * `createAgentSession` — Sekunden, in denen der Ausloeser im Composer
 * `disabled` ist. Fuer einen Modellwechsel ist das verschwendet: der Wechsel
 * braucht kein laufendes Agent-Objekt, sondern einen Eintrag im Journal.
 *
 * ### Warum ein Journal-Eintrag reicht
 *
 * Die SDK stellt das Modell beim naechsten Start aus genau diesem Eintrag
 * wieder her: `createAgentSession` liest `models` aus dem Session-Kontext und
 * loest `getRestorableSessionModels(...)` auf, wenn kein Modell vorgegeben ist
 * (`sdk.ts:2098-2116`). Ein `model_change` mit `role: "default"` ist damit die
 * vollstaendige, persistente Form des Wechsels — dieselbe Zeile, die
 * `setModel` schreibt (`model-controls.ts:252`).
 *
 * Die Pruefungen, die `setModel` selbst macht, werden hier nachgezogen statt
 * umgangen: das Modell muss im sichtbaren Scope liegen, und ein Rollenwechsel
 * muss eine konfigurierte Rolle mit aufloesbarem Modell sein. Sonst schriebe
 * dieser Pfad einen Eintrag, den der Start spaeter nicht wiederherstellen kann.
 */
export async function switchColdSessionModel(
  sessionFile: string,
  target: { kind: "model"; provider: string; modelId: string } | { kind: "role"; role: string },
): Promise<{ id: string; provider: string; role?: string; leafId: string | null }> {
  const sessionManager = await SessionManager.open(sessionFile);
  const cwd = sessionManager.getCwd();
  const { modelRegistry } = await getOmpRuntime();
  const settings = await getSettingsForCwd(cwd);
  const scope = await resolveVisibleModels(modelRegistry, cfgEnabledModels.get(settings), settings);

  let model;
  let role: string | undefined;
  if (target.kind === "role") {
    const assignment = listModelRoles(settings, [...scope.visible])
      .find((candidate) => candidate.role === target.role);
    // Eine Rolle ohne aufloesbares Modell faellt auf das Session-Modell zurueck;
    // dann gibt es nichts zu wechseln, und ein Eintrag waere eine Luege.
    const resolved = assignment?.resolved;
    if (!resolved) throw new Error(`No model configured for role "${target.role}"`);
    model = scope.visible.find((candidate) => (
      candidate.provider === resolved.provider && candidate.id === resolved.modelId
    ));
    role = target.role;
  } else {
    model = scope.visible.find((candidate) => (
      candidate.provider === target.provider && candidate.id === target.modelId
    ));
  }
  if (!model) {
    const wanted = target.kind === "role" ? target.role : `${target.provider}/${target.modelId}`;
    throw new Error(`Model not found: ${wanted}`);
  }
  // Dieselbe Pruefung, die `setModel` vor dem Wechsel macht
  // (`model-controls.ts:241-243`). Ohne sie schriebe dieser Pfad einen Eintrag
  // auf ein Modell, das der naechste Start nicht benutzen kann — und der
  // Fehler faende sich erst beim ersten Prompt statt hier.
  if (!modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`No API key for ${model.provider}/${model.id}`);
  }

  sessionManager.appendModelChange(`${model.provider}/${model.id}`, role);
  // Die Datei ist die einzige Quelle dieses Wechsels; ohne die Spuelung sieht
  // der naechste Leser noch den alten Eintrag. Anders als in `setModel` gibt es
  // hier keinen laufenden Writer, der es ohnehin tut.
  await sessionManager.flush();

  invalidateModelsCache();
  invalidateSessionListCache();

  return {
    id: model.id,
    provider: model.provider,
    ...(role ? { role } : {}),
    leafId: sessionManager.getLeafId(),
  };
}
