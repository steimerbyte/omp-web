import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./image-attachments.ts");
}

/**
 * Die Summe der dekodierten Bildgroessen einer Nachricht.
 *
 * Der Grenzwert (`MAX_ATTACHED_IMAGES_TOTAL_BYTES`) wird gegen diese Summe
 * geprueft, deshalb ist die Regel: gueltige Base64-Laengen addieren, und bei
 * *einem* kaputten Eintrag `0` liefern — nicht die Summe der heilen Eintraege.
 * Eine Teilkorrektur wuerde die Nachricht durchlassen und beim Dekodieren
 * scheitern.
 */
test("adds the decoded byte lengths of valid base64 payloads", async () => {
  const { getTotalDecodedByteLength } = await loadSubject();

  // "AAAA" = 3 Byte, "AAAAAA==" = 4 Byte.
  assert.equal(getTotalDecodedByteLength([{ data: "AAAA" }, { data: "AAAAAA==" }]), 7);
  assert.equal(getTotalDecodedByteLength([]), 0);
});

test("one malformed entry makes the whole total zero", async () => {
  const { getTotalDecodedByteLength } = await loadSubject();

  assert.equal(getTotalDecodedByteLength([{ data: "AAAA" }, { data: "not base64!" }]), 0);
  assert.equal(getTotalDecodedByteLength([{ data: "AAAAA" }]), 0, "Laenge ist kein Vielfaches von 4");
  assert.equal(getTotalDecodedByteLength([{}]), 0);
});
