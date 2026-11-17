#!/usr/bin/env bun
/**
 * Browser-Abnahme der Oberflaeche: `bun run ui:audit`.
 *
 * Warum es das gibt
 * ----------------
 * Die Fehler, die dieser Lauf findet, sind im DOM unsichtbar: ein Werkzeug in
 * der waagerecht rollenden Kopfleiste liegt ausserhalb des sichtbaren Bereichs,
 * ein fester 36-px-Knopf liegt darueber, ein Popover wird gerendert und dann
 * von `overflow-y: hidden` seiner Leiste abgeschnitten, ein Panel bekommt eine
 * Geometrie, die nicht in den Viewport passt. Jeder dieser Faelle war gruen in
 * `bun test` und falsch im Browser — deshalb ist der einzige ehrliche Test ein
 * echter Browser mit `document.elementFromPoint`.
 *
 * Was der Lauf macht
 * ------------------
 *   1. eigener Dev-Server auf einem freien Port (ab 30142+), mit einer
 *      Wegwerf-Identitaet, die nur in der Umgebung des Kindprozesses steht:
 *      eigener Agent-Dir, eigene Auth-/Session-Dateien, eigenes Home-Root.
 *      Die Live-Instanzen 8788/8799 werden nie beruehrt.
 *   2. Login ueber `POST /api/web-access/login` im Browser (Cookie-Jar des
 *      Kontexts, nicht per Basic-Auth-Header — der Proxy soll genau den Weg
 *      sehen, den ein Mensch geht).
 *   3. Pruefungen bei 390x844 (mit `hasTouch`) und 1280x900, in drei
 *      Kopfleisten-Zustaenden; Ergebnis als Klartext und als JSON.
 *   4. Kindprozess und Browser sterben in jedem Fall, auch bei SIGINT/SIGTERM.
 *
 * Die Regeln selbst (Viewport, Roll-Andeutung, Hit-Urteil) stehen in
 * `lib/ui-audit.ts` und sind dort getestet; dieses Skript misst nur.
 *
 * Aufruf:
 *   bun run ui:audit            # Exit != 0 bei mindestens einem FAIL
 *   PLAYWRIGHT_CHROMIUM_PATH=/pfad/zu/chromium bun run ui:audit
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

import {
  classifyReachability,
  findClippingAncestor,
  isAlignedToEdge,
  isInsideViewport,
  leftmostItem,
  needsScrollAffordance,
  reachabilityProbeOffsets,
  summarizeCovering,
  summarizeTapTargets,
} from "../lib/ui-audit.ts";
import { deLocale } from "../lib/i18n/messages/de.ts";
import { enLocale } from "../lib/i18n/messages/en.ts";
import { zhCNLocale } from "../lib/i18n/messages/zh-CN.ts";

/**
 * Beschriftungen des Schubladen-Knopfs in jeder ausgelieferten Sprache. Der
 * Knopf ist der einzige Zugang zur Seitenleiste auf dem Telefon; welche
 * Sprache gerade gilt, haengt am Browser, also wird gegen alle geprueft statt
 * gegen eine geratene.
 */
const SIDEBAR_TOGGLE_LABELS = new Set(
  [deLocale, enLocale, zhCNLocale].flatMap((plugin) => [
    plugin.messages["sidebar.show"],
    plugin.messages["sidebar.hide"],
  ]),
);

const REPO_ROOT = resolve(import.meta.dir, "..");
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/usr/bin/chromium";
const FIRST_PORT = 30142;
// Next loest `distDir` gegen die Projektwurzel auf: ein absoluter Pfad landet
// als `<repo>/tmp/...` wieder im Baum (gemessen: 4,8 GB). Deshalb ein relativer
// Name neben `.next`, den `.gitignore` (`/.next-*/`) und die ESLint-Config
// (`**/.next-*`) schon kennen — und den der Lauf selbst wieder wegraeumt.
const DIST_DIR = ".next-ui-audit";
const PORT_ATTEMPTS = 40;

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844, mobile: true },
  { name: "1280x900", width: 1280, height: 900, mobile: false },
];

/** Die drei Zustaende, in denen die Kopfleiste etwas anderes zeigt. */
const TOPBAR_STATES = [
  { name: "topbar:no-session", cwd: null, expectTrust: false },
  { name: "topbar:session", cwd: "plain", expectTrust: false },
  { name: "topbar:session-trust", cwd: "untrusted", expectTrust: true },
];

const status = { pass: 0, fail: 0, warn: 0 };
const checks = [];
const consoleEntries = [];

let child = null;
let browser = null;
let runDir = null;
let baseUrl = null;
let startedAt = new Date().toISOString();
let cleanedUp = false;

function record(viewport, state, name, verdict, measurement) {
  checks.push({ viewport, state, name, status: verdict, measurement });
  if (verdict === "PASS") status.pass += 1;
  else if (verdict === "FAIL") status.fail += 1;
  else status.warn += 1;
  const tag = verdict === "PASS" ? "PASS" : verdict === "FAIL" ? "FAIL" : "WARN";
  console.log(`  ${tag}  ${name.padEnd(24)} ${measurement}`);
}

/** Erster freier Port ab 30142: binden, merken, schliessen. */
function pickPort() {
  return new Promise((resolvePort, reject) => {
    let port = FIRST_PORT;
    const attempt = () => {
      const server = createServer();
      server.once("error", () => {
        port += 1;
        server.close(() => {});
        if (port > FIRST_PORT + PORT_ATTEMPTS) reject(new Error(`kein freier Port ab ${FIRST_PORT}`));
        else attempt();
      });
      server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(port)));
    };
    attempt();
  });
}

async function httpStatus(url, timeoutMs = 2000) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return response.status;
  } catch {
    return null;
  }
}

/**
 * Wegwerf-Umgebung fuer den Dev-Server. Alles, was sonst nach `~/.omp` oder
 * `/etc/omp-web.env` zeigen wuerde, zeigt in das Lauf-Verzeichnis — sonst
 * schreibt ein Audit in die echten Sitzungen des Entwicklers und liest dessen
 * Passwort-Store.
 */
function auditEnv(dir) {
  const home = join(dir, "home");
  return {
    // Eigenes HOME: `~/.omp/logs`, `~/.omp/state` und `~/.omp/config` des
    // Entwicklers bleiben unberuehrt. Ohne diese Zeile schreibt der Lauf
    // `omp.<tag>.<pid>.log` in den gemeinsamen Baum (gemessen).
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    OMP_WEB_USERNAME: "omp",
    OMP_WEB_PASSWORD: randomBytes(18).toString("base64url"),
    // Admin, damit `/api/project-trust` ein cwd ausserhalb des Tenants
    // beantwortet und `/api/stats` (CPU/RAM-Popover) nicht mit 403 antwortet.
    OMP_WEB_ADMINS: "omp",
    // Kein Zugriff auf /etc/omp-web.env: sonst gewaenne dessen Passwort.
    OMP_WEB_SECRETS_FILE: join(dir, "no-secrets.env"),
    OMP_WEB_AUTH_FILE: join(dir, "auth.json"),
    OMP_WEB_SESSIONS_FILE: join(dir, "sessions.json"),
    OMP_WEB_ACCOUNTS_FILE: join(dir, "accounts.json"),
    OMP_WEB_HOME_ROOT: join(dir, "homes"),
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    // Zwei Dev-Server im selben Checkout teilen sich sonst `.next`.
    OMP_WEB_DIST_DIR: DIST_DIR,
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

/** Wartet, bis der Dev-Server antwortet; bricht ab, wenn der Kindprozess stirbt. */
async function waitForServer(baseUrl, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  child.once("exit", (code, signal) => {
    exited = `dev-Server beendet (code ${code}${signal ? `, ${signal}` : ""})`;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error(exited);
    if (await httpStatus(`${baseUrl}/login`, 1500) !== null) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Dev-Server antwortet nach ${Math.round(timeoutMs / 1000)}s nicht`);
}

// ---------------------------------------------------------------------------
// Browser-Helfer: einmal pro Dokument installiert, alles andere ruft sie auf.
// Bewusst ohne Zugriff auf Modul-Symbole — Playwright serialisiert die Funktion.
// ---------------------------------------------------------------------------
function installAuditHelpers() {
  if (globalThis.__uiAudit) return;
  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=menuitem]", "[role=menuitemradio]",
    "[role=menuitemcheckbox]", "[role=tab]", "[role=switch]", "[role=checkbox]",
    "[role=radio]", "[role=combobox]", "[role=slider]", "[role=option]",
    "[tabindex]:not([tabindex='-1'])", "[contenteditable='true']",
  ].join(",");
  const POPUP = [
    "[role=menu]", "[role=dialog]", "[role=listbox]",
    "[data-radix-popper-content-wrapper]", "[data-radix-menu-content]",
  ].join(",");

  // Kein Attribut am Element: React hydratisiert dieses DOM, und ein
  // nachtraeglich gesetztes Attribut ist ein Hydration-Mismatch (gemessen:
  // "A tree hydrated but some attributes ... didn't match"). Die Kennung lebt
  // deshalb als Expando-Property plus Register, fuer React unsichtbar.
  let nextId = 0;
  const ids = new Map();

  const idFor = (el) => {
    if (!el) return null;
    let id = el.__uiAuditId;
    if (!id) {
      id = `e${++nextId}`;
      el.__uiAuditId = id;
    }
    ids.set(id, el);
    return id;
  };
  const byId = (id) => {
    const cached = ids.get(id);
    if (cached && cached.isConnected) return cached;
    return null;
  };

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };

  const styleOf = (el) => getComputedStyle(el);

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = styleOf(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    return !el.closest("[aria-hidden='true']");
  };

  const isInteractive = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = styleOf(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };

  const selectorFor = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      const tag = node.tagName.toLowerCase();
      const testId = node.getAttribute("data-testid");
      const label = node.getAttribute("aria-label");
      if (testId) { parts.unshift(`${tag}[data-testid="${testId}"]`); break; }
      if (node.id) { parts.unshift(`${tag}#${node.id}`); break; }
      if (label) { parts.unshift(`${tag}[aria-label="${label.slice(0, 40)}"]`); break; }
      const index = node.parentElement ? Array.from(node.parentElement.children).indexOf(node) + 1 : 1;
      parts.unshift(`${tag}:nth-child(${index})`);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const labelFor = (el) => {
    if (!el) return "(nichts)";
    const text = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const name = text.length > 0 ? text.slice(0, 32) : el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid");
    return testId ? `${name} [${testId}]` : name;
  };

  /** Der naechste Vorfahr, der waagerecht rollt — die Leiste, die das Ziel traegt. */
  const scrollingAncestor = (el) => {
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const cs = styleOf(node);
      if (/(auto|scroll|overlay)/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 1) return node;
      node = node.parentElement;
    }
    return null;
  };

  /** Die Zonen, die als "App-Chrome" gelten. */
  const chromeRegions = () => {
    const found = [];
    const topbar = document.querySelector('[data-testid="topbar-scroll"]');
    if (topbar) found.push({ name: "topbar", el: topbar, bottomOnly: false });
    const attach = document.querySelector('[data-testid="composer-attach-file"]');
    if (attach) {
      let node = attach.parentElement;
      while (node && node !== document.body && !node.querySelector("textarea")) node = node.parentElement;
      if (node && node !== document.body) found.push({ name: "composer", el: node, bottomOnly: false });
    }
    // Nur die letzten 120 px der Seitenleiste: der Rest ist eine virtualisierte
    // Sitzungsliste, keine Aktionsleiste.
    const sidebar = document.querySelector(".sidebar-container");
    if (sidebar) found.push({ name: "sidebar", el: sidebar, bottomOnly: true });
    return found;
  };

  globalThis.__uiAudit = {
    inventory() {
      const elements = [];
      const regionInfo = [];
      for (const region of chromeRegions()) {
        const regionRect = rectOf(region.el);
        const offCanvas = regionRect.right <= 0 || regionRect.left >= innerWidth;
        regionInfo.push({ name: region.name, id: idFor(region.el), selector: selectorFor(region.el), rect: regionRect, offCanvas });
        if (offCanvas) continue;
        for (const el of region.el.querySelectorAll(INTERACTIVE)) {
          if (!isVisible(el) || !isInteractive(el)) continue;
          const rect = rectOf(el);
          if (region.bottomOnly && rect.top <= regionRect.bottom - 120) continue;
          const container = scrollingAncestor(el);
          const containerRect = container ? rectOf(container) : null;
          elements.push({
            id: idFor(el),
            region: region.name,
            label: labelFor(el),
            selector: selectorFor(el),
            haspopup: el.getAttribute("aria-haspopup"),
            rect,
            centre: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
            scroll: container && containerRect
              ? {
                  id: idFor(container),
                  scrollLeft: container.scrollLeft,
                  max: Math.max(0, container.scrollWidth - container.clientWidth),
                  clientWidth: container.clientWidth,
                  scrollWidth: container.scrollWidth,
                  containerRect,
                  // Position im Roll-Inhalt, unabhaengig von `scrollLeft`.
                  offsetLeft: rect.left - containerRect.left + container.scrollLeft,
                }
              : null,
          });
        }
      }
      return {
        viewport: { width: innerWidth, height: innerHeight },
        document: {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        },
        regions: regionInfo,
        elements,
      };
    },

    element(id) {
      return byId(id);
    },

    /** Setzt `scrollLeft` und wartet zwei Frames, damit Fades nachziehen. */
    async scrollTo(containerId, value) {
      const el = byId(containerId);
      if (!el) return null;
      el.scrollLeft = value;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return el.scrollLeft;
    },

    hit(targetId, containerId) {
      const el = byId(targetId);
      if (!el || !el.isConnected) return { missing: true };
      const rect = rectOf(el);
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const container = containerId ? byId(containerId) : null;
      const containerRect = container ? rectOf(container) : null;
      const insideViewport = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
      const insideContainer = containerRect
        ? x >= containerRect.left && x <= containerRect.right && y >= containerRect.top && y <= containerRect.bottom
        : insideViewport;
      if (!insideViewport) {
        return { x, y, insideViewport, insideContainer, hitId: null, hitLabel: null, hitInteractive: false };
      }
      const hitEl = document.elementFromPoint(x, y);
      if (!hitEl) {
        return { x, y, insideViewport, insideContainer, hitId: null, hitLabel: null, hitInteractive: false };
      }
      if (hitEl === el || el.contains(hitEl)) {
        return { x, y, insideViewport, insideContainer, hitId: targetId, hitLabel: labelFor(el), hitInteractive: true };
      }
      const interactiveAncestor = hitEl.closest(INTERACTIVE);
      const covering = interactiveAncestor ?? hitEl;
      return {
        x,
        y,
        insideViewport,
        insideContainer,
        hitId: idFor(covering),
        hitLabel: labelFor(covering),
        hitInteractive: Boolean(interactiveAncestor),
      };
    },

    /** Die Overflow-Kette nach oben — die Diagnose entscheidet `lib/ui-audit.ts`. */
    clippingChain(targetId) {
      const el = byId(targetId);
      if (!el) return [];
      const chain = [];
      let node = el.parentElement;
      while (node && node.nodeType === 1 && chain.length < 12) {
        const cs = styleOf(node);
        chain.push({ selector: selectorFor(node), overflowX: cs.overflowX, overflowY: cs.overflowY });
        node = node.parentElement;
      }
      return chain;
    },

    /**
     * Die bedienbaren Kinder einer Zone in Dokumentreihenfolge, mit gemessenen
     * linken Kanten — die Grundlage der Reihenfolge-Pruefung. CSS `order`
     * aendert nur `left`, nicht die Reihenfolge in dieser Liste; genau dieser
     * Unterschied ist der Befund.
     */
    layout(regionId) {
      const bar = byId(regionId);
      if (!bar) return null;
      const barRect = rectOf(bar);
      const items = [];
      for (const el of bar.querySelectorAll(INTERACTIVE)) {
        if (!isVisible(el) || !isInteractive(el)) continue;
        const rect = rectOf(el);
        items.push({
          id: idFor(el),
          label: labelFor(el),
          aria: el.getAttribute("aria-label") ?? "",
          left: rect.left,
          right: rect.right,
        });
      }
      return { barLeft: barRect.left, barRight: barRect.right, items };
    },

    popups() {
      const visible = [];
      const hidden = [];
      for (const el of document.querySelectorAll(POPUP)) {
        const rect = rectOf(el);
        if (isVisible(el)) {
          visible.push({ id: idFor(el), role: el.getAttribute("role"), rect, label: labelFor(el) });
        } else {
          hidden.push({ id: idFor(el), role: el.getAttribute("role"), rect, label: labelFor(el) });
        }
      }
      return { visible, hidden };
    },

    /** Jeder waagerecht rollende Kasten mit seinen rohen Massen. */
    scrollSurfaces() {
      const surfaces = [];
      for (const el of document.querySelectorAll("*")) {
        const cs = styleOf(el);
        if (!/(auto|scroll|overlay)/.test(cs.overflowX)) continue;
        if (el.scrollWidth <= el.clientWidth + 1) continue;
        let fadeAttr = null;
        for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 3; node = node.parentElement, depth += 1) {
          const attr = Array.from(node.attributes).find((a) => /^data-.*fade$/i.test(a.name));
          if (attr) { fadeAttr = `${attr.name}="${attr.value}"`; break; }
        }
        surfaces.push({
          id: idFor(el),
          selector: selectorFor(el),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          fadeAttr,
          scrollbarWidth: cs.scrollbarWidth,
        });
      }
      return surfaces;
    },

    fadeState(containerId) {
      const el = byId(containerId);
      if (!el) return null;
      const host = el.closest("[data-topbar-fade]") ?? el.parentElement?.closest("[data-topbar-fade]");
      return {
        value: host?.getAttribute("data-topbar-fade") ?? null,
        scrollLeft: el.scrollLeft,
        max: Math.max(0, el.scrollWidth - el.clientWidth),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Pruefungen
// ---------------------------------------------------------------------------
async function auditState(page, viewport, state, baseUrl, projects) {
  const url = state.cwd ? `${baseUrl}/?cwd=${encodeURIComponent(projects[state.cwd])}` : `${baseUrl}/`;
  // Der Trust-Zustand entsteht aus `GET /api/project-trust`; erst wenn diese
  // Antwort da ist, ist "Streifen fehlt" ein Befund und nicht ein Messfehler.
  const trustResponse = state.cwd
    ? page.waitForResponse((response) => response.url().includes("/api/project-trust"), { timeout: 60_000 }).catch(() => null)
    : Promise.resolve(null);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForSelector('[data-testid="topbar-scroll"]', { timeout: 120_000 });
  // Erst messen, wenn React hydratisiert hat: die i18n-Provider-Effekt setzt
  // `document.documentElement.lang` (SSR steht dort "en"), und im Dev-Server
  // kommt das Client-Bundle erst nach dem Server-Render an. Vorher ist das DOM
  // das SSR-Abbild und jeder Klick folgenlos — gemessen: die Kopfleiste zeigte
  // allein die vier statischen Knoepfe, das Popover ging nie auf.
  await page.waitForFunction(() => document.documentElement.lang !== "en", null, { timeout: 120_000 })
    .catch(() => {});
  // Der `?cwd=`-Zustand entsteht erst nach `POST /api/cwd/validate`; der
  // Composer ist der sichtbare Beleg dafuer.
  if (state.cwd) {
    await page.waitForSelector("textarea", { timeout: 20_000 }).catch(() => {});
    await trustResponse;
  }
  await page.waitForTimeout(400);

  const inventory = await page.evaluate(() => globalThis.__uiAudit.inventory());
  const { elements } = inventory;
  const topbarElements = elements.filter((e) => e.region === "topbar");

  // --- Zustand belegen: der Trust-Streifen ist da oder nicht da. -----------
  const trust = topbarElements.some((e) => /Restricted mode|Eingeschränkter Modus/.test(e.label));
  record(viewport.name, state.name, "top bar state", trust === state.expectTrust ? "PASS" : "FAIL",
    `${topbarElements.length} top-bar controls, trust strip ${trust ? "present" : "absent"} (expected ${state.expectTrust ? "present" : "absent"})`);

  // --- Reachability -------------------------------------------------------
  const unreachable = [];
  const deltas = [];
  for (const element of elements) {
    const offsets = element.scroll
      ? reachabilityProbeOffsets(
          { scrollWidth: element.scroll.scrollWidth, clientWidth: element.scroll.clientWidth },
          element.scroll.offsetLeft,
        )
      : [0];
    const attempts = [];
    for (const offset of offsets) {
      if (element.scroll) {
        await page.evaluate(([id, value]) => globalThis.__uiAudit.scrollTo(id, value), [element.scroll.id, offset]);
      }
      const outcome = await page.evaluate(([id, cid]) => globalThis.__uiAudit.hit(id, cid), [element.id, element.scroll?.id ?? null]);
      if (outcome.missing) break;
      const verdict = classifyReachability(
        outcome.hitId === null ? null : { id: outcome.hitId, interactive: outcome.hitInteractive },
        element.id,
      );
      attempts.push({ offset, verdict, outcome });
      if (verdict === "reachable") break;
    }
    const reached = attempts.find((a) => a.verdict === "reachable");
    if (reached) {
      if (reached.offset > 0) deltas.push({ label: element.label, offset: reached.offset });
      continue;
    }
    const last = attempts.at(-1);
    const chain = await page.evaluate((id) => globalThis.__uiAudit.clippingChain(id), element.id);
    const culprit = findClippingAncestor(chain ?? []);
    unreachable.push({
      label: element.label,
      selector: element.selector,
      region: element.region,
      verdict: last?.verdict ?? "miss",
      coveredBy: last?.outcome?.hitInteractive ? last.outcome.hitLabel : null,
      triedOffsets: attempts.map((a) => a.offset),
      maxScroll: element.scroll?.max ?? 0,
      clippingAncestor: culprit?.selector ?? null,
      clippingOverflow: culprit ? `${culprit.overflowX}/${culprit.overflowY}` : null,
    });
  }

  const regionSummary = inventory.regions
    .map((r) => `${r.name}${r.offCanvas ? " (off-canvas, skipped)" : ""}`)
    .join(", ");
  record(viewport.name, state.name, "reachability", unreachable.length === 0 ? "PASS" : "FAIL",
    unreachable.length === 0
      ? `${elements.length}/${elements.length} chrome controls hit-test their own centre [${regionSummary}]`
      : `${unreachable.length}/${elements.length} unreachable: ${unreachable.map((u) =>
          `${u.label}${u.coveredBy ? ` covered by ${u.coveredBy}` : ` not at its centre`}`
          + ` (tried scrollLeft ${u.triedOffsets.join("/")}, bar max ${u.maxScroll}`
          + `${u.clippingAncestor ? `, clipped by ${u.clippingAncestor} ${u.clippingOverflow}` : ""})`).join("; ")}`);

  if (deltas.length > 0) {
    record(viewport.name, state.name, "scroll delta", "PASS",
      `reachable only after scrolling: ${deltas.map((d) => `${d.label} @ ${d.offset}px`).join(", ")}`);
  }

  // --- Covering an der Maximalposition ------------------------------------
  const coveringRows = [];
  for (const element of elements) {
    if (element.scroll) {
      await page.evaluate(([cid, value]) => globalThis.__uiAudit.scrollTo(cid, value), [element.scroll.id, element.scroll.max]);
    }
    const outcome = await page.evaluate(([tid, cid]) => globalThis.__uiAudit.hit(tid, cid), [element.id, element.scroll?.id ?? null]);
    if (outcome.missing) continue;
    // Nur was an dieser Position ueberhaupt im Kasten steht: ein weggerolltes
    // Ziel ist nicht "ueberdeckt", nur weg.
    if (!outcome.insideContainer || !outcome.insideViewport) continue;
    coveringRows.push({
      target: element.id,
      label: element.label,
      hit: outcome.hitId,
      hitLabel: outcome.hitLabel,
      hitInteractive: outcome.hitInteractive,
    });
  }
  const covering = summarizeCovering(coveringRows);
  const maxScroll = Math.max(0, ...elements.map((e) => e.scroll?.max ?? 0));
  const coveringDetail = covering.offenders.map((o) => {
    const row = coveringRows.find((r) => r.target === o.target);
    return `${row?.label ?? o.target} by ${row?.hitLabel ?? o.by}`;
  }).join("; ");
  record(viewport.name, state.name, "covering at max scroll", covering.covered === 0 ? "PASS" : "FAIL",
    covering.covered === 0
      ? `${covering.total} controls visible at scrollLeft ${maxScroll}, none covered`
      : `${covering.covered}/${covering.total} covered at scrollLeft ${maxScroll}: ${coveringDetail}`);

  // --- Fade ---------------------------------------------------------------
  // Am Leisten-Element selbst gemessen, nicht am ersten rollenden Kind: eine
  // Leiste, in die alles passt, hat gar kein rollendes Kind und muss trotzdem
  // "keine Abdunklung" melden.
  const topbarRegion = inventory.regions.find((r) => r.name === "topbar");
  if (topbarRegion) {
    const box = await page.evaluate((id) => {
      const el = globalThis.__uiAudit.element(id);
      return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
    }, topbarRegion.id);
    if (box) {
      const overflows = needsScrollAffordance(box.scrollWidth, box.clientWidth);
      const max = Math.max(0, box.scrollWidth - box.clientWidth);
      const states = [];
      for (const offset of [0, max]) {
        await page.evaluate(([cid, value]) => globalThis.__uiAudit.scrollTo(cid, value), [topbarRegion.id, offset]);
        states.push(await page.evaluate((cid) => globalThis.__uiAudit.fadeState(cid), topbarRegion.id));
      }
      const [atStart, atEnd] = states;
      let verdict = "PASS";
      let detail = `content ${box.scrollWidth}px in ${box.clientWidth}px, fade ${atStart.value ?? "(none)"} at 0, ${atEnd.value ?? "(none)"} at ${atEnd.scrollLeft}`;
      if (overflows) {
        const rightOk = atStart.value === "right" || atStart.value === "both";
        const leftOk = atEnd.value === "left" || atEnd.value === "both";
        if (!rightOk || !leftOk) {
          verdict = "FAIL";
          detail += ` — expected "right" at 0 and "left" at ${max}`;
        }
      } else if (atStart.value && atStart.value !== "none") {
        verdict = "WARN";
        detail += " — fades shown without overflow";
      }
      record(viewport.name, state.name, "top bar fade", verdict, detail);
    }
  }

  // --- Reihenfolge der Kopfleiste (nur Telefon) ----------------------------
  // Die Erreichbarkeit sagt nichts ueber die *Reihenfolge*: ein `order: -1`
  // an einem Geschwister schiebt den Schubladen-Knopf aus der Ecke, waehrend
  // sein eigener Hit-Test weiter stimmt (gemessen: der CPU/RAM-Badge nahm auf
  // dem Telefon den ersten Platz ein, die Schublade war nur noch in der Mitte
  // zu treffen). Deshalb hier die gemessene linke Kante, nicht die DOM-Position.
  if (viewport.mobile && topbarRegion) {
    await page.evaluate(([cid, value]) => globalThis.__uiAudit.scrollTo(cid, value), [topbarRegion.id, 0]);
    const layout = await page.evaluate((id) => globalThis.__uiAudit.layout(id), topbarRegion.id);
    const toggle = layout?.items.find((item) => SIDEBAR_TOGGLE_LABELS.has(item.aria)) ?? null;
    const leftmost = leftmostItem(layout?.items ?? []);
    const inCorner = toggle !== null && isAlignedToEdge(toggle.left, layout.barLeft);
    const measured = (layout?.items ?? [])
      .slice()
      .sort((a, b) => a.left - b.left)
      .map((item) => `${item.label} @${Math.round(item.left)}`)
      .join(", ");
    if (toggle === null) {
      record(viewport.name, state.name, "topbar order", "FAIL",
        `drawer toggle not found in the bar (no aria-label from sidebar.show/hide); interactive children: ${measured}`);
    } else {
      const verdict = leftmost !== null && leftmost.id === toggle.id && inCorner ? "PASS" : "FAIL";
      record(viewport.name, state.name, "topbar order", verdict,
        `bar edge ${Math.round(layout.barLeft)}, drawer toggle "${toggle.label}" left ${Math.round(toggle.left)} (Δ${Math.round(toggle.left - layout.barLeft)})`
        + (verdict === "PASS"
          ? `, leftmost of ${layout.items.length} interactive children`
          : `, leftmost is "${leftmost?.label ?? "(none)"}" @${Math.round(leftmost?.left ?? 0)}; children in order: ${measured}`));
    }
  }

  // --- Roll-Andeutung + Dokumentbreite -----------------------------------
  const surfaces = await page.evaluate(() => globalThis.__uiAudit.scrollSurfaces());
  const offenders = surfaces.filter((s) => !s.fadeAttr && s.scrollbarWidth === "none");
  record(viewport.name, state.name, "scroll affordance", offenders.length === 0 ? "PASS" : "FAIL",
    offenders.length === 0
      ? `${surfaces.length} horizontally scrolling surfaces, all with an affordance`
      : `${offenders.length}/${surfaces.length} without affordance: ${offenders.map((o) => `${o.selector} (${o.scrollWidth}>${o.clientWidth})`).join(", ")}`);

  const doc = inventory.document;
  record(viewport.name, state.name, "document width", doc.scrollWidth <= viewport.width + 1 ? "PASS" : "FAIL",
    `scrollWidth ${doc.scrollWidth} vs innerWidth ${viewport.width}`);

  // --- Tap-Ziele (nur Telefon) -------------------------------------------
  if (viewport.mobile) {
    const tap = summarizeTapTargets(elements.map((e) => ({ selector: e.label, width: e.rect.width, height: e.rect.height })));
    record(viewport.name, state.name, "tap targets <44px", tap.count === 0 ? "PASS" : "WARN",
      `${tap.count}/${elements.length} below 44x44${tap.count ? `: ${tap.smallest.map((t) => `${t.selector} ${Math.round(t.width)}x${Math.round(t.height)}`).join(", ")}` : ""}`);
  }

  // --- Popover / Dialog ---------------------------------------------------
  for (const trigger of elements.filter((e) => e.haspopup)) {
    const name = `popover ${trigger.label}`;
    const before = await page.evaluate(() => globalThis.__uiAudit.popups());
    const beforeIds = new Set([...before.visible, ...before.hidden].map((p) => p.id));
    const handle = (await page.evaluateHandle((id) => globalThis.__uiAudit.element(id), trigger.id)).asElement();
    let openedVia = "pointer";
    try {
      if (!handle) throw new Error("trigger detached");
      await handle.click({ timeout: 2500 });
    } catch {
      // Der Ausloeser ist nicht anklickbar (z. B. von einem festen Knopf
      // bedeckt). Das ist ein eigener Befund — oben schon gemeldet — und darf
      // die Geometrie-Pruefung des Popovers nicht verhindern.
      openedVia = "dom";
      await page.evaluate((id) => globalThis.__uiAudit.element(id)?.click(), trigger.id);
    }
    await page.waitForTimeout(350);
    const after = await page.evaluate(() => globalThis.__uiAudit.popups());
    const opened = after.visible.filter((p) => !beforeIds.has(p.id)).sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
    if (opened.length === 0) {
      const invisible = after.hidden
        .filter((h) => !beforeIds.has(h.id))
        .map((h) => `${h.label} ${Math.round(h.rect.width)}x${Math.round(h.rect.height)}`)
        .join(", ");
      record(viewport.name, state.name, name, "FAIL",
        `no visible popover after click (opened via ${openedVia})${invisible ? `; rendered but invisible: ${invisible}` : ""}`);
      continue;
    }
    const popup = opened[0];
    const inside = isInsideViewport(popup.rect, inventory.viewport, 1);
    const hit = await page.evaluate((id) => globalThis.__uiAudit.hit(id, null), popup.id);
    const verdict = classifyReachability(
      hit.hitId === null ? null : { id: hit.hitId, interactive: hit.hitInteractive },
      popup.id,
    );
    record(viewport.name, state.name, name, inside && verdict === "reachable" ? "PASS" : "FAIL",
      `rect ${Math.round(popup.rect.left)}..${Math.round(popup.rect.right)} x ${Math.round(popup.rect.top)}..${Math.round(popup.rect.bottom)} in ${viewport.width}x${viewport.height}`
      + `, ${inside ? "inside viewport" : "OUTSIDE viewport"}`
      + `, centre hit ${verdict}${verdict === "covered" && hit.hitLabel ? ` (${hit.hitLabel})` : ""}`
      + `, opened via ${openedVia}`);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    let still = await page.evaluate(() => globalThis.__uiAudit.popups());
    if (still.visible.some((p) => opened.some((o) => o.id === p.id))) {
      await page.evaluate((id) => globalThis.__uiAudit.element(id)?.click(), trigger.id);
      await page.waitForTimeout(250);
      still = await page.evaluate(() => globalThis.__uiAudit.popups());
    }
    if (still.visible.some((p) => opened.some((o) => o.id === p.id))) {
      record(viewport.name, state.name, `${name} closes`, "FAIL", "still open after Escape and a second click");
    }
  }
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------
async function finish(result) {
  if (cleanedUp) return;
  cleanedUp = true;
  if (browser) await browser.close().catch(() => {});
  if (child) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* schon weg */
    }
    await new Promise((r) => setTimeout(r, 1200));
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* schon weg */
    }
  }
  rmSync(join(REPO_ROOT, DIST_DIR), { recursive: true, force: true });
  process.exit(typeof result === "number" ? result : 1);
}

// Ein Abbruch mitten im Lauf darf weder den Dev-Server noch Chromium
// stehen lassen: ohne diesen Handler laeuft der Kindprozess weiter und haelt
// seinen Port.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    const code = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129;
    console.error(`\n[ui-audit] ${signal} — raeume auf`);
    void finish(code);
    setTimeout(() => process.exit(code), 5000);
  });
}

async function main() {
  if (typeof process.versions.bun === "undefined") {
    throw new Error("ui:audit wants Bun (`bun run ui:audit`): the dev server imports the SDK's TypeScript sources.");
  }
  startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-").slice(0, 19);
  runDir = `/tmp/omp-ui-audit-${stamp}`;
  mkdirSync(runDir, { recursive: true });
  // Ein Rest eines abgebrochenen Laufs wuerde sonst als "schon kompiliert"
  // gelesen und einen Fehler im Quelltext verdecken.
  rmSync(join(REPO_ROOT, DIST_DIR), { recursive: true, force: true });

  // Zwei Fixture-Projekte: eines ohne und eines mit einem trust-relevanten
  // Ressourcenverzeichnis. Angelegt, nicht gestartet — kein Agent laeuft.
  const home = join(runDir, "homes", "omp");
  const projects = { plain: join(home, "project-plain"), untrusted: join(home, "project-untrusted") };
  mkdirSync(projects.plain, { recursive: true });
  mkdirSync(join(projects.untrusted, ".omp"), { recursive: true });
  for (const sub of ["home", "home/.config", "home/.cache", "home/.local/state", "home/.local/share"]) {
    mkdirSync(join(runDir, sub), { recursive: true });
  }
  writeFileSync(join(projects.plain, "README.md"), "# ui-audit fixture\n");
  writeFileSync(join(projects.untrusted, ".omp", "config.yml"), "# ui-audit trust fixture\n");

  try {
    accessSync(CHROMIUM_PATH, constants.X_OK);
  } catch {
    throw new Error(`Chromium nicht gefunden oder nicht ausfuehrbar: ${CHROMIUM_PATH} (PLAYWRIGHT_CHROMIUM_PATH setzen).`);
  }

  const port = await pickPort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ...auditEnv(runDir) };
  console.log(`omp-ui-audit  ${stamp}`);
  console.log(`  repo      ${REPO_ROOT}`);
  console.log(`  chromium  ${CHROMIUM_PATH}`);
  console.log(`  dev       ${baseUrl} (Wegwerf-Identitaet "omp", isolierter Agent-Dir)`);
  console.log(`  report    ${join(runDir, "report.json")}`);

  child = spawn(
    process.execPath,
    [join(REPO_ROOT, "scripts", "run-next.mjs"), "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)],
    { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  child.stdout.on("data", (chunk) => writeFileSync(join(runDir, "dev-server.log"), chunk, { flag: "a" }));
  child.stderr.on("data", (chunk) => writeFileSync(join(runDir, "dev-server.log"), chunk, { flag: "a" }));

  await waitForServer(baseUrl);
  browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });

  for (const viewport of VIEWPORTS) {
    console.log(`\n== ${viewport.name}${viewport.mobile ? " (mobile, hasTouch)" : ""} ==`);
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
      deviceScaleFactor: 1,
      locale: "de-DE",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      consoleEntries.push({ viewport: viewport.name, kind: "pageerror", text: error.message });
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // Ein abgebrochener Request beim Seitenwechsel ist kein Fehler der App.
      if (/ERR_ABORTED/.test(text)) return;
      consoleEntries.push({ viewport: viewport.name, kind: "console.error", text });
    });
    await page.addInitScript(installAuditHelpers);

    // Login im Browser: derselbe Weg wie ein Mensch, Cookie bleibt im Jar.
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    const login = await page.evaluate(async (password) => {
      const response = await fetch("/api/web-access/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      return { status: response.status, body: (await response.text()).slice(0, 200) };
    }, env.OMP_WEB_PASSWORD);
    if (login.status !== 200) throw new Error(`login failed: HTTP ${login.status} ${login.body}`);

    for (const state of TOPBAR_STATES) await auditState(page, viewport, state, baseUrl, projects);
    await context.close();
  }

  if (consoleEntries.length > 0) {
    record("all", "all", "console", "FAIL",
      `${consoleEntries.length} error(s): ${consoleEntries.slice(0, 3).map((e) => `${e.viewport} ${e.text.slice(0, 140)}`).join(" | ")}${consoleEntries.length > 3 ? " …" : ""}`);
  } else {
    record("all", "all", "console", "PASS", "no pageerror and no console.error");
  }
}

main()
  .catch((error) => {
    record("run", "run", "run", "FAIL", error instanceof Error ? error.message : String(error));
  })
  .then(() => {
    if (runDir === null) {
      console.error("[ui-audit] kein Lauf-Verzeichnis — der Lauf ist vor dem Start gescheitert");
      return 1;
    }
    const report = {
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl,
      chromium: CHROMIUM_PATH,
      reportDir: runDir,
      checks,
      console: consoleEntries,
      summary: { ...status, exitCode: status.fail === 0 ? 0 : 1 },
    };
    writeFileSync(join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${status.pass} PASS, ${status.fail} FAIL, ${status.warn} WARN`);
    const failures = checks.filter((c) => c.status === "FAIL");
    if (failures.length > 0) {
      console.log("FAIL:");
      for (const failure of failures) console.log(`  - ${failure.viewport}/${failure.state}: ${failure.name} — ${failure.measurement}`);
    }
    console.log(`report: ${join(runDir, "report.json")}`);
    return status.fail === 0 ? 0 : 1;
  })
  .then(finish, finish);
