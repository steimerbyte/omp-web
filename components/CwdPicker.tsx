"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * Die Wahl eines Arbeitsordners: Voreinstellung, bekannter Ordner oder ein
 * eigener Pfad — an einer Stelle, weil beide Stellen dieselbe Wahl brauchen.
 *
 * Der Dialog einer Aufgabe und die Einstellungen des Kontos fragen dasselbe
 * ("in welchem Verzeichnis soll gestartet werden") und muessen dieselben
 * Antworten anbieten. Zwei Kopien dieses Auswahlfelds wuerden frueher oder
 * spaeter verschiedene Listen zeigen, und ein Ordner waere dann an der einen
 * Stelle waehlbar und an der anderen nicht.
 *
 * ### Warum ein Auswahlfeld *und* ein Textfeld
 *
 * Die bekannten Ordner sind eine Bequemlichkeit, keine Grenze: das Projekt-
 * register eines Kontos ist bei weitem nicht jeder Ordner, in dem ein Lauf
 * sinnvoll ist. Ein reines Auswahlfeld waere eine Einschraenkung, die niemand
 * bestellt hat; ein reines Textfeld machte den haeufigsten Fall (die Home oder
 * ein Projekt) zum Tippen eines langen Pfads. Der Eintrag "Eigener Pfad…"
 * schaltet das Textfeld frei, und die Auswahl bleibt sonst ein Klick.
 *
 * ### Warum der Modus ein eigener Zustand ist
 *
 * Der Wert ist immer ein Pfad oder `null`, aber "eigener Pfad, noch nichts
 * getippt" waere als Wert nicht von "Voreinstellung" zu unterscheiden — und
 * sobald der Nutzer das Feld leert, verschwaende es unter seinen Fingern. Der
 * Modus entscheidet, ob das Textfeld sichtbar ist; der Wert, was gespeichert
 * wird.
 */
const CUSTOM = "\u0000custom";

const inputStyle = {
  width: "100%",
  minWidth: 0,
  padding: "6px 8px",
  fontSize: 13,
  fontFamily: "inherit",
  color: "var(--text)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 7,
  boxSizing: "border-box" as const,
};

export function CwdPicker({ id, value, home, folders, inheritLabel, onChange, disabled }: {
  /** Das `id` des Auswahlfelds, damit ein `<label htmlFor>` es trifft. */
  id: string;
  /** Der gespeicherte Pfad, oder `null` fuer "Voreinstellung". */
  value: string | null;
  /** Die Home des Kontos; steht als erster Eintrag der Liste. */
  home: string;
  /** Die waehlbaren Ordner, ohne die Home (die kommt aus `home`). */
  folders: string[];
  /** Die Beschriftung des leeren Eintrags; die beiden Aufrufer meinen anderes. */
  inheritLabel: string;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const known = [...new Set([home, ...folders].filter((entry) => entry !== ""))];
  // Ein gespeicherter Pfad, der nicht in der Liste steht (Projekt entfernt,
  // von Hand gesetzt), bleibt sichtbar — sonst wuerde das Oeffnen des Dialogs
  // die Angabe stillschweigend auf "Voreinstellung" zuruecksetzen.
  const [showCustom, setShowCustom] = useState(() => value !== null && !known.includes(value));
  // Der Modus entscheidet die Anzeige, nicht der Wert: ein getippter Pfad, der
  // zufaellig ein bekannter Ordner ist, darf das Feld nicht unter dem Finger
  // wegklappen.
  const selected = showCustom ? CUSTOM : value ?? "";

  return (
    <>
      <select
        id={id}
        value={selected}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM) {
            setShowCustom(true);
            // Nichts aendern: der gespeicherte Pfad bleibt stehen, bis ein
            // neuer getippt ist. Ein sofortiges `null` waere eine Loeschung,
            // die niemand bestellt hat.
            return;
          }
          setShowCustom(false);
          onChange(next === "" ? null : next);
        }}
        style={inputStyle}
      >
        <option value="">{inheritLabel}</option>
        {known.map((folder) => (
          <option key={folder} value={folder}>{folder}</option>
        ))}
        <option value={CUSTOM}>{t("scheduled.cwdCustom")}</option>
      </select>
      {showCustom ? (
        <input
          id={`${id}-path`}
          type="text"
          spellCheck={false}
          value={value ?? ""}
          disabled={disabled}
          aria-label={t("scheduled.cwdCustomPath")}
          placeholder={t("scheduled.cwdPlaceholder")}
          onChange={(event) => onChange(event.target.value.trim() === "" ? null : event.target.value)}
          style={{ ...inputStyle, marginTop: 6, fontFamily: "var(--font-mono, monospace)" }}
        />
      ) : null}
    </>
  );
}
