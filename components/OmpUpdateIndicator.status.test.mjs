import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `OmpUpdateIndicator` und die Antworten der autorisierten Routen.
 *
 * Seit die autorisierten Routen bei fehlender Berechtigung mit 403 und bei
 * fehlender Ressource mit 404 antworten, ist `!response.ok` keine Information
 * mehr. Der alte Code behandelte beide gleich und liess `loadState` dauerhaft
 * auf `"loading"` stehen: die Komponente blieb fuer den Rest der Sitzung in
 * einem Zustand, den es im Renderpfad gar nicht gibt.
 *
 * Der Test prueft die Unterscheidung an der Klassifizierer-Funktion, weil das
 * die Stelle ist, an der die Information wirklich unterschieden wird — und
 * weil sie ohne DOM mountbar ist. `OmpWebUpdateResponse` wird nicht importiert,
 * der Aufrufer ist der, der den Typ festlegt.
 */

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { classifyUpdatesResponse } = await jiti.import("./OmpUpdateIndicator.tsx");

test("403 und 404 werden unterschiedlich behandelt", () => {
  const forbidden = classifyUpdatesResponse(403);
  const missing = classifyUpdatesResponse(404);

  // Der Kern der Aussage: die beiden sind nicht dasselbe.
  assert.notEqual(forbidden, missing);

  // 403 heisst "darf nicht fragen" — da gibt es nichts anzuzeigen.
  assert.equal(forbidden, "unauthorized");
  // 404 heisst "diese Ressource gibt es nicht" — ein Deployment-Fakt.
  assert.equal(missing, "missing");
});

test("nur eine 2xx gilt als erfolgreich", () => {
  assert.equal(classifyUpdatesResponse(200), "ok");
  assert.equal(classifyUpdatesResponse(204), "ok");
});

test("alle anderen Fehlercodes fallen auf 'unavailable'", () => {
  // 500 ist ein Fehler des Servers, nicht 403 und nicht 404.
  assert.equal(classifyUpdatesResponse(500), "unavailable");
  // 401 ist ebenfalls nicht 403, auch wenn beide "nicht erlaubt" bedeuten.
  assert.equal(classifyUpdatesResponse(401), "unavailable");
  assert.equal(classifyUpdatesResponse(502), "unavailable");
});

test("die Klassifizierung liest keinen Body", () => {
  // Ein 403 mit HTML-Fehlerseite darf nicht werfen. Die Funktion nimmt nur
  // eine Zahl, es gibt also gar keinen Ort, an dem ein Body gelesen werden
  // koennte — das ist hier die Behauptung, und `arguments.length` belegt sie.
  assert.equal(classifyUpdatesResponse.length, 1);
  assert.doesNotThrow(() => classifyUpdatesResponse(403));
});