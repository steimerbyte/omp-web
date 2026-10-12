import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { isNavigation, proxy } = await jiti.import("./proxy.ts");

const ORIGIN = "http://localhost:30141";

/**
 * Ein Aufruf gegen den Proxy. Der `host`-Header ist Pflicht, sonst laeuft der
 * Request schon in `isApiRequestHostAllowed` gegen eine Mauer und die
 * Navigation-Entscheidung wird nie erreicht.
 */
function request(path, headers = {}) {
  return new NextRequest(`${ORIGIN}${path}`, { headers: { host: "localhost:30141", ...headers } });
}

/** Dieselbe Ableitung, die `proxy()` selbst trifft — `/api` und `/api/...`. */
function isApiPath(path) {
  return path === "/api" || path.startsWith("/api/");
}

/** Die Entscheidung, um die es geht: 302 (Dokument) oder 401 (Skript). */
function navigates(path, headers) {
  return isNavigation(request(path, headers), isApiPath(path));
}

// ---------------------------------------------------------------------------
// Gruppe 1 — Browser-Navigation. Muss 302 ergeben.
// ---------------------------------------------------------------------------

test("eine Adressleisten-Navigation auf / ist eine Navigation", () => {
  // Chrome und Firefox senden fuer jeden Dokument-Ladung genau das hier. Ohne
  // diesen Fall waere der Proxy blind gegen das haeufigste Request-Muster.
  assert.equal(navigates("/", { "sec-fetch-mode": "navigate" }), true);
});

test("curl auf die Basis-Domain ist eine Navigation", () => {
  // `curl http://host/` traegt keine Fetch-Metadaten. Ohne Fallback bekommt der
  // Aufrufer ein JSON-Body als Dokument — genau das, was vermieden werden soll.
  assert.equal(navigates("/", {}), true);
});

test("Sec-Fetch-Mode: cors mit Accept: text/html auf / ist eine Navigation", () => {
  // Luecke A. `navigate` galt vorher als einziger Beweis fuer eine Navigation,
  // also fiel `Sec-Fetch-Mode: cors` auf eine 401 mit JSON-Body durch. Ob der
  // Modus stimmt, ist fuer eine Seiten-URL die falsche Frage: `Accept` sagt,
  // ob der Aufrufer ein Dokument will.
  assert.equal(navigates("/", { "sec-fetch-mode": "cors", accept: "text/html" }), true);
});

test("eine Adressleisten-Navigation auf eine API-URL ist eine Navigation", () => {
  // Wer `/api/whoami` in die Adressleiste tippt, laedt ein Dokument. Das ist
  // eine ganz normale Seite und muss genauso auf `/login` landen.
  assert.equal(navigates("/api/whoami", { "sec-fetch-mode": "navigate" }), true);
});

test("Sec-Fetch-Site: same-origin ohne Modus auf /api/whoami ist eine Navigation", () => {
  // Luecke B. `Sec-Fetch-Site` wurde gar nicht gelesen, also bekam diese Form
  // die 401 mit JSON-Body. "Site ohne Modus" ist kein echter `fetch()` — der
  // traegt immer `Sec-Fetch-Mode: cors` mit und erreicht diesen Zweig nie.
  assert.equal(navigates("/api/whoami", { "sec-fetch-site": "same-origin" }), true);
});

// ---------------------------------------------------------------------------
// Gruppe 2 — Skript/Client. Muss 401 ergeben, sonst bricht der Aufrufer still.
// ---------------------------------------------------------------------------

test("der eigene fetch() der App auf /api/whoami ist keine Navigation", () => {
  // Der wichtigste Negativfall. Ein umgeleiteter XHR kann seine 401 nicht lesen,
  // die App bleibt dann ohne Fehlermeldung stehen.
  assert.equal(navigates("/api/whoami", { "sec-fetch-mode": "cors" }), false);
});

test("curl auf /api/whoami ist keine Navigation", () => {
  // Derselbe Aufrufer wie oben, nur ohne Fetch-Metadaten. Seine dokumentierte
  // Antwort ist die 401 mit Challenge — `curl --anyauth` sowie die Go-, Java-
  // und Rust-Stacks warten auf den Header, bevor sie sich ausweisen.
  assert.equal(navigates("/api/whoami", {}), false);
});

test("Accept: application/json auf / ist keine Navigation", () => {
  // Wer JSON verlangt, bekommt JSON. Diese Regel gilt fuer die acceptierte
  // Seite, nicht dafuer, jede Anfrage umzulenken.
  assert.equal(navigates("/", { "sec-fetch-mode": "cors", accept: "application/json" }), false);
});

test("X-Requested-With schliesst die Navigation in jedem Aufbau aus", () => {
  // jQuery und alles, was darauf gebaut ist, setzt den Header auf einem XHR, und
  // keine Browser-Navigation setzt ihn. Er ist die explizite Ansage "ich bin
  // ein Skriptaufruf", und nichts Spateres darf sie ueberstimmen — auch nicht
  // ein `navigate` oder ein `Accept: text/html`.
  const shapes = [
    ["/", { "sec-fetch-mode": "navigate" }],
    ["/", { "sec-fetch-mode": "cors", accept: "text/html" }],
    ["/api/whoami", { "sec-fetch-mode": "navigate" }],
    ["/api/whoami", { "sec-fetch-mode": "cors" }],
    ["/api/whoami", { "sec-fetch-site": "same-origin" }],
  ];
  for (const [path, headers] of shapes) {
    assert.equal(
      navigates(path, { ...headers, "x-requested-with": "XMLHttpRequest" }),
      false,
      `${path} ${JSON.stringify(headers)} muss durch X-Requested-With ausgeschlossen werden`,
    );
  }
});

// ---------------------------------------------------------------------------
// Gruppe 3 — Accept-Parsing. Eigene Logik in `acceptsHtmlDocument`.
// Alle Faelle tragen `Sec-Fetch-Mode: cors`, damit allein die Accept-Regel
// ueber den Ausgang entscheidet — sonst verdeckt der Modus-Zweig sie.
// ---------------------------------------------------------------------------

test("Accept: text/html;q=0 schliesst die Navigation aus", () => {
  // `q=0` ist eine ausdrueckliche Ablehnung, keine unbestimmte Angabe. Ein
  // Aufrufer, der `text/html` ausschliesst, will keines.
  assert.equal(navigates("/", { "sec-fetch-mode": "cors", accept: "text/html;q=0" }), false);
});

test("Accept: */* schliesst die Navigation aus", () => {
  // Der Platzhalter steht in praktisch jedem `fetch()` und sagt nichts ueber
  // den Wunsch nach einer Seite. Nur `text/html` zaehlt als Dokument.
  assert.equal(navigates("/", { "sec-fetch-mode": "cors", accept: "*/*" }), false);
});

test("Accept: text/html,application/xhtml+xml,*/*;q=0.8 ist eine Navigation", () => {
  // Der Accept-Header eines echten Dokument-Ladens. Das `*/*;q=0.8` stoert die
  // Auswertung nicht, weil `text/html` ohne q=0 daneben steht.
  assert.equal(
    navigates("/", { "sec-fetch-mode": "cors", accept: "text/html,application/xhtml+xml,*/*;q=0.8" }),
    true,
  );
});

test("fehlender Accept-Header schliesst ueber diese Regel die Navigation aus", () => {
  // Kein Accept heisst hier nichts. Faellt die Accept-Regel aus, entscheidet der
  // Modus-Zweig — und `cors` ist keine Navigation.
  assert.equal(navigates("/", { "sec-fetch-mode": "cors" }), false);
});

// ---------------------------------------------------------------------------
// Kopplung: `isNavigation` und `rejectionHeaders` lesen dieselben Achsen.
// ---------------------------------------------------------------------------

/**
 * Der ganze Test braucht einen gesperrten Server, sonst laesst der Proxy den
 * Request durch und es gibt nichts zu unterscheiden. `OMP_WEB_PASSWORD` ist der
 * Modus, in dem der Server das Geheimnis selbst haelt: ohne `Authorization`
 * lautet die Entscheidung `unauthorized`.
 */
function lockServer(t) {
  const previous = {
    password: process.env.OMP_WEB_PASSWORD,
    username: process.env.OMP_WEB_USERNAME,
  };
  process.env.OMP_WEB_PASSWORD = "correct horse battery staple";
  process.env.OMP_WEB_USERNAME = "admin";
  t.after(() => {
    if (previous.password === undefined) delete process.env.OMP_WEB_PASSWORD;
    else process.env.OMP_WEB_PASSWORD = previous.password;
    if (previous.username === undefined) delete process.env.OMP_WEB_USERNAME;
    else process.env.OMP_WEB_USERNAME = previous.username;
  });
}

test("ein als Navigation erkannter Browser bekommt keinen WWW-Authenticate", (t) => {
  // Bricht die Kopplung, bekommt derselbe Aufrufer den 302 nach `/login` UND
  // den Challenge-Header — und damit den nativen Basic-Dialog zurueck, ohne
  // dass jemand es bemerkt. Geprueft wird deshalb die ganze Antwort, nicht nur
  // der Status.
  lockServer(t);
  const shapes = [
    ["/", { "sec-fetch-mode": "navigate" }],
    ["/", {}],
    ["/", { "sec-fetch-mode": "cors", accept: "text/html" }],
    ["/api/whoami", { "sec-fetch-mode": "navigate" }],
    ["/api/whoami", { "sec-fetch-site": "same-origin" }],
  ];
  for (const [path, headers] of shapes) {
    const response = proxy(request(path, headers));
    assert.equal(response.status, 302, `${path} ${JSON.stringify(headers)} muss umgeleitet werden`);
    assert.equal(response.headers.get("location"), `${ORIGIN}/login`);
    assert.equal(
      response.headers.get("www-authenticate"),
      null,
      `${path} ${JSON.stringify(headers)} darf keinen Challenge-Header sehen`,
    );
  }
});

test("ein Skript bekommt die 401 mit Challenge, und ein Browser-XHR nicht", (t) => {
  // Die Gegenrichtung derselben Kopplung: wer als Skript klassifiziert ist,
  // braucht den Header, sonst authentifiziert er sich nie. Wer Fetch-Metadaten
  // traegt, bekommt ihn nicht — ein XHR, der als Skript durchgeht, darf keinen
  // Dialog ausloesen.
  lockServer(t);

  const curlResponse = proxy(request("/api/whoami"));
  assert.equal(curlResponse.status, 401);
  assert.equal(curlResponse.headers.get("www-authenticate"), 'Basic realm="omp-web", charset="UTF-8"');

  const xhrResponse = proxy(request("/api/whoami", { "sec-fetch-mode": "cors" }));
  assert.equal(xhrResponse.status, 401);
  assert.equal(xhrResponse.headers.get("www-authenticate"), null);
});