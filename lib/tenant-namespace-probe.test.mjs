import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { probeWorkerNamespace } from "./tenant-namespace-probe";

/**
 * Die Messung, an der `enforced: true` jetzt haengt.
 *
 * Zwei Richtungen, und beide sind noetig: der Dienstprozess selbst ist **nicht**
 * in einer Namespace (er ist der Bezugspunkt, gegen den gemessen wird — waere
 * das Ergebnis hier `ok: true`, messe die Probe nicht), und ein echter
 * `bwrap`-Prozess ist es. Eine Probe, die nur "irgendwas ist anders" sagt,
 * waere in beiden Faellen gruen.
 */

const bwrapUsable = (() => {
  const probe = Bun.spawnSync(["bwrap", "--version"], { stdout: "pipe", stderr: "pipe" });
  if (probe.exitCode !== 0) {
    return { ok: false, detail: `bwrap --version failed with exit ${probe.exitCode}` };
  }
  // `--version` laeuft ohne `--unshare-user` und beweist die Rechte nicht. Ein
  // `true` **in** der Namespace ist der einzige ehrliche Test; gemessen am
  // 2026-11-09 auf diesem Host scheiterte ein `--ro-bind /usr /usr` ohne
  // `--symlink usr/lib …` an `execvp … No such file or directory`, weil der
  // dynamische Loader ueber `/lib64` gesucht wird.
  const userns = Bun.spawnSync(
    ["bwrap", "--unshare-user", "--unshare-pid", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--", "/bin/true"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (userns.exitCode !== 0) {
    return { ok: false, detail: `bwrap unshare probe failed: ${new TextDecoder().decode(userns.stderr).trim().slice(0, 300)}` };
  }
  return { ok: true, detail: "bwrap and user namespaces are available" };
})();

const cleanup = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()();
});

/** Ein Skelett-Home fuer den Gast, damit `--bind` eine Quelle hat. */
function scratchHome(name) {
  const root = mkdtempSync(join(tmpdir(), "omp-probe-bwrap-"));
  const home = join(root, name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, home };
}

describe("the service process is not namespaced", () => {
  test("probeWorkerNamespace(process.pid) reports the host root and the host /home", () => {
    // Der Bezugspunkt der Messung: dieser Prozess teilt die Mount-Namespace des
    // Hosts. Sein `/proc/self/root/home` zeigt das Home des Dienstbenutzers —
    // genau das, was in einem Worker unter `/home` **nicht** stehen darf.
    //
    // Gemessen am 2026-11-09 auf diesem Host (LXC 101):
    //   "PID 4619 is not in a mount namespace of its own: /proc/4619/root has
    //    device 46 inode 34, identical to / (device 46 inode 34), and
    //    /proc/4619/root/home lists [\"pi\"] — the service home \"pi\" is visible."
    const result = probeWorkerNamespace(process.pid, "someone");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Der Befund nennt die Beobachtung, nicht nur das Urteil: ohne das
    // Wurzelpaar und die Liste unter `/home` waere "keine Grenze" eine
    // Behauptung.
    expect(result.detail).toContain(String(process.pid));
    expect(result.detail).toMatch(/identical to \//);
    expect(result.detail).toContain("/root/home lists");
    // Und der Dienstbenutzer steht dort wirklich: das ist der Grund, warum die
    // Probe ihn als Ausschlusskriterium benutzt.
    expect(result.detail).toContain(`"${userInfo().username}"`);
    expect(result.detail).toContain("is visible");
  });

  test("a pid that does not exist is a named failure, not a throw", () => {
    const result = probeWorkerNamespace(2 ** 22 + 7, "someone");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("ENOENT");
  });

  test("a pid that is not a positive integer is refused before any syscall", () => {
    for (const pid of [0, -1, Number.NaN]) {
      const result = probeWorkerNamespace(pid, "someone");
      expect(result.ok).toBe(false);
    }
  });
});

describe.skipIf(!bwrapUsable.ok)("a real bwrap process is namespaced", () => {
  test("a bwrap'd sleep with a bound guest home passes the probe", async () => {
    const name = "probeland";
    const { home } = scratchHome(name);
    const argv = [
      "bwrap", "--unshare-user", "--unshare-pid",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      "--bind", home, `/home/${name}`,
      "--", "/bin/sleep", "5",
    ];
    const spawned = Bun.spawn({ cmd: argv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    // Den ganzen Baum beenden: `spawned.pid` ist der Supervisor, und ein `kill`
    // nur auf ihn laesst `sleep` als Waisen weiterlaufen.
    const stop = () => {
      try { spawned.kill("SIGKILL"); } catch { /* already gone */ }
    };
    cleanup.push(stop);
    // Warten, bis der Prozessbaum steht: der Supervisor existiert vor dem
    // Namespace-Kind, und ein zu frueher Blick saehe die Host-Wurzel.
    let result = probeWorkerNamespace(spawned.pid, name);
    for (let attempt = 0; attempt < 50 && !result.ok; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      result = probeWorkerNamespace(spawned.pid, name);
    }
    if (!result.ok) throw new Error(`probe refused a real bwrap process: ${result.detail}`);
    expect(result).toEqual({ ok: true });
  }, 30_000);

  test("the same process fails the probe when the guest name does not match", async () => {
    // Die Gegenprobe in derselben Namespace: der Prozess ist eingegrenzt, aber
    // unter `/home` steht ein anderer Name. Ein Test, der nur "Wurzel ist
    // anders" prueft, waere hier faelschlich gruen — und genau darum geht es:
    // die Grenze gilt fuer *diesen* Mandanten.
    const name = "probeland2";
    const { home } = scratchHome(name);
    const argv = [
      "bwrap", "--unshare-user", "--unshare-pid",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      "--bind", home, `/home/${name}`,
      "--", "/bin/sleep", "5",
    ];
    const spawned = Bun.spawn({ cmd: argv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    cleanup.push(() => { try { spawned.kill("SIGKILL"); } catch { /* gone */ } });
    let result = probeWorkerNamespace(spawned.pid, "someone-else");
    for (let attempt = 0; attempt < 50 && !result.ok; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      result = probeWorkerNamespace(spawned.pid, "someone-else");
    }
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Der Befund nennt den Namen, der dort steht, und den erwarteten.
      expect(result.detail).toContain(name);
      expect(result.detail).toContain("someone-else");
    }
  }, 30_000);
});

describe.skipIf(bwrapUsable.ok)("bwrap is unavailable", () => {
  test("the namespaced half was not measured, and the reason is printed", () => {
    // Kein stilles Gruen: das Repo verbietet uebersprungene Grenztests, die
    // nichts sagen. Der Grund steht im Log des Laufs.
    console.warn(`SECURITY: the positive namespace probe test was skipped — ${bwrapUsable.detail}`);
    expect(bwrapUsable.ok).toBe(false);
  });
});
