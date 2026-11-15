import {
  GERMAN_MONTHS,
  GERMAN_WEEKDAYS_SHORT,
  addDays,
  daysInMonth,
  weekdayIndex,
} from "@/lib/calendar";

/**
 * Die Rechnung hinter der Datums- und Uhrzeitwahl — ohne DOM.
 *
 * Dieselbe Trennung wie ueberall im Kalender: was ein Raster, ein Zifferblatt
 * und eine Pfeiltaste bedeuten, ist eine Rechnung und keine Zeichnung. Hier
 * steht sie, damit ein Test sie ohne Fenster pruefen kann; die beiden Dialoge
 * (`DatePickerDialog`, `TimePickerDialog`) zeichnen nur noch.
 *
 * ### Die Masse kommen aus der Vorlage
 *
 * `PICKER_RATIO` haelt die Anteile, die an den beiden Screenshots gemessen
 * wurden (Zifferblattdurchmesser zu Dialogbreite, Feldhoehe, Kreisdurchmesser
 * der gewaehlten Zahl, Kopfband …). Die Dialoge multiplizieren sie mit ihrer
 * Breite; damit bleibt das Bild dasselbe, egal wie breit das Fenster ist, und
 * die Zahlen sind nachpruefbar statt „sieht ungefaehr so aus".
 */

/** Die Breite der beiden Dialoge in Pixeln. */
export const PICKER_WIDTH = 360;

/**
 * Die Anteile aus der Vorlage (gemessen an den Screenshots 808×1297 und
 * 770×1263).
 *
 * Alle Werte sind **Schriftgroessen** bzw. Kantenlaengen als Anteil an der
 * Dialogbreite — nicht Glyphenhoehen. Eine Glyphe ist etwa 0,7 mal so hoch
 * wie ihre Schriftgroesse; die Messung ergab Glyphen, die Rechnung hier
 * braucht Schriftgroessen, sonst waere jeder Tag im Raster ein Drittel zu
 * klein.
 *
 * | Anteil | Wert | Messung |
 * |---|---|---|
 * | `dial` | 0.84 | Zifferblatt 600 px / Dialog 712 px |
 * | `fieldWidth` | 0.316 | Zeitfeld 225 px / 712 px |
 * | `fieldHeight` | 0.264 | Zeitfeld 188 px / 712 px |
 * | `dialNumber` | 0.05 | Ziffer 30 px / **Zifferblatt** 600 px |
 * | `bubble` | 0.185 | gewaehlter Kreis 111 px / **Zifferblatt** 600 px |
 * | `bigDate` | 0.133 | „Mi., 18. Nov." 70 px Glyphe / 750 px |
 * | `year` | 0.044 | Jahr 23 px Glyphe / 750 px |
 * | `month` | 0.038 | Monatsname 20 px Glyphe / 750 px |
 * | `initials` | 0.032 | Wochentag 17 px Glyphe / 750 px |
 * | `day` | 0.042 | Tagesziffer 22 px Glyphe / 750 px |
 *
 * `dialNumber` und `bubble` rechnen gegen den **Zifferblattdurchmesser**,
 * alle anderen gegen die Dialogbreite.
 */
export const PICKER_RATIO = {
  dial: 0.84,
  fieldWidth: 0.316,
  fieldHeight: 0.264,
  dialNumber: 0.05,
  bubble: 0.185,
  bigDate: 0.133,
  year: 0.044,
  month: 0.038,
  initials: 0.032,
  day: 0.042,
} as const;

/**
 * Der Radius der beiden Zahlenringe, als Anteil am Zifferblattradius.
 *
 * Aussen liegen 0…11, innen 12…23; gemessen: 235 px und 155 px auf einem
 * Zifferblatt mit 300 px Radius.
 */
export const DIAL_RING_RATIO = { outer: 235 / 300, inner: 155 / 300 } as const;

/** Die Grenze zwischen innerem und aeusserem Ring (der Radius in der Mitte). */
export const DIAL_RING_SPLIT = (DIAL_RING_RATIO.outer + DIAL_RING_RATIO.inner) / 2;

/** Die Wochentags-Initialen ueber dem Raster — `M D M D F S S`, Montag zuerst. */
export const PICKER_WEEKDAY_INITIALS = GERMAN_WEEKDAYS_SHORT.map((name) => name.slice(0, 1));

/** Zwei Ziffern mit fuehrender Null. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Das Monatsraster: sechs Zeilen à sieben Zellen, Montag zuerst.
 *
 * Nur Tage **des** Monats; Zellen davor und danach sind `null`. Die
 * Sechs-Zeilen-Regel ist dieselbe wie in der Monatsansicht
 * (`lib/calendar.ts`, `buildMonthGrid`): ein Monat mit fuenf Wochen bekommt
 * trotzdem sechs Zeilen, damit das Raster beim Blaettern nicht springt — der
 * Dialog behaelt seine Hoehe, und die Maus trifft beim Klicken auf „weiter"
 * denselben Punkt.
 */
export function pickerMonthGrid(year: number, month: number): (string | null)[][] {
  const firstWeekday = weekdayIndex(`${year}-${pad2(month)}-01`);
  const total = daysInMonth(year, month);
  const rows: (string | null)[][] = [];
  for (let row = 0; row < 6; row += 1) {
    const cells: (string | null)[] = [];
    for (let column = 0; column < 7; column += 1) {
      const day = row * 7 + column - firstWeekday + 1;
      cells.push(day >= 1 && day <= total ? `${year}-${pad2(month)}-${pad2(day)}` : null);
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Der Kopf des Datumsdialogs: `{ weekday: "Mi.", dayMonth: "18. Nov." }`.
 *
 * Die Wochentage und Monate kommen aus `lib/calendar.ts` — eine zweite Tabelle
 * waere die Stelle, an der Kalender und Dialog verschiedene Namen zeigen.
 * Der Monat wird auf drei Buchstaben gekuerzt, wie in der Vorlage.
 */
export function pickerDateHeader(date: string): { weekday: string; dayMonth: string } {
  const weekday = `${GERMAN_WEEKDAYS_SHORT[weekdayIndex(date)]}.`;
  const month = GERMAN_MONTHS[Number(date.slice(5, 7)) - 1];
  const dayMonth = `${Number(date.slice(8, 10))}. ${month.slice(0, 3)}.`;
  return { weekday, dayMonth };
}

/** Die Kopfzeile des Monats: `November 2026`. */
export function pickerMonthLabel(year: number, month: number): string {
  return `${GERMAN_MONTHS[month - 1]} ${year}`;
}

/**
 * Ein Monat vor oder zurueck — der Tag bleibt, solange es ihn gibt.
 *
 * Der 31. Januar minus ein Monat ist der 28. Februar, nicht der 3. Maerz:
 * beim Blaettern soll der Dialog im Monat bleiben, den der Nutzer gewaehlt
 * hat, auch wenn der Tag dort kuerzer ist.
 */
export function shiftPickerMonth(date: string, delta: number): string {
  const months = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + delta;
  const year = Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12 + 1;
  const day = Math.min(Number(date.slice(8, 10)), daysInMonth(year, month));
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Die Tasten, die das Datumsraster kennt. */
export type PickerKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

/**
 * Die Tastatur des Rasters als reine Rechnung: Tag plus Pfeiltaste ergibt Tag.
 *
 * Die Achsen folgen dem Raster, nicht dem Kalender: `ArrowUp` geht eine
 * **Zeile** hoch, also sieben Tage — nicht einen Tag zurueck. `Home` und `End`
 * springen an den Montag und den Sonntag der Woche. Unbekannte Tasten lassen
 * den Tag stehen.
 */
export function nextPickerDate(date: string, key: string): string {
  switch (key) {
    case "ArrowLeft":
      return addDays(date, -1);
    case "ArrowRight":
      return addDays(date, 1);
    case "ArrowUp":
      return addDays(date, -7);
    case "ArrowDown":
      return addDays(date, 7);
    case "Home":
      return addDays(date, -weekdayIndex(date));
    case "End":
      return addDays(date, 6 - weekdayIndex(date));
    case "PageUp":
      return shiftPickerMonth(date, -1);
    case "PageDown":
      return shiftPickerMonth(date, 1);
    default:
      return date;
  }
}

/** Die beiden Zifferblaetter: Stunden (zwei Ringe) und Minuten (ein Ring). */
export type PickerFace = "hour" | "minute";

/**
 * Der Winkel einer Zifferblattzahl: 0 Grad ist oben, gezaehlt wird im
 * Uhrzeigersinn.
 *
 * Stunden liegen auf einer 12er-Scheibe (`(stunde % 12) * 30`), Minuten auf
 * einer 12er-Scheibe mit Fuenf-Minuten-Schritten (`minute * 6`).
 */
export function dialAngle(value: number, face: PickerFace = "hour"): number {
  return face === "hour" ? (value % 12) * 30 : (value % 60) * 6;
}

/** Eine Zahl des Zifferblatts mit ihrer Position — Anteile am Zifferblattradius. */
export interface DialNumber {
  /** Der Wert: die Stunde 0…23 bzw. die Minute 0…55 in Fuenfer-Schritten. */
  value: number;
  /** Der Abstand nach rechts, als Anteil am Radius (1 = Rand). */
  dx: number;
  /** Der Abstand nach unten, als Anteil am Radius. */
  dy: number;
}

/**
 * Die Positionen der Zahlen auf dem Zifferblatt.
 *
 * Stunden: aussen 0…11, innen 12…23 — 12 sitzt genau unter 0, 13 unter 1
 * und so weiter. Minuten: zwoelf Zahlen (0, 5, … 55) auf dem aeusseren Ring,
 * weil eine Minute auf dem Zifferblatt immer ein Fuenf-Minuten-Schritt ist.
 */
export function dialNumberPositions(face: PickerFace): DialNumber[] {
  const positions: DialNumber[] = [];
  const place = (value: number, radius: number) => {
    const angle = (dialAngle(value, face) * Math.PI) / 180;
    positions.push({ value, dx: Math.sin(angle) * radius, dy: -Math.cos(angle) * radius });
  };
  if (face === "minute") {
    for (let step = 0; step < 12; step += 1) place(step * 5, DIAL_RING_RATIO.outer);
    return positions;
  }
  for (let hour = 0; hour < 12; hour += 1) place(hour, DIAL_RING_RATIO.outer);
  for (let hour = 12; hour < 24; hour += 1) place(hour, DIAL_RING_RATIO.inner);
  return positions;
}

/**
 * Der Wert unter einem Zeiger — `dx`/`dy` relativ zum Mittelpunkt, in
 * Anteilen am Zifferblattradius (1 = Rand).
 *
 * Der **Radius** entscheidet bei den Stunden den Ring: aussen 0…11, innen
 * 12…23. Minuten werden auf Fuenf-Minuten-Schritte **gerastet** (die Grenze
 * liegt bei 2,5 Minuten); eine exakte Minute tippt man in der Texteingabe.
 */
export function dialValueAt(dx: number, dy: number, face: PickerFace): number {
  const radius = Math.hypot(dx, dy);
  // Der Mittelpunkt hat keinen Winkel. `atan2(0, -0)` waere π und damit
  // „unten" — ein Wert, den niemand gemeint hat.
  if (radius === 0) return face === "minute" ? 0 : 12;
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  // `1e-9` Grad gleicht nur die Fliesskomma-Streuung aus (sin/cos/atan2 sind
  // nicht exakt): die Grenze bei 2,5 Minuten soll deterministisch aufrunden,
  // nicht davon abhaengen, ob 15 Grad als 14,999999999999998 herauskommen.
  const slot = ((Math.round(angle / 30 + 1e-9) % 12) + 12) % 12;
  if (face === "minute") return slot * 5;
  return radius >= DIAL_RING_SPLIT ? slot : slot + 12;
}
