/**
 * Measured from a separate process on purpose: `getAgentDir()` resolves once at
 * import, so `PI_CODING_AGENT_DIR` can only be varied across processes.
 *
 * Prints what a session for `PROBE_CWD` loads. `loadSessionSkills` is the path
 * `startRpcSession` and `GET /api/skills` share; a tree without it falls back to
 * raw discovery, which is exactly the pre-gate behaviour a failing test must
 * show instead of a "missing export" error.
 *
 * `PROBE_IDENTITY` measures the session's real Settings resolution
 * (`getSettingsForIdentity`: isolated instance over the account's agent dir,
 * cloned for the cwd). Without it the probe loads the same two layers directly
 * with `Settings.loadIsolated`. Both read the project layer; `Settings.isolated()`
 * does **not**, and with it the `customDirectories` cases below would measure an
 * empty list — the project could not smuggle a skill in and the test would pass
 * for the wrong reason.
 */
const { Settings, loadSkills } = await import("@oh-my-pi/pi-coding-agent");
const { cfgSkills } = await import("@oh-my-pi/pi-coding-agent/extensibility/settings");

const settings = process.env.PROBE_IDENTITY
  ? await (await import(new URL("./omp-runtime.ts", import.meta.url).href)).getSettingsForIdentity(
      { username: process.env.PROBE_IDENTITY, isAdmin: false },
      process.env.PROBE_CWD,
    )
  : await Settings.loadIsolated({
      cwd: process.env.PROBE_CWD,
      agentDir: process.env.PI_CODING_AGENT_DIR,
    });
const service = await import(new URL("./skills-service.ts", import.meta.url).href);

if (typeof service.loadSessionSkills === "function") {
  const { skills, trusted, withheld } = await service.loadSessionSkills(process.env.PROBE_CWD, settings);
  console.log(JSON.stringify({ names: skills.map((skill) => skill.name).sort(), trusted, withheld }));
} else {
  const discovered = await loadSkills({ cwd: process.env.PROBE_CWD, ...cfgSkills.get(settings) });
  console.log(JSON.stringify({
    names: discovered.skills.map((skill) => skill.name).sort(),
    trusted: undefined,
    withheld: 0,
  }));
}
