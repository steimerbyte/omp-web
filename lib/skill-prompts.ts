import { setDraft } from "./draft-store";
import type { Locale } from "./i18n/types";

/**
 * The two prompts the skills manager puts into a composer.
 *
 * They are plain strings, not i18n messages: a translation catalogue is for
 * labels a reader sees around the app, while these are instructions the *model*
 * reads. Keeping them here also means the path correction (below) lives next
 * to the reason for it, and a test can assert the absolute path is in the text.
 *
 * ### The path correction
 *
 * `SKILL-CREATION-PROMPT.md` was written when skills were one global store and
 * named `~/.omp/agent/skills`. That is the operator's directory. A tenant's
 * session has `HOME` set to the service account, so `~` would send their new
 * skill into the operator's store — and the next tenant would read it. The
 * templates therefore take the caller's resolved store (the `directory` from
 * `GET /api/skills/user`) and interpolate it verbatim: absolute for a tenant,
 * `~`-free for the admin as well, so one sentence is true for both.
 */

export function buildSkillCreationPrompt(locale: Locale, skillsRoot: string): string {
  if (locale === "de") {
    return [
      "[Ersetze unten {{topic}} durch dein Thema und schick es ab — mehr ist nicht nötig.]",
      "Lege dazu einen Agent-Skill an.",
      "Recherchiere zuerst, kurz: die Agent-Skills-Spezifikation (https://agentskills.io/specification) und ein echtes, veröffentlichtes SKILL.md zum Thema. Primärquellen vor Blogposts, keine Listicles; zwei Quellen reichen — schau darauf, wie die description ihre Trigger formuliert, wie die Schritte geordnet sind und was in references/ ausgelagert wird; übernimm die Form, nicht den Wortlaut.",
      `Prüfe vor dem Schreiben diese Installation: die AGENTS.md dieses Projekts für die Befehle, die der Skill vorschreiben soll, einen vorhandenen Skill unter ${skillsRoot} als Stilvorlage (überspring das, solange der Ordner leer ist) und die Laderregeln in omp://skills.md (eine Ebene tief, description ist Pflicht).`,
      `Schreibe die Datei selbst mit dem write-Tool — nicht mit manage_skill, das erreicht nur managed-skills — nach ${skillsRoot}/<name>/SKILL.md, dem Bestand dieses Kontos, den dieses Panel führt. Frontmatter: name gleich dem Verzeichnisnamen, 1–64 Zeichen aus a–z, 0–9 und Bindestrichen, nicht mit Bindestrich beginnend oder endend, kein doppelter Bindestrich; description höchstens 400 Zeichen: was er tut, 3–5 Wendungen, die ein Nutzer hier wirklich tippt (plus Englisch), und „Do NOT use for: …“.`,
      "Body: ## When to Use, ## Procedure (nummeriert, höchstens 10 Schritte, die konkreten Befehle und Pfade, die der Agent ausführt), ## Pitfalls (Symptom | Ursache | Fix), ## Verification. Eine Prozedur, kein Tutorial; der lange Rest gehört nach references/ mit relativen Links.",
      "Hat das Thema zwei plausible Lesarten oder gibt es den Skill-Namen schon: genau eine Rückfrage stellen und aufhören — niemals überschreiben.",
      "Vor der Antwort prüfen: jede geschriebene Datei erneut lesen, ls -la auf das neue Verzeichnis, dann den absoluten Pfad, die Dateiliste sowie name und description nennen.",
      "Thema: {{topic}}",
    ].join("\n");
  }
  if (locale === "zh-CN") {
    return [
      "[把下面的 {{topic}} 换成你的主题后直接发送，其它都不用改。]",
      "为这个主题创建一个 Agent 技能。",
      "先做简短的调研：读一遍 Agent Skills 规范（https://agentskills.io/specification），再找一份该主题下真实发布的 SKILL.md。优先一手文档，不看清单式博客；两个来源就够，重点看 description 里怎么写触发说法、步骤怎么排、哪些内容被放进 references/；学结构而不是抄措辞。",
      `动笔前先看这套安装：本项目的 AGENTS.md（技能里要照搬的命令）、${skillsRoot} 下已有的一个技能（当行文参照；目录为空就跳过），以及 omp://skills.md 里的加载规则（只扫一层，description 必填）。`,
      `用 write 工具自己写文件（不要用 manage_skill，它只会写到 managed-skills），路径 ${skillsRoot}/<name>/SKILL.md，也就是这个面板列出、属于你本人账户的技能库。frontmatter：name 与目录名一致，1–64 个 a–z、0–9 和连字符，首尾不加连字符、不出现连续连字符；description 不超过 400 字符：做什么、3–5 个用户在本界面语言里真会输入的说法（再加英文），以及“Do NOT use for: …”。`,
      "正文：## When to Use、## Procedure（编号，不超过 10 步，写清 agent 实际执行的命令和路径）、## Pitfalls（现象 | 原因 | 修法）、## Verification。写流程，不要写教程；篇幅长的部分放进 references/，用相对链接。",
      "主题有两种合理理解，或同名技能已经存在：只问一个问题就停下，绝不覆盖。",
      "回答前先自查：重读写过的每个文件，对新目录执行 ls -la，然后给出绝对路径、文件清单，以及你设置的 name 和 description。",
      "主题：{{topic}}",
    ].join("\n");
  }
  return [
    "[Replace {{topic}} with your topic below, then send — nothing else is needed.]",
    "Create an agent skill for that topic.",
    "Research first, briefly: read the Agent Skills spec (https://agentskills.io/specification) and one real SKILL.md published for this topic. Primary docs over blog posts, no listicles; two sources are enough — read them for how the description phrases its triggers, how the steps are ordered and what they push into references/; take the shape, not the wording.",
    `Before writing, check this installation: this project's AGENTS.md for the commands the skill must prescribe, one existing skill under ${skillsRoot} as the style reference (skip it while the folder is empty), and the loader rules in omp://skills.md (one level deep; description required).`,
    `Write it yourself with the write tool — not manage_skill, which only reaches managed-skills — to ${skillsRoot}/<name>/SKILL.md, the per-account store this panel lists. Frontmatter: name equal to the directory, 1–64 chars of a–z 0–9 and -, no leading, trailing or doubled hyphen; description ≤ 400 chars: what it does, 3–5 phrases a user here would really type (plus English), and "Do NOT use for: …".`,
    "Body: ## When to Use, ## Procedure (numbered, ≤10 steps, the exact commands and paths an agent runs), ## Pitfalls (symptom | cause | fix), ## Verification. A procedure, not a tutorial; the long tail goes to references/ with relative links.",
    "If the topic has two plausible readings or that skill name already exists, ask exactly one question and stop — never overwrite.",
    "Verify before answering: re-read every file you wrote, ls -la the new directory, then report the absolute path, the file list, and the name and description you set.",
    "Topic: {{topic}}",
  ].join("\n");
}

export function buildSkillEditPrompt(locale: Locale, filePath: string): string {
  if (locale === "de") {
    return [
      "[Beschreibe unten, was sich ändern soll, und schick es ab.]",
      `Lies den Skill unter @${filePath} und ändere ihn wie unten beschrieben.`,
      "Er liegt im eigenen Skill-Bestand dieses Kontos; halte `name` im Frontmatter gleich dem Ordnernamen und die `description` (höchstens 1024 Zeichen) treffend — ohne passende Beschreibung sieht der Agent den Skill nicht.",
      "Änderung:",
    ].join("\n");
  }
  if (locale === "zh-CN") {
    return [
      "[在下面写清要改什么，然后发送。]",
      `先读 @${filePath} 这个技能，再按下面的描述修改。`,
      "它属于你本人账户的技能库；frontmatter 里的 `name` 要和目录名一致，`description`（最多 1024 字符）要写准——描述不对，智能体就看不到这个技能。",
      "要改的地方：",
    ].join("\n");
  }
  return [
    "[Describe below what should change, then send.]",
    `Read the skill at @${filePath} and change it as described below.`,
    "It is one skill in your own store; keep the frontmatter `name` equal to the folder and the `description` (max 1024 chars) accurate — the agent does not see a skill whose description is missing or wrong.",
    "Change:",
  ].join("\n");
}

/**
 * Write the prompt into the new-chat draft *before* the composer mounts.
 *
 * `handleNewSession()` remounts `ChatWindow`, and `ChatInput` reads
 * `new:<cwd>` once on mount; writing afterwards would leave the text in the
 * store and an empty composer on screen. The same seam quick phrases use.
 */
export function prefillNewChat(cwd: string, prompt: string): void {
  setDraft(`new:${cwd}`, { value: prompt, images: [] });
}
