import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./browser-notifications.ts");
}

/**
 * Die Umgebung, die `showBrowserNotification` ohne zweiten Parameter benutzt.
 *
 * Der zweite Parameter existiert, damit die Zustaende (Service Worker da,
 * Service Worker fehlt, Konstruktor fehlt) ohne Browser geprueft werden
 * koennen — die *Default*-Umgebung ist dann genau der Teil, den kein Test
 * anfasst: sie liest `navigator` und `Notification` vom globalen Objekt.
 * Genau das wird hier gemessen, mit eingesetzten Globals.
 */
async function withGlobals(values, run) {
  const saved = new Map();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    // `await`, not `return`: die eingesetzten Globals muessen bis zum Ende des
    // asynchronen Aufrufs gelten. `showBrowserNotification` gibt vor dem
    // ersten `await` zurueck (Service-Worker-Abfrage), und eine Wiederherstellung
    // davor nimmt der Funktion den Konstruktor weg.
    return await run();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

function fakeNotificationConstructor(created) {
  return class {
    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.onclick = null;
      this.closed = false;
      created.push(this);
    }
    close() {
      this.closed = true;
    }
  };
}

test("returns null when neither a registration nor the constructor exists", async () => {
  const { showBrowserNotification } = await loadSubject();

  const delivery = await withGlobals({ navigator: {}, Notification: undefined }, () =>
    showBrowserNotification({ title: "Fertig", body: "Lauf beendet", sessionUrl: "/?session=1", onClick: () => {} }));

  assert.equal(delivery, null);
});

test("falls back to a page notification and wires its click handler", async () => {
  const { showBrowserNotification } = await loadSubject();
  const created = [];
  let clicked = 0;

  const delivery = await withGlobals({ navigator: {}, Notification: fakeNotificationConstructor(created) }, () =>
    showBrowserNotification({
      title: "Fertig",
      body: "Lauf beendet",
      tag: "session:1",
      sessionUrl: "/?session=1",
      onClick: () => { clicked += 1; },
    }));

  assert.equal(delivery, "window");
  assert.equal(created.length, 1);
  const [notification] = created;
  assert.equal(notification.title, "Fertig");
  assert.deepEqual(notification.options, { body: "Lauf beendet", tag: "session:1" });

  notification.onclick();
  assert.equal(notification.closed, true, "der Klick schliesst die Mitteilung");
  assert.equal(clicked, 1, "und oeffnet die Sitzung");
});

test("uses the service worker registration when the environment has one", async () => {
  const { showBrowserNotification } = await loadSubject();
  const shown = [];

  const delivery = await withGlobals({
    navigator: {
      serviceWorker: {
        getRegistration: async () => ({
          showNotification: async (title, options) => { shown.push({ title, options }); },
        }),
      },
    },
    Notification: undefined,
  }, () => showBrowserNotification({
    title: "Fertig",
    body: "Lauf beendet",
    sessionUrl: "/?session=1",
    onClick: () => assert.fail("der Service Worker besitzt den Klick"),
  }));

  assert.equal(delivery, "service-worker");
  assert.deepEqual(shown, [{
    title: "Fertig",
    options: { body: "Lauf beendet", data: { url: "/?session=1" } },
  }]);
});

test("a missing registration falls back to the page notification", async () => {
  const { showBrowserNotification } = await loadSubject();
  const created = [];

  const delivery = await withGlobals({
    navigator: { serviceWorker: { getRegistration: async () => undefined } },
    Notification: fakeNotificationConstructor(created),
  }, () => showBrowserNotification({
    title: "Fertig",
    body: "Lauf beendet",
    sessionUrl: "/?session=1",
    onClick: () => {},
  }));

  assert.equal(delivery, "window");
  assert.equal(created.length, 1);
});
