/**
 * Reine Regeln der Browser-Abnahme (`scripts/ui-audit.mjs`).
 *
 * Die Fehlerklasse, die hier gemessen wird, entsteht nur in einem echten
 * Browser: ein Werkzeug in der rollenden Kopfleiste liegt ausserhalb des
 * sichtbaren Bereichs, wird von einem festen Knopf ueberdeckt, oder ein Popover
 * wird zwar gerendert, aber von `overflow: hidden` eines Vorfahren
 * abgeschnitten. Nichts davon sieht man im DOM — nur hit-testen kann es
 * beantworten.
 *
 * Was ohne Browser entscheidbar ist, steht hier und wird getestet
 * (`lib/ui-audit.test.mjs`); alles, was `elementFromPoint` und
 * `getComputedStyle` braucht, bleibt im Skript. Damit ist die Regel eine Regel
 * und keine im Audit verstreute Zahl: das Skript importiert genau diese
 * Funktionen, statt die Schwellen ein zweites Mal zu schreiben.
 */

/** Ein Rechteck in CSS-Pixeln, wie `getBoundingClientRect` es liefert. */
export interface AuditRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Sichtbarer Bereich, gegen den geprueft wird (`innerWidth`/`innerHeight`). */
export interface AuditViewport {
  width: number;
  height: number;
}

/**
 * Was `elementFromPoint` an dieser Stelle geliefert hat.
 *
 * `id` ist die Kennung des *Ziels*, wenn der Treffer das Ziel selbst oder ein
 * Nachfahre davon war — die Zuordnung passiert im Browser, weil nur dort die
 * Containment-Beziehung bekannt ist.
 */
export interface ReachHit {
  id: string;
  interactive: boolean;
}

export type ReachVerdict = "reachable" | "covered" | "miss";

/**
 * Liegt das Rechteck vollstaendig im Viewport? `tolerance` faengt
 * Subpixel-Rundung ab; 1 px ist die Groesse, in der ein halber Rahmen noch als
 * sichtbar gilt.
 */
export function isInsideViewport(
  rect: AuditRect,
  viewport: AuditViewport,
  tolerance = 1,
): boolean {
  const t = Math.abs(tolerance);
  return (
    rect.left >= -t &&
    rect.top >= -t &&
    rect.right <= viewport.width + t &&
    rect.bottom <= viewport.height + t
  );
}

/**
 * Braucht dieser Kasten eine Roll-Andeutung? Ein Pixel ist die Schwelle, weil
 * Unterpixel-Reste (`scrollWidth` 390,4 bei 390) keine echt gerollte Leiste
 * sind.
 */
export function needsScrollAffordance(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth > clientWidth + 1;
}

/**
 * Urteil fuer einen Hit-Test auf der Mitte eines Ziels.
 *
 * - `reachable`: der Treffer ist das Ziel (oder ein Nachfahre).
 * - `covered`: dort liegt ein *anderes* bedienbares Element — das ist der
 *   Fehler mit dem festen Knopf ueber der Leiste, nicht bloss eine Luecke.
 * - `miss`: nichts Bedienbares unter dem Punkt; das Ziel ist an dieser
 *   Scroll-Position nicht da, an der es zu sein behauptet.
 */
export function classifyReachability(hit: ReachHit | null, targetId: string): ReachVerdict {
  if (hit === null) return "miss";
  if (hit.id === targetId) return "reachable";
  return hit.interactive ? "covered" : "miss";
}

export interface CoveringRow {
  target: string;
  hit: string | null;
  /** Ob der Treffer selbst bedienbar ist. */
  hitInteractive: boolean;
}

export interface CoveringSummary {
  total: number;
  covered: number;
  /** Je ueberdecktem Ziel das Element, das es verdeckt. */
  offenders: Array<{ target: string; by: string }>;
}

/**
 * Fasst die Hit-Tests einer Scroll-Position zusammen. Nur ein *anderes*
 * bedienbares Element zaehlt als Ueberdeckung; ein Treffer auf dem eigenen
 * Nachfahren (`id` schon auf das Ziel abgebildet) und ein leerer Punkt nicht.
 */
export function summarizeCovering(rows: readonly CoveringRow[]): CoveringSummary {
  const offenders: Array<{ target: string; by: string }> = [];
  for (const row of rows) {
    if (row.hit === null || !row.hitInteractive || row.hit === row.target) continue;
    offenders.push({ target: row.target, by: row.hit });
  }
  return { total: rows.length, covered: offenders.length, offenders };
}

/**
 * Die Scroll-Positionen, an denen ein Ziel probiert wird: Anfang, Mitte des
 * Ziels und Ende. Die Mitte ist die Antwort auf "welchen Weg muss die Leiste
 * rollen" — ihr Abstand zu `scrollLeft 0` steht so im Bericht.
 */
export function reachabilityProbeOffsets(
  box: { scrollWidth: number; clientWidth: number },
  targetOffsetLeft: number,
): number[] {
  const max = Math.max(0, box.scrollWidth - box.clientWidth);
  const centred = Math.round(
    Math.min(max, Math.max(0, targetOffsetLeft - box.clientWidth / 2)),
  );
  return [...new Set([0, centred, max])].sort((a, b) => a - b);
}

export interface TapTarget {
  selector: string;
  width: number;
  height: number;
}

export interface TapTargetSummary {
  count: number;
  /** Die kleinsten Treffer, aufsteigend nach der kuerzeren Kante. */
  smallest: TapTarget[];
}

/**
 * Zaehlt Ziele unter der Mindestgroesse (44 px, WCAG 2.5.5 AA). Das ist ein
 * Hinweis und kein Fehler: ein 36-px-Symbolknopf in einer 36-px-Leiste ist eine
 * bewusste Entscheidung, ein 12-px-Kreuz in einem Popover meistens nicht.
 */
export function summarizeTapTargets(
  targets: readonly TapTarget[],
  options: { min?: number; limit?: number } = {},
): TapTargetSummary {
  const min = options.min ?? 44;
  const limit = options.limit ?? 5;
  const small = targets
    .filter((t) => t.width < min || t.height < min)
    .sort((a, b) => Math.min(a.width, a.height) - Math.min(b.width, b.height));
  return { count: small.length, smallest: small.slice(0, limit) };
}

/**
 * Das Element mit dem kleinsten `left` — die erste Spalte einer Leiste.
 *
 * Diese Regel fragt nur nach gemessenen Rechtecken und weiss nichts von CSS
 * `order`, `flex-direction` oder `position`: genau das ist ihr Zweck. Ein
 * `order: -1` an einem Geschwister schiebt die erste Spalte weg, ohne dass
 * Erreichbarkeit oder Hit-Test etwas merken — das Element steht weiter an
 * seinem Platz im DOM, nur nicht mehr an seinem Platz im Bild. Bei gleichem
 * `left` gewinnt das frueheste Element der Eingabe (Dokumentreihenfolge).
 */
export function leftmostItem<T extends { left: number }>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (best === null || item.left < best.left) best = item;
  }
  return best;
}

/** |`value` − `edge`| ≤ `tolerance`; 8 px ist die Vorgabe fuer die linke Kante. */
export function isAlignedToEdge(value: number, edge: number, tolerance = 8): boolean {
  return Math.abs(value - edge) <= Math.abs(tolerance);
}

export interface OverflowAncestor {
  selector: string;
  overflowX: string;
  overflowY: string;
}

/**
 * Der erste Vorfahr, der schneidet — die Diagnose fuer "gerendert, aber nicht
 * sichtbar". `visible` ist der einzige Wert, der nichts abschneidet;
 * `clip`, `hidden`, `auto` und `scroll` tun es alle, und ein Popover mit
 * `position: absolute` bleibt darin gefangen, waehrend `fixed` ihm entkommt.
 */
export function findClippingAncestor(
  chain: readonly OverflowAncestor[],
): OverflowAncestor | null {
  return chain.find((a) => a.overflowX !== "visible" || a.overflowY !== "visible") ?? null;
}
