import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The two prompts and the draft seam.
 *
 * The path is the point of the creation test: the reference document pointed at
 * the *operator's* `~/.omp/agent/skills`, which for a tenant is someone else's
 * store. The prompt must carry the absolute directory the route resolved.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { buildSkillCreationPrompt, buildSkillEditPrompt, prefillNewChat } =
  await jiti.import("./skill-prompts.ts");
const { clearDraft, getDraft } = await jiti.import("./draft-store.ts");

const STORE = "/tmp/omp-web-home/alice/.omp/agent/skills";
const FILE = `${STORE}/alpha/SKILL.md`;

test("der Neu-Prompt nennt den absoluten Bestand des Kontos und laesst {{topic}} stehen", () => {
  for (const locale of ["en", "de", "zh-CN"]) {
    const prompt = buildSkillCreationPrompt(locale, STORE);
    assert.ok(prompt.includes(STORE), `${locale}: absolute store`);
    assert.ok(prompt.includes(`${STORE}/<name>/SKILL.md`), `${locale}: target file`);
    assert.ok(prompt.includes("{{topic}}"), `${locale}: placeholder survives`);
    assert.ok(!prompt.includes("~/.omp"), `${locale}: no operator-relative path`);
  }
});

test("der Edit-Prompt referenziert die Datei als absoluten @-Pfad", () => {
  for (const locale of ["en", "de", "zh-CN"]) {
    const prompt = buildSkillEditPrompt(locale, FILE);
    assert.ok(prompt.includes(`@${FILE}`), `${locale}: @ path`);
  }
});

test("prefillNewChat legt den Prompt im neuen Chat-Draft ab, mit dem Skill-Pfad", () => {
  const cwd = "/tmp/project";
  clearDraft(`new:${cwd}`);

  prefillNewChat(cwd, buildSkillEditPrompt("en", FILE));

  const draft = getDraft(`new:${cwd}`);
  assert.ok(draft, "draft exists before the composer mounts");
  assert.ok(draft.value.includes(`@${FILE}`));
  assert.deepEqual(draft.images, []);
  clearDraft(`new:${cwd}`);
});
