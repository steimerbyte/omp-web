import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReachability,
  findClippingAncestor,
  isInsideViewport,
  needsScrollAffordance,
  reachabilityProbeOffsets,
  summarizeCovering,
  summarizeTapTargets,
} from "./ui-audit.ts";

/**
 * Die Regeln der Browser-Abnahme sind hier getestet und nicht im Skript: das
 * Skript startet einen Dev-Server und Chromium, kann also nicht Teil der Suite
 * sein. Ueber `lib/` laeuft jede Schwelle trotzdem durch `bun run test`.
 */

test("isInsideViewport: volle Flaeche innen, ein Pixel Ueberstand je Kante toleriert", () => {
  const viewport = { width: 390, height: 844 };
  const inside = { left: 8, top: 4, right: 382, bottom: 40 };
  assert.equal(isInsideViewport(inside, viewport), true);

  // 1 px Toleranz ist die Vorgabe: ein halber Rahmen ist noch sichtbar.
  assert.equal(isInsideViewport({ ...inside, right: 391 }, viewport), true);
  assert.equal(isInsideViewport({ ...inside, right: 391.5 }, viewport), false);
  assert.equal(isInsideViewport({ ...inside, left: -1.5 }, viewport), false);
  assert.equal(isInsideViewport({ ...inside, bottom: 845 }, viewport), true);
  assert.equal(isInsideViewport({ ...inside, bottom: 846 }, viewport), false);

  // Das Popover, das rechts aus dem 390-px-Fenster ragt, ist der Fehler.
  assert.equal(isInsideViewport({ left: 300, top: 40, right: 460, bottom: 200 }, viewport), false);
});

test("isInsideViewport: engere Toleranz wird benutzt, nicht ignoriert", () => {
  const viewport = { width: 100, height: 100 };
  assert.equal(isInsideViewport({ left: 0, top: 0, right: 101, bottom: 100 }, viewport, 0), false);
  assert.equal(isInsideViewport({ left: 0, top: 0, right: 101, bottom: 100 }, viewport, 2), true);
});

test("needsScrollAffordance: erst ab mehr als einem Pixel Ueberlauf", () => {
  const bar = { clientWidth: 390 };
  assert.equal(needsScrollAffordance(390, bar.clientWidth), false);
  assert.equal(needsScrollAffordance(390.9, bar.clientWidth), false);
  assert.equal(needsScrollAffordance(656, bar.clientWidth), true);
});

test("classifyReachability: Ziel, Ueberdeckung und Luecke sind drei verschiedene Faelle", () => {
  assert.equal(classifyReachability({ id: "a", interactive: true }, "a"), "reachable");
  // Ein Nachfahre des Ziels wird im Browser auf das Ziel abgebildet.
  assert.equal(classifyReachability({ id: "a", interactive: true }, "a"), "reachable");
  // Der feste 36-px-Knopf ueber dem Ende der Leiste.
  assert.equal(classifyReachability({ id: "file-panel-toggle", interactive: true }, "terminal"), "covered");
  // Nichts Bedienbares: die Leiste selbst, ein Abstandshalter, `null`.
  assert.equal(classifyReachability({ id: "topbar-scroll", interactive: false }, "terminal"), "miss");
  assert.equal(classifyReachability(null, "terminal"), "miss");
});

test("summarizeCovering: nur ein anderes bedienbares Element ist eine Ueberdeckung", () => {
  const summary = summarizeCovering([
    { target: "language", hit: "language", hitInteractive: true },
    { target: "terminal", hit: "file-panel-toggle", hitInteractive: true },
    { target: "system-prompt", hit: "topbar-scroll", hitInteractive: false },
    { target: "attach-file", hit: null, hitInteractive: false },
    { target: "cpu-ram", hit: "file-panel-toggle", hitInteractive: true },
  ]);
  assert.equal(summary.total, 5);
  assert.equal(summary.covered, 2);
  assert.deepEqual(summary.offenders, [
    { target: "terminal", by: "file-panel-toggle" },
    { target: "cpu-ram", by: "file-panel-toggle" },
  ]);
  assert.deepEqual(summarizeCovering([]), { total: 0, covered: 0, offenders: [] });
});

test("reachabilityProbeOffsets: Anfang, Zielmitte und Ende, ohne Doppelungen", () => {
  // 656 px Inhalt in 390 px Leiste. Ein Ziel bei offsetLeft 276 steht genau
  // eine halbe Leistenbreite rechts der Mitte — 81 px Weg, um es zu zentrieren.
  assert.deepEqual(
    reachabilityProbeOffsets({ scrollWidth: 656, clientWidth: 390 }, 276),
    [0, 81, 266],
  );
  // Weiter rechts als die Mitte klemmen: das Maximum bleibt das Maximum.
  assert.deepEqual(
    reachabilityProbeOffsets({ scrollWidth: 656, clientWidth: 390 }, 500),
    [0, 266],
  );
  // Ohne Ueberlauf bleibt es bei einer Position.
  assert.deepEqual(reachabilityProbeOffsets({ scrollWidth: 300, clientWidth: 390 }, 120), [0]);
  // Ein Ziel ganz rechts wird auf das Maximum geklemmt, nicht ueberrollt.
  assert.deepEqual(
    reachabilityProbeOffsets({ scrollWidth: 656, clientWidth: 390 }, 650),
    [0, 266],
  );
  // Ein Ziel ganz links erzeugt keine negative Position.
  assert.deepEqual(
    reachabilityProbeOffsets({ scrollWidth: 656, clientWidth: 390 }, 10),
    [0, 266],
  );
});

test("summarizeTapTargets: zaehlt alle zu kleinen Ziele und nennt die fuenf kleinsten", () => {
  const targets = [
    { selector: "ok-44", width: 44, height: 44 },
    { selector: "topbar-icon", width: 36, height: 36 },
    { selector: "popover-close", width: 18, height: 18 },
    { selector: "wide-thin", width: 120, height: 32 },
    { selector: "send", width: 40, height: 40 },
    { selector: "tiny", width: 12, height: 12 },
    { selector: "chat-row", width: 300, height: 30 },
  ];
  const summary = summarizeTapTargets(targets);
  assert.equal(summary.count, 6);
  assert.equal(summary.smallest.length, 5);
  assert.deepEqual(
    summary.smallest.map((t) => t.selector),
    ["tiny", "popover-close", "chat-row", "wide-thin", "topbar-icon"],
  );
  // Grenze und Anzahl sind Parameter, keine Konstanten im Aufrufer.
  assert.deepEqual(
    summarizeTapTargets(targets, { min: 48, limit: 2 }).smallest.map((t) => t.selector),
    ["tiny", "popover-close"],
  );
  assert.equal(summarizeTapTargets([]).count, 0);
});

test("findClippingAncestor: der erste Vorfahr, der schneidet, ist die Diagnose", () => {
  const chain = [
    { selector: "span.icon", overflowX: "visible", overflowY: "visible" },
    { selector: "[data-testid=topbar-scroll]", overflowX: "auto", overflowY: "hidden" },
    { selector: "div.topbar-wrap", overflowX: "visible", overflowY: "visible" },
  ];
  assert.deepEqual(findClippingAncestor(chain), chain[1]);
  assert.equal(
    findClippingAncestor([{ selector: "div", overflowX: "visible", overflowY: "visible" }]),
    null,
  );
  // `clip` schneidet ebenfalls, auch ohne Scrollbalken.
  assert.equal(
    findClippingAncestor([{ selector: "div.clip", overflowX: "clip", overflowY: "visible" }])?.selector,
    "div.clip",
  );
});
