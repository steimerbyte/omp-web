import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { createJiti } from "jiti";

/**
 * Der Anlegen-Dialog ueberlebt die echte Antwort von `/api/models`.
 *
 * ### Was dieser Test gefangen haette
 *
 * `TaskDialog` las `body.models` und rief `.map` darauf. `models` ist in der
 * Antwort von `/api/models` aber eine **Zuordnung** `"provider:id" → Name`
 * (`lib/models-cache.ts:ModelsData`); die Liste mit Provider-Angabe heisst
 * `modelList`. Im echten Browser war das ein `TypeError: (S ?? []).map is not
 * a function` mitten im Commit: React verwarf den Baum, und die ganze App
 * wurde durch Next' globale Fehlerseite ersetzt ("This page couldn't load") —
 * gemessen an v0.14.0, sobald der Dialog mit einem angemeldeten Konto aufging.
 *
 * Eine Pruefung des Quelltextes faengt das nicht: `body.models ?? []` sieht
 * richtig aus, und der Fehler entsteht erst, wenn ein Objekt durch `.map`
 * laeuft. Deshalb wird hier die echte Komponente gemountet und der echte
 * Dialog geoeffnet, mit der echten Antwortform — und danach wird die
 * Modellauswahl gelesen, nicht der Zustand.
 *
 * ### Warum die Form aus dem Repo und nicht von Hand kommt
 *
 * `ModelsData` liegt hinter dem omp-SDK (`lib/models-cache.ts` importiert
 * `@oh-my-pi/*`), also wird die Nutzlast hier als Literal nachgebaut — mit
 * beiden Feldern in der Form, die der Typ nennt. Der Test prueft damit die
 * Aufteilung, die der Fehler verwechselt hat.
 */

const dom = linkedom.parseHTML(`<!doctype html><html><body></body></html>`);
const win = dom.window;
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };

// Radix fragt beim Einrasten die Scrollbar-Breite ueber `getComputedStyle` ab;
// linkedom fuehrt kein Layout aus und liefert sonst einen TypeError, bevor
// der Dialog ueberhaupt mountet.
win.getComputedStyle = () => new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && prop.startsWith("get") ? () => "" : "0px"),
});

globalThis.window = new Proxy(win, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = win.document;
globalThis.navigator = fakeNavigator;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
for (const name of Object.keys(win)) {
  if (name === "window") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = win[name];
}
globalThis.Event = win.Event;
globalThis.EventTarget = win.EventTarget;

/**
 * React 19 entscheidet beim Auswerten von `react-dom`, ob es `onChange` an
 * kontrollierten Feldern ueber `input` oder ueber den alten Polyfill-Pfad
 * ausloest, und fragt dafuer nach `oninput` auf dem `document`. linkedom hat
 * das nicht, also faellt die Antwort dauerhaft auf `false`, und `onChange`
 * wird **nie** gerufen: das Cron-Feld bliebe in diesem Harness auf seinem
 * Anfangswert, `canSave` waere konstant, und eine Pruefung der Live-Validierung
 * waere nicht messbar. Quelle der Messung: `calendar-event-dialog.test.mjs`,
 * `app/login/login-username-prefill.test.mjs`.
 */
win.document.oninput = null;
win.document.onchange = null;
win.HTMLElement.prototype.attachEvent = function attachEvent(type, handler) {
  this.addEventListener(type.replace(/^on/, ""), handler);
};
win.HTMLElement.prototype.detachEvent = function detachEvent(type, handler) {
  this.removeEventListener(type.replace(/^on/, ""), handler);
};

win.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
  onchange: null,
  dispatchEvent() { return false; },
});
globalThis.matchMedia = win.matchMedia;

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
};

/**
 * Die Antwort von `/api/models`, in der Form aus `ModelsData`.
 *
 * `models` ist die Zuordnung und `modelList` die Liste — genau die
 * Unterscheidung, die der Dialog verwechselt hat. Beide stehen hier, weil ein
 * Test mit nur einem der beiden Felder den Fehler nicht reproduziert: mit
 * fehlendem `models` lieferte `?? {}` ein Objekt, das ebenso wenig `.map`
 * hat, aber mit fehlendem `modelList` haette die kaputte Zeile `undefined`
 * gesehen und still eine leere Auswahl gezeigt.
 */
const MODELS_RESPONSE = {
  models: {
    "buds-gateway/qwen3.8-27b": "Qwen 3.8 27B",
    "buds-gateway/deepseek-v4.1-flash-1017": "DeepSeek V4.1 Flash",
  },
  modelList: [
    { id: "qwen3.8-27b", name: "Qwen 3.8 27B", provider: "buds-gateway" },
    { id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", provider: "buds-gateway" },
  ],
  defaultModel: { provider: "buds-gateway", modelId: "deepseek-v4.1-flash-1017" },
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
  roles: [],
};

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});

// Scoped and put back afterwards: `lib/http-dispatcher.ts` snapshots
// `globalThis.fetch` when it loads (see `DialogFocus.test.mjs`).
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  if (url.startsWith("/api/models")) return json(MODELS_RESPONSE);
  if (url.startsWith("/api/scheduled-tasks")) return json({ tasks: [] });
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
};
test.after(() => { globalThis.fetch = originalFetch; });

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { ScheduledTasksView } = await jiti.import("./ScheduledTasksView.tsx");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
}

/**
 * Mountet die Ansicht — mit `locale` in der Sprache, die der Test sehen will.
 *
 * `I18nProvider` liest die Sprache aus `localStorage` (`pi-locale`) und
 * registriert sie im Effekt, also muss der Wert *vor* dem ersten Render
 * stehen. Ohne diesen Parameter liefe jeder Test in der Browsersprache des
 * Harness, und "kein deutscher Text in der englischen Oberflaeche" waere nicht
 * pruefbar.
 */
async function mountView(locale = "en") {
  win.document.body.innerHTML = "";
  localStorage.setItem("pi-locale", locale);
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(I18nProvider, null, React.createElement(ScheduledTasksView, null))); });
  await settle();
  return { root, container };
}

/**
 * Tippt in ein React-Eingabefeld, wie ein Browser es tut.
 *
 * Ein gesetztes `.value` allein loest an einem kontrollierten Feld nichts aus;
 * React hoert auf `input`, und wenn `isInputEventSupported` beim Laden von
 * `react-dom` auf `false` gefallen ist (linkedom kennt `document.oninput`
 * nicht), nimmt es den alten Polyfill-Pfad und loest `onChange` ueber `keyup`
 * auf dem aktiven Element aus. Deshalb laufen `focusin`, `input` und `keyup`
 * zusammen — mit `input` allein blieb der Zustand gemessen leer
 * (`calendar-event-dialog.test.mjs`, `app/login/login-username-prefill.test.mjs`).
 */
async function setInputValue(input, value) {
  await act(async () => {
    input.dispatchEvent(new win.Event("focusin", { bubbles: true }));
  });
  await act(async () => {
    // Der native Setter, nicht `input.value = …`: React haengt einen
    // Value-Tracker an die Instanz, und ein Schreiben ueber die eigene
    // Eigenschaft aktualisiert ihn mit. Beim Event vergleicht React dann
    // "alt == neu" und verwirft das `change` — das Feld saehe getippt aus,
    // der Zustand bliebe der alte.
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("keyup", { bubbles: true }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

/** Die Beschriftungen aller Preset-Knoepfe im Dialog, in ihrer Reihenfolge. */
function presetLabels() {
  const fieldset = win.document.querySelector('[data-slot="dialog-content"] fieldset');
  return [...fieldset.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
}

/** Die Optionen des Wochentagsfeldes als `[value, label]`. */
function weekdayOptions() {
  const select = win.document.querySelector("#scheduled-weekday");
  return [...select.querySelectorAll("option")].map((o) => [o.getAttribute("value"), (o.textContent ?? "").trim()]);
}

/** Ein Knopf nach seinem Text; die Beschriftung kommt aus dem Sprachpaket. */
function buttonByText(text) {
  return [...win.document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text);
}

test("Der Anlegen-Dialog rendert die Modelle aus modelList", async () => {
  const { root } = await mountView();

  const open = buttonByText("New scheduled task");
  assert.ok(open, "der Knopf zum Anlegen fehlt");

  // Der Aufruf selbst ist der Befund: mit der alten Zeile
  // (`body.models ?? []` und `.map`) wirft React hier `map is not a function`,
  // und ein Throw in einem Commit nimmt den ganzen Baum mit. `act` reicht ihn
  // an den Test weiter, also scheitert der Test an derselben Stelle.
  await act(async () => { open.click(); });
  await settle();

  const dialog = win.document.querySelector('[data-slot="dialog-content"]');
  assert.ok(dialog, "der Dialog ist nicht aufgegangen");

  const select = dialog.querySelector("#scheduled-model");
  assert.ok(select, "die Modellauswahl fehlt");
  const options = [...select.querySelectorAll("option")].map((o) => (o.textContent ?? "").trim());
  assert.ok(
    options.includes("Qwen 3.8 27B"),
    `die Modelle aus modelList fehlen in der Auswahl: ${JSON.stringify(options)}`,
  );
  assert.ok(options.includes("DeepSeek V4.1 Flash"), `die zweite Modellzeile fehlt: ${JSON.stringify(options)}`);

  // Die Zuordnung `models` darf nicht als Option auftauchen — sie ist keine
  // Liste, und ihre Schluessel sind keine Auswahl.
  assert.ok(
    !options.some((label) => label.includes("[object Object]")),
    `ein Objekt ist als Beschriftung in die Auswahl gelaufen: ${JSON.stringify(options)}`,
  );

  await act(async () => { root.unmount(); });
});

test("Der Dialog bleibt benutzbar, wenn /api/models fehlschlaegt", async () => {
  const failingFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.startsWith("/api/models")) return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    return failingFetch(input);
  };
  try {
    const { root } = await mountView();
    const open = buttonByText("New scheduled task");
    assert.ok(open, "der Knopf zum Anlegen fehlt");
    await act(async () => { open.click(); });
    await settle();

    const select = win.document.querySelector("#scheduled-model");
    assert.ok(select, "der Dialog ist bei einem Modell-Fehler nicht aufgegangen");
    assert.equal(select.querySelectorAll("option").length, 1, "erwartet nur den Platzhalter");

    // Finding #1/#2: der Grund war unsichtbar. Ein leerer Kasten mit
    // deaktiviertem Speichern sieht wie "es gibt keine Modelle" aus, obwohl die
    // Anfrage gescheitert ist — und niemand kann etwas dagegen tun.
    const alerts = [...win.document.querySelectorAll('[role="alert"]')].map((n) => (n.textContent ?? "").trim());
    assert.ok(
      alerts.some((text) => text.includes("could not be loaded")),
      `kein sichtbarer Grund fuer die leere Modellliste: ${JSON.stringify(alerts)}`,
    );

    await act(async () => { root.unmount(); });
  } finally {
    globalThis.fetch = failingFetch;
  }
});

// --- Sprache der Oberflaeche (Finding #6/#7) -----------------------------------

test("Die Presets und die Beschreibung stehen in der Sprache der Oberflaeche", async () => {
  for (const [locale, expected] of [
    ["en", ["Hourly", "Every 15 minutes", "Daily at 08:00", "Weekdays at 08:00", "Mondays at 08:00"]],
    ["de", ["Stündlich", "Alle 15 Minuten", "Täglich um 08:00", "Werktags um 08:00", "Montags um 08:00"]],
    ["zh-CN", ["每小时", "每 15 分钟", "每天 08:00", "工作日 08:00", "每周一 08:00"]],
  ]) {
    const { root } = await mountView(locale);
    const open = buttonByText(locale === "de" ? "Neue geplante Aufgabe" : locale === "zh-CN" ? "新建计划任务" : "New scheduled task");
    assert.ok(open, `der Knopf zum Anlegen fehlt in ${locale}`);
    await act(async () => { open.click(); });
    await settle();

    assert.deepEqual(presetLabels(), expected, `Die Presets sind in ${locale} nicht in dieser Sprache`);

    // Die Live-Beschreibung kommt aus dem Deskriptor und dem Katalog, nicht aus
    // einem fertigen deutschen Satz in `lib/schedule.ts`.
    await act(async () => { win.document.querySelector("#scheduled-cron").value = "0 8 * * *"; });
    const cron = win.document.querySelector("#scheduled-cron");
    await act(async () => {
      cron.value = "0 8 * * *";
      cron.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    await settle();
    const help = (win.document.querySelector("#scheduled-cron-help").textContent ?? "").trim();
    assert.equal(help, expected[2], `Die Beschreibung ist in ${locale} falsch: ${help}`);

    await act(async () => { root.unmount(); });
  }
});

test("In der englischen Oberflaeche steht kein deutscher Text im Dialog", async () => {
  // Der eigentliche Befund aus #6/#7: gemischte Sprachen. Ein Test auf die
  // Kataloge sieht das nicht — er sieht nur, dass die Schluessel existieren.
  // "Minute" fehlt absichtlich: das Wort ist im Englischen dasselbe und
  // taugt nicht als Leck-Test. "Stunde"/"Wochentag" sind es nicht.
  const germanWords = ["Stündlich", "Täglich", "Werktags", "Montags", "Stunde", "Wochentag", "täglich", "werktags", "Sonntag", "Montag"];
  const { root } = await mountView("en");
  const open = buttonByText("New scheduled task");
  assert.ok(open);
  await act(async () => { open.click(); });
  await settle();

  const dialogText = win.document.querySelector('[data-slot="dialog-content"]').textContent ?? "";
  for (const word of germanWords) {
    assert.ok(!dialogText.includes(word), `deutscher Text in der englischen Oberflaeche: "${word}"`);
  }
  // Die Wochentagsnamen sind uebersetzt, nicht nur die drei Labels.
  assert.ok(weekdayOptions().some(([, label]) => label === "Sunday"));
  assert.ok(weekdayOptions().some(([, label]) => label === "Weekdays"));

  await act(async () => { root.unmount(); });
});

// --- Sonntag als 7 (Finding #4) ------------------------------------------------

test("Der Wochentag 7 ist waehlbar und bleibt beim Speichern Sonntag", async () => {
  // Der Befund: `parseSchedule` akzeptiert 7 als Sonntag, das Auswahlfeld
  // kannte den Wert nicht. Ein `<select>` ohne passende `<option>` zeigt in
  // Chromium den ersten Eintrag — ein gespeicherter Sonntag wurde beim
  // naechsten Speichern stillschweigend zu "taeglich".
  const { root } = await mountView("en");
  const open = buttonByText("New scheduled task");
  await act(async () => { open.click(); });
  await settle();

  const values = weekdayOptions().map(([value]) => value);
  assert.ok(values.includes("7"), `7 fehlt im Wochentagsfeld: ${JSON.stringify(values)}`);

  // linkedom hat am `<select>` keinen `value`-Setter (nur einen Getter), also
  // wird die Auswahl ueber `option.selected` gesetzt — das ist auch der Weg,
  // den ein Browser beim Klicken nimmt.
  await act(async () => {
    const select = win.document.querySelector("#scheduled-weekday");
    select.querySelector('option[value="7"]').selected = true;
    select.dispatchEvent(new win.Event("change", { bubbles: true }));
  });
  await settle();

  const cron = win.document.querySelector("#scheduled-cron");
  assert.equal(cron.value, "0 8 * * 7", "der Wochentag 7 wurde nicht in den Cron geschrieben");
  // Und die Beschreibung nennt ihn Sonntag — nicht Montag, nicht "taeglich".
  const help = (win.document.querySelector("#scheduled-cron-help").textContent ?? "").trim();
  assert.equal(help, "Sunday at 08:00");

  await act(async () => { root.unmount(); });
});

test("Ein gespeicherter Cron mit Wochentag 7 oeffnet den Editor auf Sonntag", async () => {
  // Die Gegenrichtung: der Wert kommt aus der Datei, nicht vom Klick.
  const tasksFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.startsWith("/api/scheduled-tasks") && (init?.method ?? "GET") === "GET") {
      return json({
        tasks: [{
          id: "sunday-task",
          name: "Sunday report",
          cron: "0 8 * * 7",
          prompt: "p",
          provider: "buds-gateway",
          modelId: "qwen3.8-27b",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          nextRun: null,
        }],
      });
    }
    return tasksFetch(input, init);
  };
  try {
    const { root } = await mountView("en");
    const edit = buttonByText("Edit");
    assert.ok(edit, "die Aufgabe wurde nicht gelistet");
    await act(async () => { edit.click(); });
    await settle();

    assert.equal(win.document.querySelector("#scheduled-weekday").value, "7",
      "der Editor hat den gespeicherten Sonntag nicht uebernommen");
    assert.equal(win.document.querySelector("#scheduled-cron").value, "0 8 * * 7");

    await act(async () => { root.unmount(); });
  } finally {
    globalThis.fetch = tasksFetch;
  }
});

// --- Live-Pruefung des Cron-Ausdrucks ------------------------------------------

test("Ein ungueltiger Cron-Ausdruck sperrt Speichern und meldet sich", async () => {
  // Regression aus dem Polish-Umbau: `describeSchedule` meldet einen kaputten
  // Ausdruck mit `null` statt mit einem Wurf. Der Dialog hing aber noch am
  // alten Vertrag (`try { describeSchedule(...) } catch`), also konnte `ok`
  // nie mehr `false` werden — ein Ausdruck wie `0 8 L * *` liess sich
  // speichern, ohne dass die Oberflaeche etwas sagte. Der Server haette ihn
  // abgelehnt; die Rueckmeldung, fuer die die Live-Pruefung existiert, fehlte.
  //
  // Bearbeitet wird eine bestehende Aufgabe statt eine neue angelegt: dann
  // sind Name, Prompt und Modell schon gesetzt, und `canSave` haengt allein am
  // Ausdruck. Ein neuer Dialog muesste erst alle drei fuellen, und ein Fehler
  // hier waere nicht vom Ausdruck zu unterscheiden.
  const tasksFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.startsWith("/api/scheduled-tasks") && (init?.method ?? "GET") === "GET") {
      return json({
        tasks: [{
          id: "cron-validation",
          name: "Nightly report",
          cron: "0 8 * * *",
          prompt: "do the thing",
          provider: "buds-gateway",
          modelId: "qwen3.8-27b",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          nextRun: null,
        }],
      });
    }
    return tasksFetch(input, init);
  };
  try {
    const { root } = await mountView("en");
    const edit = buttonByText("Edit");
    assert.ok(edit, "die Aufgabe wurde nicht gelistet");
    await act(async () => { edit.click(); });
    await settle();

    // Jedes Mal neu suchen: React tauscht Knoten beim Neu-Rendern, und eine
    // festgehaltene Referenz misst dann das alte Element.
    const saveDisabled = () => {
      const save = buttonByText("Save task");
      assert.ok(save, "der Speichern-Knopf fehlt");
      return save.disabled;
    };
    const cronField = () => win.document.querySelector("#scheduled-cron");
    const help = () => win.document.querySelector("#scheduled-cron-help");

    // Gueltig: Speichern frei, keine Fehlermeldung.
    assert.equal(saveDisabled(), false, "ein gueltiger Ausdruck darf Speichern nicht sperren");
    assert.notEqual(help().getAttribute("role"), "alert", "ein gueltiger Ausdruck darf nicht als Fehler gelten");

    // Ungueltig: gesperrt, als Fehler ausgezeichnet, Meldung mit Feld und Token.
    await setInputValue(cronField(), "0 8 L * *");
    assert.equal(saveDisabled(), true, "ein ungueltiger Ausdruck muss Speichern sperren");
    assert.equal(help().getAttribute("role"), "alert", "der Fehler ist nicht als Meldung ausgezeichnet");
    assert.equal(cronField().getAttribute("aria-invalid"), "true", "das Cron-Feld ist nicht als ungueltig markiert");
    const text = (help().textContent ?? "").trim();
    assert.ok(text.includes("not valid"), `der Fehler nennt nicht den Grund: ${JSON.stringify(text)}`);
    assert.ok(text.includes("dayOfMonth") && text.includes("L"), `Feld und Token fehlen: ${JSON.stringify(text)}`);

    // Und zurueck: ein wieder gueltiger Ausdruck gibt Speichern frei.
    await setInputValue(cronField(), "0 8 * * *");
    assert.equal(saveDisabled(), false, "Speichern blieb nach der Korrektur gesperrt");

    await act(async () => { root.unmount(); });
  } finally {
    globalThis.fetch = tasksFetch;
  }
});

// --- "Jetzt ausfuehren" in der Zeile -----------------------------------------

/** Eine gespeicherte Aufgabe, wie die Liste sie nach dem Start zeigt. */
function taskView(overrides = {}) {
  return {
    id: "task-run-1",
    name: "Nightly digest",
    cron: "0 3 * * *",
    prompt: "Summarise.",
    provider: "buds-gateway",
    modelId: "qwen3.8-27b",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRun: Date.now() + 3_600_000,
    ...overrides,
  };
}

test("Der Knopf 'Run now' startet die Aufgabe, zeigt den Lauf und aktualisiert Last run", async () => {
  let posted = 0;
  let resolveRun;
  const gate = new Promise((resolve) => { resolveRun = resolve; });
  const before = taskView();
  const after = taskView({ lastRunAt: new Date().toISOString(), lastRunStatus: "ok", lastRunSessionId: "sitzung-9" });
  let current = before;

  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/run") && method === "POST") {
      posted += 1;
      await gate;
      current = after;   // ab jetzt liefert der Reload den gelaufenen Stand
      return json({ sessionId: "sitzung-9" });
    }
    if (url.startsWith("/api/scheduled-tasks") && method === "GET") return json({ tasks: [current] });
    return baseFetch(input, init);
  };
  try {
    const { root } = await mountView("en");
    const run = buttonByText("Run now");
    assert.ok(run, "der Knopf 'Run now' fehlt in der Zeile");

    // Waehrend der Anfrage: der Knopf ist aus und traegt den laufenden Text.
    await act(async () => { run.click(); });
    await settle();
    const busy = buttonByText("Starting…");
    assert.ok(busy, "waehrend des Starts fehlt der laufende Text");
    assert.equal(busy.disabled, true, "der Knopf ist waehrend des Starts nicht gesperrt");
    assert.equal(busy.getAttribute("aria-busy"), "true");

    resolveRun();
    await settle();
    await settle();

    assert.equal(posted, 1, "der Knopf hat mehr als einen Start ausgeloest");
    assert.ok(buttonByText("Run now"), "nach dem Lauf steht der Knopf nicht wieder auf 'Run now'");
    // Der Reload hat den neuen Stand geholt — dieselbe Auffrischung wie bei
    // jeder anderen Aenderung, kein zweiter Weg.
    // Der Reload hat den neuen Stand geholt — derselbe Weg wie bei jeder
    // anderen Aenderung. Geprueft wird die Zeile: ein Lauf heisst nicht mehr
    // "Never run", und der Status steht dahinter.
    const rowText = win.document.body.textContent ?? "";
    assert.ok(!rowText.includes("Never run"), "die Zeile zeigt nach dem Lauf noch 'Never run'");
    assert.ok(rowText.includes("Started"), `der Status des Laufs fehlt: ${rowText}`);

    await act(async () => { root.unmount(); });
  } finally {
    globalThis.fetch = baseFetch;
  }
});

test("Ein gescheiterter Handstart zeigt den Grund an der Zeile", async () => {
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/run") && method === "POST") {
      return new Response(JSON.stringify({ error: "Model is not available in the enabled scope: buds-gateway/gone" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("/api/scheduled-tasks") && method === "GET") return json({ tasks: [taskView()] });
    return baseFetch(input, init);
  };
  try {
    const { root } = await mountView("en");
    const run = buttonByText("Run now");
    await act(async () => { run.click(); });
    await settle();

    const alerts = [...win.document.querySelectorAll('[role="alert"]')].map((n) => (n.textContent ?? "").trim());
    assert.ok(
      alerts.some((text) => text.includes("could not be started") && text.includes("not available in the enabled scope")),
      `der Grund des gescheiterten Starts fehlt: ${JSON.stringify(alerts)}`,
    );
    // Und der Knopf ist wieder benutzbar — ein Fehlschlag sperrt die Zeile nicht.
    assert.equal(buttonByText("Run now")?.disabled ?? false, false);

    await act(async () => { root.unmount(); });
  } finally {
    globalThis.fetch = baseFetch;
  }
});

test("Eine deaktivierte Aufgabe laesst sich trotzdem von Hand starten", async () => {
  // `enabled` sagt, ob der Takt sie startet — nicht, ob ein Mensch sie starten
  // darf. Der Knopf ist deshalb auch bei einer deaktivierten Aufgabe aktiv.
  let posted = 0;
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/run") && method === "POST") {
      posted += 1;
      return json({ sessionId: "sitzung-10" });
    }
    if (url.startsWith("/api/scheduled-tasks") && method === "GET") return json({ tasks: [taskView({ enabled: false, nextRun: null })] });
    return baseFetch(input, init);
  };
  try {
    const { root } = await mountView("en");
    const run = buttonByText("Run now");
    assert.ok(run, "der Knopf fehlt bei einer deaktivierten Aufgabe");
    assert.equal(run.disabled, false, "eine deaktivierte Aufgabe darf man von Hand starten");
    await act(async () => { run.click(); });
    await settle();
    assert.equal(posted, 1);

    await act(async () => { root.unmount(); });
  } finally {
    globalThis.fetch = baseFetch;
  }
});
