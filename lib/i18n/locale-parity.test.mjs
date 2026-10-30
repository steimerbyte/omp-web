import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { root: process.cwd() });
const { enLocale } = await jiti.import("./messages/en.ts");
const { deLocale } = await jiti.import("./messages/de.ts");
const { zhCNLocale } = await jiti.import("./messages/zh-CN.ts");

/**
 * Die Vollstaendigkeit der Sprachpakete.
 *
 * ### Warum das ein Test und nicht eine Absichtserklaerung ist
 *
 * `translateMessage()` faellt auf das Englische zurueck, wenn ein Schluessel
 * fehlt. Das ist das richtige Verhalten *im Betrieb* — eine halb uebersetzte
 * Oberflaeche ist besser als eine mit Schluesselnamen. Aber im Repository
 * heisst es auch: ein fehlender Schluessel faellt **niemandem** auf, solange
 * niemand in der betreffenden Sprache nachsieht.
 *
 * Der Test haelt deshalb fest, dass ein Sprachpaket, das als vollstaendig
 * ausgegeben wird, auch vollstaendig ist. Fuer `de` ist das eine
 * Zusicherung: das Paket ist die Grundlage der deutschen Oberflaeche, und ein
 * Loch darin waere eine halb uebersetzte Seite fuer genau die Menschen, die
 * Deutsch gewaehlt haben.
 *
 * ### Warum `de` *mehr* Schluessel haben darf
 *
 * Der Kalender ist ein deutsches Kalendersystem: deutsche Monatsnamen, die
 * ISO-Kalenderwoche, die bundesweiten Feiertage mit ihren deutschen Namen
 * und das deutsche Datumsformat. Seine Texte stehen deshalb **nur** im
 * deutschen Paket — in jeder anderen Sprache waeren sie tote Kopien, und der
 * Kalender liest sie ohnehin aus dem deutschen Paket
 * (`components/calendar/useCalendarText.ts`).
 *
 * Der Test erlaubt dem deutschen Paket deshalb zusaetzliche Schluessel und
 * verlangt, dass die deutschsprachigen Knoepfe *nicht* uebersetzbar sind:
 * ein Schluessel, der nur in einer Sprache existiert, ist per Definition
 * sprachgebunden.
 */

/** Die Schluessel des englischen Katalogs, in ihrer Reihenfolge. */
const EN_KEYS = Object.keys(enLocale.messages);

/** Die Sprachpakete, die vollstaendig sein muessen. */
const COMPLETE_PACKAGES = [
  { name: "de", plugin: deLocale },
];

/**
 * Die Schluessel, die nur im deutschen Paket existieren duerfen.
 *
 * Jeder Eintrag hier ist eine bewusste Entscheidung: ein Schluessel, der eine
 * deutsche Sache benennt, die in anderen Sprachen nicht uebersetzbar ist.
 */
const GERMAN_ONLY_PREFIXES = ["calendar."];

test("the English catalogue is the reference and is not empty", () => {
  assert.ok(EN_KEYS.length > 0);
});

for (const { name, plugin } of COMPLETE_PACKAGES) {
  test(`the ${name} package carries every English key`, () => {
    const packageKeys = Object.keys(plugin.messages);
    const missing = EN_KEYS.filter((key) => !packageKeys.includes(key));
    assert.deepEqual(missing, [], `Der ${name}-Katalog fehlt: ${missing.join(", ")}`);
  });

  test(`the ${name} package has no key the English catalogue lacks except the German-only ones`, () => {
    const packageKeys = Object.keys(plugin.messages);
    const extra = packageKeys.filter(
      (key) => !EN_KEYS.includes(key) && !GERMAN_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );
    assert.deepEqual(extra, [], `Der ${name}-Katalog hat unerwartet zusaetzlich: ${extra.join(", ")}`);
  });

  test(`the ${name} package keeps the English keys in the English order`, () => {
    // Die Reihenfolge macht einen Sprachvergleich lesbar: die Zeile, die in
    // einer Sprache fehlt, steht in allen anderen an derselben Stelle.
    const germanOnly = Object.keys(plugin.messages).filter(
      (key) => !EN_KEYS.includes(key),
    );
    const shared = Object.keys(plugin.messages).filter((key) => EN_KEYS.includes(key));
    assert.deepEqual(shared, EN_KEYS);
    // Die sprachgebundenen Schluessel stehen hinter den gemeinsamen, damit
    // die gemeinsamen Reihenfolge unveraendert bleibt.
    const lastShared = Object.keys(plugin.messages).lastIndexOf(shared[shared.length - 1]);
    const firstGermanOnly = Object.keys(plugin.messages).indexOf(germanOnly[0]);
    assert.ok(firstGermanOnly > lastShared, "Die sprachgebundenen Schluessel stehen nicht am Ende");
  });

  test(`the ${name} package translates every shared value`, () => {
    // Ein Schluessel, dessen Wert identisch mit dem Englischen ist, ist
    // eine unuebersetzte Zeile. Die Ausnahmen sind Fachbegriffe, die im
    // Deutschen ueblich bleiben.
    const allowed = new Set([
      "common.ok", "i18n.diff", "i18n.model", "i18n.status",
      // "Name" und "Prompt" heissen im Deutschen genauso; "Prompt" ist der
      // Fachbegriff, den die Oberflaeche ueberall verwendet. "Minute" ist
      // ebenfalls in beiden Sprachen dasselbe Wort.
      "scheduled.name", "scheduled.prompt", "scheduled.minute",
    ]);
    const untranslated = EN_KEYS
      .filter((key) => !allowed.has(key))
      .filter((key) => plugin.messages[key] === enLocale.messages[key]);
    assert.deepEqual(untranslated, [], `Unuebersetzt im ${name}-Katalog: ${untranslated.join(", ")}`);
  });

  test(`the ${name} package keeps every interpolation placeholder`, () => {
    // Ein Platzhalter, der im Deutschen fehlt, zeigt dem Nutzer "{count}"
    // statt der Zahl. Ein Platzhalter, der im Deutschen neu erfunden wurde,
    // zeigt "{anzahl}" — beides ist ein Fehler.
    const placeholders = (value) =>
      [...value.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]).sort();

    for (const key of EN_KEYS) {
      const english = placeholders(enLocale.messages[key]);
      const translated = placeholders(plugin.messages[key]);
      assert.deepEqual(
        translated,
        english,
        `Die Platzhalter von "${key}" unterscheiden sich: ${english.join(",")} gegen ${translated.join(",")}`,
      );
    }
  });

  test(`the ${name} package leaves no value empty`, () => {
    const empty = Object.keys(plugin.messages).filter((key) => plugin.messages[key].trim() === "");
    assert.deepEqual(empty, [], `Leere Werte im ${name}-Katalog: ${empty.join(", ")}`);
  });
}

test("the calendar keys exist only in the German package", () => {
  // Der Kalender ist ein deutsches Kalendersystem. Seine Texte stehen nur im
  // deutschen Paket; in den anderen Sprachen waeren sie Kopien ohne Leser.
  const englishKeys = Object.keys(enLocale.messages).filter((key) => key.startsWith("calendar."));
  const chineseKeys = Object.keys(zhCNLocale.messages).filter((key) => key.startsWith("calendar."));
  assert.deepEqual(englishKeys, []);
  assert.deepEqual(chineseKeys, []);
  const germanKeys = Object.keys(deLocale.messages).filter((key) => key.startsWith("calendar."));
  assert.ok(germanKeys.length > 0, "Der Kalender braucht Schluessel im deutschen Paket");
});
