/**
 * Attrappe fuer den TerminalManager in den Routen-Tests.
 *
 * `getTerminalManager()` haelt seinen Manager in einer Modulvariablen. Bei
 * nativen Imports teilen sich alle Testdateien dieselbe Instanz — die Attrappe
 * der ersten Datei wuerde dann fuer alle weiteren gelten, und mit `--parallel`
 * wuerden sie sich gegenseitig ueberschreiben. Deshalb laedt jede Testdatei
 * ihren eigenen Modulgraphen ueber eine eigene jiti-Instanz; `install()`
 * legt den Manager in `globalThis.__ompTerminalManager` und ruft
 * `getTerminalManager()` genau einmal, damit der Graph ihn cacht. Danach wird
 * das globale Feld zurueckgegeben.
 *
 * `TerminalUnavailableError` kommt aus demselben Graphen wie die Route; eine
 * zweite Klasse aus einem anderen Graphen wuerde den 503-Zweig unerreichbar
 * machen (`instanceof`).
 */

export function makeTerminalInfo(overrides = {}) {
  return {
    id: "term-1",
    cwd: "/tmp",
    pid: 4242,
    status: "running",
    exitCode: null,
    shell: "/bin/bash",
    cols: 80,
    rows: 24,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_001_000,
    owner: "alice",
    sandboxed: true,
    ...overrides,
  };
}

/**
 * Setzt die Attrappe als Manager des Modulgraphen, dem `getManager` gehoert.
 * `getManager` ist `getTerminalManager` aus genau dem Graphen, den auch die
 * Route importiert.
 *
 * `getTerminalManager` cached seinen Manager in einer Modulvariablen. jiti
 * teilt den Modulgraphen zwischen den Testdateien eines Prozesses (gemessen:
 * die zweite Datei bekam den Manager der ersten), also wird der bereits
 * gecachte Manager nicht ersetzt, sondern mit den Methoden dieser Attrappe
 * bestueckt. `apply()` ist idempotent und wird von den Testdateien vor jedem
 * Test erneut gerufen, damit ein spaeteres `install()` einer anderen Datei
 * nicht mitten im Lauf gilt.
 */
export function installFakeTerminalManager(getManager) {
  const terminals = new Map();
  const owners = new Map();
  const calls = {
    listAll: 0,
    listOwnedBy: [],
    spawn: [],
    killed: [],
    writes: [],
    resizes: [],
    attached: [],
    detached: 0,
  };

  const add = (info, owner = info.owner) => {
    terminals.set(info.id, info);
    owners.set(info.id, owner);
    return info;
  };

  const manager = {
    terminals,
    owners,
    calls,
    add,
    listAll() {
      calls.listAll += 1;
      return [...terminals.values()];
    },
    listOwnedBy(owner) {
      calls.listOwnedBy.push(owner);
      return [...terminals.entries()]
        .filter(([id]) => owners.get(id) === owner)
        .map(([, info]) => info);
    },
    get(id) {
      return terminals.get(id);
    },
    isOwnedBy(id, owner) {
      return owners.get(id) === owner;
    },
    async spawn(cwd, cols, rows, owner, isAdmin) {
      calls.spawn.push({ cwd, cols, rows, owner, isAdmin });
      return add(makeTerminalInfo({ cwd, cols, rows, owner, sandboxed: !isAdmin }));
    },
    async kill(id) {
      calls.killed.push(id);
    },
    async write(id, data) {
      calls.writes.push([id, data]);
    },
    async resize(id, cols, rows) {
      calls.resizes.push([id, cols, rows]);
    },
    attach(id, writer) {
      calls.attached.push({ id, writer });
      return () => {
        calls.detached += 1;
      };
    },
  };

  /** Haengt den Zustand an den gecachten Manager und gibt ihn zurueck. */
  const apply = () => {
    const previous = globalThis.__ompTerminalManager;
    globalThis.__ompTerminalManager = manager;
    let cached;
    try {
      cached = getManager();
    } finally {
      if (previous === undefined) delete globalThis.__ompTerminalManager;
      else globalThis.__ompTerminalManager = previous;
    }
    if (cached !== manager) {
      Object.assign(cached, manager, { terminals, owners, calls, add });
    }
    return cached;
  };

  const state = { manager: apply(), calls, add, apply };
  return state;
}

/** Eine Absage mit genau dem Grund, den `planSandboxSpawn` liefern wuerde. */
export function sandboxRefusal(ErrorClass, reason) {
  return new ErrorClass(reason, `detail for ${reason}`, `remediation for ${reason}`);
}
