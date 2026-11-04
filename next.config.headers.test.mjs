import assert from "node:assert/strict";
import test from "node:test";

import { buildCustomRoute } from "next/dist/lib/build-custom-route.js";
import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher.js";

/**
 * `next.config.ts` ist die einzige Stelle, die Dokument-Header setzt; was hier
 * fehlt, kommt auch nicht an. Der Matcher ist Nexts eigener
 * (`buildCustomRoute` + `getRouteMatcher`) und nicht eine Nachbildung — die
 * negative Lookahead-Gruppe ist genau die Stelle, an der ein spaeteres
 * `/(.*)` das CSP der API-Routen verdraengt.
 */
const config = (await import("./next.config.ts")).default;

const rules = await config.headers();

function ruleFor(source) {
  const found = rules.filter((rule) => rule.source === source);
  assert.equal(found.length, 1, `expected exactly one rule for ${source}`);
  return found[0];
}

function header(rule, key) {
  const found = rule.headers.filter((entry) => entry.key.toLowerCase() === key.toLowerCase());
  assert.equal(found.length, 1, `expected exactly one ${key} header in ${rule.source}`);
  return found[0].value;
}

function matcherFor(source) {
  const compiled = buildCustomRoute("header", { source, headers: [] });
  return getRouteMatcher({ re: new RegExp(compiled.regex), groups: {} });
}

const securityRule = rules.find((rule) =>
  rule.headers.some((entry) => entry.key === "Content-Security-Policy"),
);

test("poweredByHeader ist aus", () => {
  assert.equal(config.poweredByHeader, false);
});

test("genau eine Regel setzt die Security-Header, und sie nimmt /api aus", () => {
  const withCsp = rules.filter((rule) =>
    rule.headers.some((entry) => entry.key === "Content-Security-Policy"),
  );
  assert.equal(withCsp.length, 1, "a second CSP rule can silently replace a route's own CSP");

  const match = matcherFor(securityRule.source);
  for (const path of ["/", "/login", "/recover", "/_next/static/app/x.js", "/sw.js", "/offline.html", "/apiary/x"]) {
    assert.equal(Boolean(match(path)), true, `${securityRule.source} must cover ${path}`);
  }
  for (const path of ["/api", "/api/whoami", "/api/sessions/x/export", "/api/files/a/b"]) {
    assert.equal(Boolean(match(path)), false, `${securityRule.source} must not cover ${path}`);
  }
});

test("die CSP erlaubt den App-Alltag und verbietet eval, Framing und Objekte", () => {
  const csp = header(securityRule, "Content-Security-Policy");

  for (const directive of [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ]) {
    assert.ok(csp.includes(directive), `CSP is missing ${directive}`);
  }
  // `frame-ancestors 'none'` wuerde die srcDoc-Vorschau blockieren, die die
  // CSP des Eltern-Dokuments erbt.
  assert.ok(!csp.includes("frame-ancestors 'none'"));
  // Ein Nonce ist in prerendertem HTML nicht unterzubringen; wer ihn hier
  // eintraegt, macht die Seiten ohne Nonce unbrauchbar.
  assert.ok(!csp.includes("'nonce-"));
  assert.ok(!csp.includes("'unsafe-eval'"));
});

test("die restlichen Header sind gesetzt", () => {
  assert.equal(header(securityRule, "X-Frame-Options"), "SAMEORIGIN");
  assert.equal(header(securityRule, "X-Content-Type-Options"), "nosniff");
  assert.equal(header(securityRule, "Referrer-Policy"), "no-referrer");
  assert.match(header(securityRule, "Permissions-Policy"), /camera=\(\)/);
  // HSTS ist Sache der TLS-Terminierung, nicht der App: ein zweiter Header
  // ersetzt an der Kante den Betreiber-Wert statt ihn zu ergaenzen.
  assert.equal(
    securityRule.headers.some((entry) => entry.key.toLowerCase() === "strict-transport-security"),
    false,
  );
});

test("/login und /recover sind private und nicht cachebar", () => {
  for (const page of ["/login", "/recover"]) {
    assert.equal(header(ruleFor(page), "Cache-Control"), "private, no-store");
  }
});

test("in next dev gibt es keine Dokument-CSP", async () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    const devRules = await config.headers();
    assert.equal(
      devRules.some((rule) => rule.headers.some((entry) => entry.key === "Content-Security-Policy")),
      false,
      "the dev bundle needs eval and would break under this CSP",
    );
  } finally {
    process.env.NODE_ENV = previous;
  }
});
