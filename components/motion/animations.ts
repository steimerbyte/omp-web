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
 * Die Standardkurve (`cubic-bezier(0.2, 0, 0, 1)`): sanfter Beginn, die
 * Strecke liegt in der Mitte. Kurvenprofil — Strecke in Prozent nach 5 / 10 /
 * 20 / 40 / 60 % der Zeit: 3 / 16 / 50 / 80 / 93. Kein Überschwinger, deshalb
 * dürfen Text und Symbole mit ihr fahren. Sie ist für die kurzen Wege gedacht —
 * Hover, Zustandswechsel, Backdrop: bei 120 ms ist der leise Beginn nicht als
 * Verzögerung zu sehen.
 */
export const EASE_STANDARD = [0.2, 0, 0, 1] as const;

/**
 * Die betonte Kurve für Flächen, die weit fahren: Panels, Dialoge, Karten,
 * Schubladen (`cubic-bezier(0.16, 1, 0.3, 1)`). Sie fährt sofort los — 28 %
 * der Strecke nach 5 % der Zeit, 49 % nach 10 % — und hat danach eine lange
 * Bremse. Das ist der Unterschied, der zählt: eine 470-px-Karte, die 40 ms
 * lang kaum anfährt, liest sich als Verzögerung, und 220 ms sind lang genug,
 * dass man diese 40 ms sieht. Ein 120-ms-Hover sieht sie nicht, deshalb
 * bleiben sich die beiden Kurven dort auch nicht in die Quere.
 */
export const EASE_EMPHASIZED = [0.16, 1, 0.3, 1] as const;

/**
 * Die Abgangskurve: beschleunigt weg (`cubic-bezier(0.4, 0, 1, 1)`).
 * Alles, was verschwindet, benutzt sie. Ein Abgang mit Einlaufkurve wirkt
 * wie ein Hänger — das Auge wartet auf ein Element, das schon gehen will.
 */
export const EASE_EXIT = [0.4, 0, 1, 1] as const;

/* --------------------------------------------------------------------------
   Dauern
   -------------------------------------------------------------------------- */

/** Hover und Zustandswechsel: 120 ms, dieselben wie `--duration-hover`. */
export const DURATION_HOVER = 0.12;

/**
 * Kleine Flächen, die auftreten: Menüs, Popover, Backdrops. 180 ms liegt in
 * der Mitte des 160–240-ms-Fensters, in dem ein Einblenden als sofort und
 * nicht als Verzögerung gelesen wird.
 */
export const DURATION_ENTER = 0.18;

/**
 * Große Flächen, die auftreten: Panels, Dialoge, Karten. 220 ms, das obere
 * Ende desselben Fensters — eine große Fläche darf etwas länger brauchen als
 * ein Menü, sonst springt sie ins Bild.
 */
export const DURATION_ENTER_PANEL = 0.22;

/**
 * Alles, was verschwindet: 140 ms, deutlich unter dem Auftritt. Der Abgang
 * muss nicht erklärt werden, er soll nur nicht schneiden.
 */
export const DURATION_EXIT = 0.14;

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

/** Das Atmen der Deckkraft, das „arbeitet gerade" bedeutet. */
export const PULSE_TRANSITION = { duration: 1.5, repeat: Infinity, ease: "easeInOut" } as const;
