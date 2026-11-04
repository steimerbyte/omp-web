import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./project-size-poll.ts");
}

/**
 * `restart()` — der Weg zurueck nach einem beendeten Poll-Zyklus.
 *
 * Der Poll endet mit `pending: false`. Wird danach ein Projekt angelegt, ist
 * die Antwort nicht mehr endgueltig; ohne `restart()` bliebe die neue Karte
 * fuer immer ohne Groesse. Die zweite Zusage ist die Gegenrichtung: ein
 * `restart()` waehrend eines laufenden Zyklus darf keinen zweiten Poll
 * danebenstellen — ein laufender Zyklus fragt von selbst wieder.
 */
function harness(responses) {
  const timers = [];
  const cleared = [];
  const sizes = [];
  let index = 0;

  const poller = {
    fetchSizes: async () => {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    },
    onSizes: (value) => sizes.push(value),
    projectCount: 1,
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: (handle) => { cleared.push(handle); },
  };

  return {
    poller,
    sizes,
    timers,
    cleared,
    get fetches() { return index; },
    latestTimer: () => timers[timers.length - 1],
  };
}

// Der erste Poll laeuft sofort und synchron bis zum ersten `await`; danach
// muessen die Mikrotasks durchlaufen, bevor der naechste Zustand gilt.
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

test("restart starts a new cycle after the poll ended", async () => {
  const { startSizePoller } = await loadSubject();
  const h = harness([{ sizes: [], pending: false }]);

  const handle = startSizePoller(h.poller);
  await flush();
  assert.equal(h.fetches, 1);

  handle.restart();
  await flush();

  assert.equal(h.fetches, 2, "der zweite Zyklus fragt erneut");
  assert.deepEqual(h.sizes, [[], []], "und meldet das Ergebnis wieder");
});

test("restart during a running cycle does not poll twice", async () => {
  const { startSizePoller } = await loadSubject();
  // `pending: true` haelt den Zyklus am Leben: er stellt einen Timer.
  const h = harness([{ sizes: [], pending: true }]);

  const handle = startSizePoller(h.poller);
  await flush();
  assert.equal(h.fetches, 1);
  assert.equal(h.timers.length, 1, "der laufende Zyklus hat sich selbst neu gestellt");

  handle.restart();
  await flush();

  assert.equal(h.fetches, 1, "ein laufender Zyklus braucht keinen Neustart");
  assert.equal(h.timers.length, 1);
});

test("restart after stop polls again", async () => {
  const { startSizePoller } = await loadSubject();
  const h = harness([{ sizes: [], pending: true }]);

  const handle = startSizePoller(h.poller);
  await flush();
  handle.stop();
  const fetchesAfterStop = h.fetches;

  handle.restart();
  await flush();

  assert.equal(h.fetches, fetchesAfterStop + 1);
  handle.stop();
});
