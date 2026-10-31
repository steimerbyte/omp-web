import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * Die Schreibroute fuer den eigenen Skill-Bestand.
 *
 * Die Tests rufen die **Routen** auf, nicht die Helfer: der Vertrag ist, was
 * ein Mandant ueber HTTP sieht — Status, Datei auf der Platte, und was danach
 * noch da ist. Ein Test auf `createUserSkill()` allein wuerde eine Route
 * durchlassen, die den Namen ungeprueft weiterreicht.
 *
 * Jede Datei liegt unter einer temporaeren `OMP_WEB_HOME_ROOT`; kein Test
 * zeigt auf ein echtes Konto. `alice` und `bob` sind zwei Mandanten, der
 * Fremdzugriff ist der Fall, der 404 und nicht 403 liefern muss.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-skills-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;
// `bun test` shares `globalThis` across files; a fake runtime installed by
// another file would break the tenant settings this route resolves.
delete globalThis.__ompRuntimePromise;

const listRoute = await jiti.import("./route.ts");
const detailRoute = await jiti.import("./[name]/route.ts");

const ORIGIN = "http://localhost:30141";

function headers(username, json = false) {
  return {
    host: "localhost:30141",
    "x-omp-user": username,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function list(username) {
  return listRoute.GET(new NextRequest(`${ORIGIN}/api/skills/user`, { headers: headers(username) }));
}

function create(username, body) {
  return listRoute.POST(new NextRequest(`${ORIGIN}/api/skills/user`, {
    method: "POST",
    headers: headers(username, true),
    body: JSON.stringify(body),
  }));
}

function detail(username, name) {
  return detailRoute.GET(
    new NextRequest(`${ORIGIN}/api/skills/user/${encodeURIComponent(name)}`, { headers: headers(username) }),
    { params: Promise.resolve({ name }) },
  );
}

function update(username, name, body) {
  return detailRoute.PUT(
    new NextRequest(`${ORIGIN}/api/skills/user/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: headers(username, true),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ name }) },
  );
}

function remove(username, name) {
  return detailRoute.DELETE(
    new NextRequest(`${ORIGIN}/api/skills/user/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: headers(username),
    }),
    { params: Promise.resolve({ name }) },
  );
}

function agentDir(username) {
  return join(HOME_ROOT, username, ".omp", "agent");
}

function skillDir(username, name) {
  return join(agentDir(username), "skills", name);
}

function seedSkill(username, name, content) {
  mkdirSync(skillDir(username, name), { recursive: true });
  writeFileSync(join(skillDir(username, name), "SKILL.md"), content);
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("GET legt den Bestand an, registriert ihn und meldet kaputte Skills mit Diagnose", async () => {
  // Ein fremder Key in derselben config.yml darf durch die Registrierung nicht
  // verloren gehen: `settings.set` schreibt den ganzen Baum, nicht nur den Key.
  mkdirSync(agentDir("alice"), { recursive: true });
  writeFileSync(join(agentDir("alice"), "config.yml"), "modelRoles:\n  default: buds-gateway/test-model\n");
  seedSkill("alice", "alpha", "---\nname: alpha\ndescription: Does the alpha thing.\n---\n\n# Alpha\n");
  seedSkill("alice", "broken", "---\nname: broken\n---\n\n# No description\n");
  mkdirSync(skillDir("alice", "half"), { recursive: true });
  mkdirSync(skillDir("alice", "Not_A_Name"), { recursive: true });

  const response = await list("alice");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.directory, join(agentDir("alice"), "skills"));
  // Ohne den Eintrag in config.yml findet loadSkills() den Ordner nicht: das
  // ist die Haelfte von "per user", die man nicht sieht.
  const config = readFileSync(join(agentDir("alice"), "config.yml"), "utf8");
  assert.match(config, /skills:/);
  assert.match(config, /customDirectories:/);
  assert.ok(config.includes(join(agentDir("alice"), "skills")));
  assert.match(config, /modelRoles:/);
  assert.match(config, /default: buds-gateway\/test-model/);

  const byName = Object.fromEntries(body.skills.map((skill) => [skill.name, skill]));
  assert.deepEqual(Object.keys(byName).sort(), ["alpha", "broken", "half"]);
  assert.equal(byName.alpha.source, "custom:user");
  assert.equal(byName.alpha.description, "Does the alpha thing.");
  assert.equal(byName.alpha.diagnostics.length, 0);
  assert.ok(byName.broken.diagnostics.some((entry) => /description/i.test(entry.message)));
  assert.equal(byName.half.hasSkillFile, false);
  // Der Ordner mit ungueltigem Namen wird nicht als Skill verkauft, aber auch
  // nicht verschwiegen: die Meldung nennt ihn.
  assert.ok(body.diagnostics.some((entry) => entry.message.includes("Not_A_Name")));
});

test("POST legt SKILL.md mit Frontmatter an, ein zweites POST liefert 409 und laesst den Text stehen", async () => {
  const created = await create("alice", { name: "beta", description: "Beta skill, 1 line." });
  const createdBody = await created.json();
  assert.equal(created.status, 201);
  assert.equal(createdBody.skill.name, "beta");

  const file = join(skillDir("alice", "beta"), "SKILL.md");
  assert.ok(existsSync(file));
  const text = readFileSync(file, "utf8");
  assert.match(text, /^---\n/);
  assert.match(text, /name: "beta"/);
  assert.match(text, /description: "Beta skill, 1 line\."/);
  assert.match(text, /## Procedure/);

  const before = readFileSync(file, "utf8");
  const again = await create("alice", { name: "beta", description: "Different description." });
  assert.equal(again.status, 409);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("PUT ohne description antwortet 400 und schreibt nichts", async () => {
  const file = join(skillDir("alice", "alpha"), "SKILL.md");
  const before = readFileSync(file, "utf8");
  const response = await update("alice", "alpha", {
    content: "---\nname: alpha\n---\n\n# Broken\n",
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /description/i);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("PUT mit abweichendem name antwortet 400", async () => {
  const response = await update("alice", "alpha", {
    content: "---\nname: other\ndescription: Fine.\n---\n",
  });
  assert.equal(response.status, 400);
});

test("PUT speichert genau die gesendeten Bytes", async () => {
  const content = "---\nname: alpha\ndescription: Updated alpha.\n---\n\n# Neue Fassung\n";
  const response = await update("alice", "alpha", { content });

  assert.equal(response.status, 200);
  assert.equal(readFileSync(join(skillDir("alice", "alpha"), "SKILL.md"), "utf8"), content);
  const reread = await detail("alice", "alpha");
  assert.equal((await reread.json()).content, content);
});

test("GET und DELETE verweigern Traversal und kodierte Trenner", async () => {
  for (const name of ["..", "../alpha", "..%2Falpha", "alpha%2Fbeta", "alpha\\beta", "/etc/passwd"]) {
    assert.equal((await detail("alice", name)).status, 400, `GET ${name}`);
    assert.equal((await remove("alice", name)).status, 400, `DELETE ${name}`);
    assert.equal((await update("alice", name, { content: "x" })).status, 400, `PUT ${name}`);
  }
  // Das Verzeichnis von alice ist unveraendert.
  assert.ok(existsSync(join(skillDir("alice", "alpha"), "SKILL.md")));
});

test("ein Fremdname liefert 404, nie 403 und nie den Inhalt", async () => {
  seedSkill("bob", "bobs-own", "---\nname: bobs-own\ndescription: Bob only.\n---\n");

  const foreignGet = await detail("bob", "alpha");
  assert.equal(foreignGet.status, 404);
  const body = await foreignGet.json();
  assert.equal(body.content, undefined);

  const foreignPut = await update("bob", "alpha", {
    content: "---\nname: alpha\ndescription: Hijacked.\n---\n",
  });
  assert.equal(foreignPut.status, 404);

  const foreignDelete = await remove("bob", "alpha");
  assert.equal(foreignDelete.status, 404);
  assert.ok(existsSync(join(skillDir("alice", "alpha"), "SKILL.md")));

  const bobList = await (await list("bob")).json();
  assert.deepEqual(bobList.skills.map((skill) => skill.name), ["bobs-own"]);
});

test("DELETE entfernt genau ein Verzeichnis", async () => {
  const response = await remove("alice", "broken");
  assert.equal(response.status, 200);

  assert.equal(existsSync(skillDir("alice", "broken")), false);
  assert.ok(existsSync(join(skillDir("alice", "alpha"), "SKILL.md")));
  assert.ok(existsSync(join(skillDir("alice", "beta"), "SKILL.md")));
});

test("DELETE verweigert ein symlinktes Skill-Verzeichnis und laesst das Ziel stehen", async () => {
  symlinkSync(skillDir("alice", "alpha"), skillDir("alice", "linked"), "dir");

  const response = await remove("alice", "linked");
  assert.equal(response.status, 400);
  assert.ok(lstatSync(skillDir("alice", "linked")).isSymbolicLink());
  assert.ok(existsSync(join(skillDir("alice", "alpha"), "SKILL.md")));
});

test("ein nicht vertrautes Projekt sperrt den eigenen Bestand nicht", async () => {
  // Der Bestand liegt ausserhalb des Projekts (`<home>/.omp/agent/skills`), also
  // hat das Projekt-Vertrauen ueber ihn nichts zu sagen. Der Test haelt fest,
  // dass die Verwaltung keine zweite Vertrauenspruefung mitbringt: waere hier
  // ein Trust-Gate eingebaut, faende ein Mandant seinen eigenen Bestand nicht
  // mehr, sobald er ein fremdes Repository geoeffnet hat.
  const { getProjectTrustStatus } = await jiti.import("@/lib/project-trust.ts");
  const project = join(HOME_ROOT, "alice", "projects", "untrusted");
  mkdirSync(join(project, ".omp", "extensions"), { recursive: true });
  const status = getProjectTrustStatus(project, join(HOME_ROOT, "process-agent"));
  assert.equal(status.requiresTrust, true);
  assert.equal(status.trusted, false);

  const created = await create("alice", {
    name: "outside-project",
    description: "Lives in the account store, not in the untrusted project.",
  });
  assert.equal(created.status, 201);

  const read = await detail("alice", "outside-project");
  assert.equal(read.status, 200);
  const content = (await read.json()).content;
  assert.match(content, /outside-project/);

  const updated = await update("alice", "outside-project", {
    content: content.replace("Lives in the account store", "Still lives in the account store"),
  });
  assert.equal(updated.status, 200);
  assert.equal((await remove("alice", "outside-project")).status, 200);
});
