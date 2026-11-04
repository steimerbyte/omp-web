import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./draft-store.ts");
}

/**
 * Ein abgeschickter Text, der zurueckkommt.
 *
 * Der Fall, den die Funktion traegt: der Nutzer tippt waehrend des Absendens
 * weiter. Dann darf der zurueckgegebene Entwurf weder den neuen Text
 * verschlucken noch den alten doppelt einsetzen — er stellt den abgeschickten
 * Teil vor den neuen, und die Bilder beider Seiten bleiben erhalten.
 */
const image = (data) => ({ data, mimeType: "image/png" });

test("restores the submitted text into an empty draft", async () => {
  const { getDraft, restoreDraftSubmission } = await loadSubject();

  const restored = restoreDraftSubmission("unit:empty", "erste Fassung");

  assert.deepEqual(restored, { value: "erste Fassung", images: [] });
  assert.deepEqual(getDraft("unit:empty"), restored, "der Entwurf ist gespeichert, nicht nur zurueckgegeben");
});

test("keeps what the user typed while the submission was in flight", async () => {
  const { restoreDraftSubmission, setDraft } = await loadSubject();
  setDraft("unit:typing", { value: "und noch das hier", images: [] });

  const restored = restoreDraftSubmission("unit:typing", "abgeschickt");

  assert.equal(restored.value, "abgeschickt\n\nund noch das hier");
});

test("merges the submitted images with the current ones and drops invalid entries", async () => {
  const { restoreDraftSubmission, setDraft } = await loadSubject();
  setDraft("unit:images", { value: "", images: [image("BBBB")] });

  const restored = restoreDraftSubmission("unit:images", "", [
    image("AAAA"),
    image("kein base64!"),
  ]);

  assert.deepEqual(restored.images, [image("AAAA"), image("BBBB")]);
});

test("an empty submission leaves the draft untouched", async () => {
  const { restoreDraftSubmission, setDraft } = await loadSubject();
  setDraft("unit:untouched", { value: "bleibt", images: [image("AAAA")] });

  const restored = restoreDraftSubmission("unit:untouched", "   ");

  assert.equal(restored.value, "bleibt");
  assert.deepEqual(restored.images, [image("AAAA")]);
});
