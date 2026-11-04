import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-paths.ts");
}

/**
 * `getRelativeFilePath` ist die Anzeige-Form eines Pfades: ein Pfad unterhalb
 * des Arbeitsverzeichnisses wird relativ, alles andere bleibt, wie es ist.
 * Ein zu grosszuegiges `startsWith` macht aus `/repo-other/x` ein `../..` —
 * deshalb die Grenze am Schraegstrich.
 */
test("a path below the cwd becomes relative", async () => {
  const { getRelativeFilePath } = await loadSubject();

  assert.equal(getRelativeFilePath("/repo/src/app.ts", "/repo"), "src/app.ts");
  assert.equal(getRelativeFilePath("/repo/src/app.ts", "/repo/"), "src/app.ts");
});

test("the path stays absolute when the cwd is not its parent", async () => {
  const { getRelativeFilePath } = await loadSubject();

  assert.equal(getRelativeFilePath("/repo-other/app.ts", "/repo"), "/repo-other/app.ts");
  assert.equal(getRelativeFilePath("/etc/hosts", "/repo"), "/etc/hosts");
});

test("without a cwd the path is returned unchanged", async () => {
  const { getRelativeFilePath } = await loadSubject();

  assert.equal(getRelativeFilePath("/repo/src/app.ts"), "/repo/src/app.ts");
});

test("windows separators are normalized before the comparison", async () => {
  const { getRelativeFilePath } = await loadSubject();

  assert.equal(getRelativeFilePath("C:\\repo\\src\\app.ts", "C:\\repo"), "src/app.ts");
});
