import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Die gepinnten Versionen des Desktop-Umbaus — Doku gegen Lockdatei.
 *
 * ### Warum dieser Test existiert
 *
 * `docs/calendar.md` nennt die Versionen, die `src-tauri/Cargo.lock`
 * festnagelt: „`src-tauri/Cargo.lock` pinnt wry 0.55.1 und tauri 2.11.5".
 * Ein `cargo update` verschiebt die Lockdatei, und die Doku bleibt still
 * falsch — niemand merkt es, bis jemand auf die falsche wry-Version stoesst.
 *
 * Der Test vergleicht deshalb die **beiden** Quellen miteinander: jede
 * Version, die die Doku nennt, muss die Version sein, die die Lockdatei
 * pinnt. Keine Versionsnummer steht hier festgeschrieben — eine Konstante
 * gleich der Konstante waere der Test, der nichts beweist.
 *
 * ### Das Format der Lockdatei
 *
 * `Cargo.lock` ist eine Liste von `[[package]]`-Bloecken:
 *
 * ```
 * [[package]]
 * name = "wry"
 * version = "0.55.1"
 * source = "registry+https://github.com/rust-lang/crates.io-index"
 * ```
 *
 * `wry` und `tauri` stehen als **eigene** Pakete darin — nicht nur als
 * Abhaengigkeit eines anderen Pakets. Genau deshalb liest der Test die
 * Bloecke und nicht einzelne Zeilen: die Zeile `"wry",` in einer
 * Abhaengigkeitsliste nennt kein Paket `wry` mit einer Version.
 */

/** Die Lockdatei des Desktop-Umbaus. */
const LOCKFILE = new URL("../src-tauri/Cargo.lock", import.meta.url);
/** Die Doku, die die Versionen nennt. */
const DOKUMENT = new URL("../docs/calendar.md", import.meta.url);

/**
 * Die Pakete der Lockdatei: Name → Version.
 *
 * Jeder `[[package]]`-Block nennt genau ein Paket mit genau einer Version;
 * die Abhaengigkeiten darunter (`"wry",`) gehoeren nicht dazu.
 */
function paketeDerLockdatei(text) {
  const pakete = new Map();
  for (const block of text.split("[[package]]")) {
    const name = /\nname = "([^"]+)"/.exec(block)?.[1];
    const version = /\nversion = "([^"]+)"/.exec(block)?.[1];
    if (name && version) pakete.set(name, version);
  }
  return pakete;
}

/**
 * Alle Versionen, die die Doku fuer ein Paket nennt.
 *
 * Ein Paket kann mehrfach vorkommen („pinnt wry 0.55.1 … In wry 0.55.1") —
 * jede Nennung muss dieselbe Version sein.
 */
function genannteVersionen(text, paket) {
  return [...text.matchAll(new RegExp(`\\b${paket} (\\d+(?:\\.\\d+)+)`, "g"))].map((treffer) => treffer[1]);
}

const lockText = readFileSync(LOCKFILE, "utf8");
const dokText = readFileSync(DOKUMENT, "utf8");
const pakete = paketeDerLockdatei(lockText);

test("die Doku nennt genau die Versionen, die die Lockdatei pinnt", () => {
  for (const paket of ["wry", "tauri"]) {
    const gepinnt = pakete.get(paket);
    assert.ok(gepinnt, `die Lockdatei pinnt kein Paket „${paket}“`);

    const genannten = genannteVersionen(dokText, paket);
    assert.ok(genannten.length > 0, `die Doku nennt keine Version von „${paket}“`);
    for (const genannt of genannten) {
      assert.equal(
        genannt,
        gepinnt,
        `die Doku nennt ${paket} ${genannt}, die Lockdatei pinnt ${gepinnt}`,
      );
    }
  }
});

test("die Lockdatei pinnt wry und tauri als eigene Pakete", () => {
  // Beide muessen eigene Bloecke sein — eine Zeile `"wry",` in einer
  // Abhaengigkeitsliste wuerde von `paketeDerLockdatei` nicht gefunden.
  for (const paket of ["wry", "tauri"]) {
    assert.ok(pakete.has(paket), `die Lockdatei kennt kein eigenes Paket „${paket}“`);
    assert.match(
      lockText,
      new RegExp(`\\[\\[package\\]\\]\\nname = "${paket}"\\nversion = "\\d+(?:\\.\\d+)+"`),
      `„${paket}“ steht nicht als eigener [[package]]-Block in der Lockdatei`,
    );
  }
});

test("die Doku nennt die Lockdatei als die Quelle der gepinnten Versionen", () => {
  // Die Behauptung der Doku gilt der Lockdatei — ohne diesen Namen waere
  // die Versionsangabe in der Luft.
  assert.match(dokText, /src-tauri\/Cargo\.lock/);
});
