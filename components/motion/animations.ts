/**
 * Die Taktung der ganzen Oberfläche, an einer Stelle.
 *
 * Jede Bewegung liest ihre Dauer und ihre Kurve hier: die Primitives in
 * `components/motion/`, die CSS-Module und die Radix-Flächen. Die Werte sind
 * keine Dekoration, sondern die Rollen, die eine Bewegung haben kann —
 * auftreten, verschwinden, reagieren, warten. Wer eine neue Bewegung baut,
 * wählt eine Rolle, keine Zahl.
 *
 * Weil CSS kein TS importieren kann, spiegelt `app/globals.css` dieselben
 * Werte als Custom Properties (`--duration-enter`, `--ease-standard`, …).
 * `components/motion/motion.test.mjs` liest beide Dateien und schlägt fehl,
 * sobald sie auseinanderlaufen — die Doppelung ist damit geprüft und nicht
 * bloß behauptet.
 *
 * Einheiten: Sekunden, weil `motion` sie so nimmt. CSS trägt Millisekunden.
 */

/* --------------------------------------------------------------------------
   Kurven
   -------------------------------------------------------------------------- */

/**
 * Die Standardkurve (`cubic-bezier(0.33, 0.66, 0.66, 1)`): Noctalias Default,
 * die CSS-Näherung der EaseOutQuad `t(2−t)`. Sanfter Beginn, die Strecke liegt
 * in der Mitte, kein Überschwinger — deshalb dürfen Text und Symbole mit ihr
 * fahren. Sie ist für die kurzen Wege gedacht: Hover, Zustandswechsel,
 * Backdrop.
 */
export const EASE_STANDARD = [0.33, 0.66, 0.66, 1] as const;

/**
 * Die betonte Kurve für Flächen, die weit fahren: Panels, Dialoge, Karten,
 * Schubladen (`cubic-bezier(0.33, 1, 0.68, 1)`). Noctalia benutzt diese
 * EaseOutCubic für weite Wege — sie fährt sofort los und hat danach eine lange
 * Bremse. Das ist der Unterschied, der zählt: eine 470-px-Karte, die 40 ms
 * lang kaum anfährt, liest sich als Verzögerung.
 */
export const EASE_EMPHASIZED = [0.33, 1, 0.68, 1] as const;

/**
 * Die Abgangskurve: beschleunigt weg (`cubic-bezier(0.4, 0, 1, 1)`).
 * Alles, was verschwindet, benutzt sie. Ein Abgang mit Einlaufkurve wirkt
 * wie ein Hänger — das Auge wartet auf ein Element, das schon gehen will.
 */
export const EASE_EXIT = [0.4, 0, 1, 1] as const;

/* --------------------------------------------------------------------------
   Dauern
   -------------------------------------------------------------------------- */

/** Hover und Zustandswechsel: 100 ms, Noctalias `fast`, wie `--duration-hover`. */
export const DURATION_HOVER = 0.1;

/**
 * Kleine Flächen, die auftreten: Menüs, Popover, Backdrops. 200 ms ist
 * Noctalias `base` und liegt im 160–240-ms-Fenster, in dem ein Einblenden als
 * sofort und nicht als Verzögerung gelesen wird.
 */
export const DURATION_ENTER = 0.2;

/**
 * Große Flächen, die auftreten: Panels, Dialoge, Karten. 400 ms ist Noctalias
 * `slow`; eine große Fläche darf länger brauchen als ein Menü, sonst springt
 * sie ins Bild.
 */
export const DURATION_ENTER_PANEL = 0.4;

/**
 * Alles, was verschwindet: 100 ms, Noctalias `fast` — der Abgang bleibt
 * deutlich unter dem Auftritt, er soll nur nicht schneiden.
 */
export const DURATION_EXIT = 0.1;

/**
 * Die eine Ausnahme: die Rückweisung auf der Login-Seite. Sie erzählt eine
 * Ablehnung (Hinschlagen, Zurückfedern) statt eine Fläche zu platzieren und
 * darf deshalb länger sein als ein Einblenden — aber nicht so lang, dass der
 * nächste Versuch dahinter warten muss.
 */
export const DURATION_ALERT = 0.36;

/* --------------------------------------------------------------------------
   Federn
   -------------------------------------------------------------------------- */

/**
 * Der Tastendruck (`whileTap`). `visualDuration` statt Stiffness/Damping:
 * die Feder ist nach 160 ms sichtbar zur Ruhe, `bounce: 0.22` gibt ihr genau
 * einen kleinen Überschwinger — ein Knopf soll federn, nicht oszillieren.
 */
export const SPRING_PRESS = { type: "spring", visualDuration: 0.16, bounce: 0.22 } as const;

/* --------------------------------------------------------------------------
   Schleifen und Warte-Bewegungen
   -------------------------------------------------------------------------- */

/**
 * Der ganze Shimmer-Zyklus in Sekunden: ein Lauf des Bandes plus seine Ruhe.
 *
 * Bewusst der *Zyklus* und nicht der Lauf, damit die Aufteilung ein Anteil
 * einer Zahl bleibt statt einer zweiten Konstante, die man nachziehen müsste.
 * `@keyframes omp-shimmer-wash` verbringt die ersten 75 % mit Fahren und hält
 * die letzten 25 % mit geparktem Band — bei 1.6 s sind das 1.2 s Lauf und
 * 0.4 s Ruhe. Die Ruhe ist der Grund, warum ein Wash als abgeschlossener
 * Durchlauf liest und nicht als Kreisverkehr; wer an dieser Zahl dreht, dreht
 * beide Hälften zusammen.
 */
export const SHIMMER_DURATION = 1.6;

/**
 * Der eine Wash, den ein Panel beim Aufpoppen spielt. Länger als der Auftritt
 * selbst, damit das Band noch unterwegs ist, während die Fläche ankommt —
 * das ist der Unterschied zwischen „ist da" und „kommt an".
 */
export const SWEEP_DURATION = 0.72;

/** Eine volle Umdrehung. Spinner und Zahnrad teilen sie, damit sie im Takt bleiben. */
export const SPIN_TRANSITION = { repeat: Infinity, duration: 0.8, ease: "linear" } as const;

/**
 * Ein Lauf eines einzelnen Punkts im Arbeitsindikator, in Sekunden.
 *
 * Die 49 Zellen teilen sich diesen Takt und fächern ihn nur ein wenig auf
 * (0.7x bis 1.3x): genug, dass das Raster nie als ein Block atmet, wenig genug,
 * dass der Indikator als ein Ding liest. `ThinkingDots.tsx` schreibt die
 * Per-Cell-Dauer als Custom Property; `app/globals.css` trägt sie als Fallback
 * in derselben Zahl.
 */
export const THINKING_DOT_DURATION = 2.4;

/** Das Atmen der Deckkraft, das „arbeitet gerade" bedeutet. */
export const PULSE_TRANSITION = { duration: 1.5, repeat: Infinity, ease: "easeInOut" } as const;
