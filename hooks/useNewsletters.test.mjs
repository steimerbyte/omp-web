import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

/**
 * Der Newsletter-Hook — gemountet, mit gestellten Anfragen.
 *
 * Der Hook ist die Naht zwischen Server und Ansicht: er laedt, schreibt und
 * pollt. Die drei Dinge, die schiefgehen koennen, stehen nicht im Quelltext,
 * sondern im Zusammenspiel — eine Antwort, die nach dem Abbau eintrifft; ein
 * Poll, der im Hintergrund-Tab weiterlaeuft; ein Schreibvorgang, der die
 * Liste nicht neu laedt. Deshalb wird hier der Hook gerendert und die
 * Anfragen werden gezaehlt.
 */

const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window;
const ORIGINALS = {
  window: globalThis.window,
  document: globalThis.document,
  fetch: globalThis.fetch,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};

let visibility = "visible";
Object.defineProperty(win.document, "visibilityState", {
  configurable: true,
  get: () => visibility,
});

/** Die Intervalle, die der Hook anlegt — das Poll wird von Hand getickt. */
const intervals = [];
globalThis.window = win;
globalThis.document = win.document;
globalThis.setInterval = (callback, interval) => {
  intervals.push({ callback, interval });
  return intervals.length;
};
globalThis.clearInterval = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { useNewsletters, NEWSLETTER_POLL_MS } = await jiti.import("../hooks/useNewsletters.ts");

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

function newsletter(overrides = {}) {
  return {
    id: "n1",
    name: "AI digest",
    topics: ["agents"],
    provider: "test",
    modelId: "m1",
    taskId: "t1",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    issues: [],
    schedule: { enabled: true, nextRun: 1_800_000_000_000, lastRunAt: null, lastRunStatus: null, cron: "0 8 * * *" },
    ...overrides,
  };
}

let requests = [];
let respond = null;

function json(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function installFetch() {
  requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    return respond(url, init);
  };
}

async function mount() {
  installFetch();
  // Nur die Intervalle dieser Montage: ein Callback aus einem frueheren Test
  // gehoert zu einem abgebauten Hook.
  intervals.length = 0;
  win.document.body.innerHTML = "";
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  let latest = null;
  function Probe() {
    latest = useNewsletters();
    return null;
  }
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return {
    get value() { return latest; },
    async refresh() { await act(async () => { await latest.refresh(); }); },
    async unmount() { await act(async () => { root.unmount(); }); },
  };
}

/** Das vom Hook angelegte Poll-Intervall — nicht irgendein Timer. */
function poll() {
  return intervals.filter((entry) => entry.interval === NEWSLETTER_POLL_MS).at(-1)?.callback;
}

test("loads the list and leaves loading behind", async () => {
  respond = (url) => {
    if (url === "/api/newsletters") return json({ newsletters: [newsletter()] });
    return json({}, 404);
  };
  const harness = await mount();

  assert.equal(harness.value.loading, false);
  assert.equal(harness.value.error, false);
  assert.equal(harness.value.newsletters.length, 1);
  assert.equal(harness.value.newsletters[0].name, "AI digest");
  await harness.unmount();
});

test("create posts the input and reloads the list", async () => {
  respond = (url, init) => {
    if (url === "/api/newsletters" && init?.method === "POST") {
      return json({ newsletter: newsletter({ id: "n2", name: "New" }) }, 201);
    }
    if (url === "/api/newsletters") return json({ newsletters: [newsletter(), newsletter({ id: "n2", name: "New" })] });
    return json({}, 404);
  };
  const harness = await mount();
  const before = requests.filter((request) => request.method === "GET").length;

  let created;
  await act(async () => {
    created = await harness.value.create({ name: "New", topics: ["x"], cron: "0 8 * * *", provider: "test", modelId: "m1" });
  });

  const post = requests.find((request) => request.method === "POST");
  assert.deepEqual(post.body, { name: "New", topics: ["x"], cron: "0 8 * * *", provider: "test", modelId: "m1" });
  assert.equal(created.id, "n2");
  assert.ok(requests.filter((request) => request.method === "GET").length > before, "die Liste wurde nicht neu geladen");
  assert.equal(harness.value.newsletters.length, 2);
  await harness.unmount();
});

test("update patches one newsletter and remove deletes it", async () => {
  respond = (url, init) => {
    if (url === "/api/newsletters/n1" && init?.method === "PATCH") {
      return json({ newsletter: newsletter({ name: "Renamed" }) });
    }
    if (url === "/api/newsletters/n1" && init?.method === "DELETE") return json({ ok: true });
    if (url === "/api/newsletters") return json({ newsletters: [] });
    return json({}, 404);
  };
  const harness = await mount();

  await act(async () => {
    await harness.value.update("n1", { name: "Renamed" });
  });
  assert.deepEqual(requests.find((request) => request.method === "PATCH").body, { name: "Renamed" });

  await act(async () => {
    await harness.value.remove("n1");
  });
  assert.ok(requests.some((request) => request.method === "DELETE" && request.url === "/api/newsletters/n1"));
  assert.deepEqual(harness.value.newsletters, []);
  await harness.unmount();
});

test("runNow returns the session id and reloads the schedule", async () => {
  respond = (url, init) => {
    if (url === "/api/newsletters/n1/run" && init?.method === "POST") return json({ sessionId: "s9" });
    if (url === "/api/newsletters") return json({ newsletters: [newsletter()] });
    return json({}, 404);
  };
  const harness = await mount();
  const before = requests.filter((request) => request.url === "/api/newsletters").length;

  let sessionId;
  await act(async () => {
    sessionId = await harness.value.runNow("n1");
  });

  assert.equal(sessionId, "s9");
  assert.ok(requests.filter((request) => request.url === "/api/newsletters").length > before);
  await harness.unmount();
});

test("the poll refreshes while the tab is visible and stays quiet while it is hidden", async () => {
  respond = () => json({ newsletters: [newsletter()] });
  const harness = await mount();
  const tick = poll();
  assert.ok(tick, "der Hook hat kein Poll-Intervall angelegt");

  const visibleCount = requests.length;
  await act(async () => { tick(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(requests.length, visibleCount + 1, "der sichtbare Tab hat nicht gepollt");

  visibility = "hidden";
  const hiddenCount = requests.length;
  await act(async () => { tick(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(requests.length, hiddenCount, "der versteckte Tab hat trotzdem gepollt");

  // Zurueck im Vordergrund: der Wechsel selbst frischt auf, ohne auf den
  // naechsten Takt zu warten.
  visibility = "visible";
  await act(async () => {
    win.document.dispatchEvent(new win.Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(requests.length > hiddenCount, "der Wechsel in den Vordergrund hat nicht geladen");

  await harness.unmount();
});

test("a failed load is an error the view can retry", async () => {
  // Die Fehlerantwort ist kein JSON: der Grund kommt aus dem Status, nicht
  // aus einem Koerper, den es nicht gibt.
  respond = () => ({ ok: false, status: 503, json: async () => { throw new Error("not json"); } });
  const harness = await mount();

  assert.equal(harness.value.error, true);
  assert.equal(harness.value.newsletters, null);
  assert.equal(harness.value.loading, false);

  respond = () => json({ newsletters: [newsletter()] });
  await harness.refresh();
  assert.equal(harness.value.error, false);
  assert.equal(harness.value.newsletters.length, 1);
  await harness.unmount();
});
