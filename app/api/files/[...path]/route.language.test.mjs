import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { createJiti } from "jiti";

/**
 * Der Viewer faerbt nach `language` ein, das die Route aus der Endung ableitet.
 * Julia fehlte in der Tabelle, `.jl` kam als Klartext an und blieb ungefaerbt.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const HOME_ROOT = mkdtempSync(join(tmpdir(), "omp-web-language-home-"));
process.env.OMP_WEB_HOME_ROOT = HOME_ROOT;

const HOME = join(HOME_ROOT, "reader");
mkdirSync(join(HOME, "projects", "langs"), { recursive: true });

const filesRoute = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access");
allowFileRoot(HOME, { username: "reader", isAdmin: false });

const ORIGIN = "http://localhost:30141";

function read(filePath) {
  const segments = filePath.split("/").filter(Boolean);
  const url = `${ORIGIN}/api/files/${segments.map(encodeURIComponent).join("/")}?type=read`;
  return filesRoute.GET(
    new NextRequest(url, { headers: { host: "localhost:30141", "x-omp-user": "reader" } }),
    { params: Promise.resolve({ path: segments }) },
  );
}

test.after(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

test("Julia-Quelltext kommt mit language=julia an", async () => {
  const file = join(HOME, "projects", "langs", "run.jl");
  writeFileSync(file, "function square(x::Int)\n  x * x\nend\n");

  const response = await read(file);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).language, "julia");
});

test("die bestehende Endungstabelle gilt unveraendert weiter", async () => {
  const file = join(HOME, "projects", "langs", "run.py");
  writeFileSync(file, "print('ok')\n");

  const response = await read(file);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).language, "python");
});
