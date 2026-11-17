import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Der Client-Vertrag des Composer-Uploads.
 *
 * Hier steht die ganze Uebersetzung zwischen Route und Composer: die
 * Ticket-URL (CWD kodiert, `conflict=skip`), der PUT an `/upload/<token>`, die
 * Wege, auf denen die Route "hat geklappt", "gibt es schon" und "Fehler"
 * meldet, und die `@`-Erwaehnung, an der der Agent die Datei spaeter findet.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  MAX_CHAT_UPLOAD_BYTES,
  MAX_CHAT_UPLOAD_LABEL,
  appendUploadReferences,
  formatFileSize,
  uploadFileToCwd,
} = await jiti.import("./file-upload-client.ts");

test("appends one mention per file and none for a file the draft already mentions", () => {
  assert.equal(
    appendUploadReferences("read this", [{ path: "sample.csv" }]),
    "read this @sample.csv",
  );
  assert.equal(
    appendUploadReferences("read this", [{ path: "two words.csv" }]),
    'read this @"two words.csv"',
  );
  assert.equal(
    appendUploadReferences("", [{ path: "sample.csv" }]),
    "@sample.csv",
    "eine Nachricht aus nur einem Anhang bleibt sendbar",
  );
  assert.equal(appendUploadReferences("only text", []), "only text", "ohne Anhang bleibt der Text unveraendert");
  assert.equal(
    appendUploadReferences("read", [{ path: "sheet.csv:12-14" }]),
    "read @sheet.csv:12-14",
    "kein Zeilenbereich wird erfunden oder entfernt — die Aufrufer uebergeben den Pfad",
  );

  // Der Entwurf nennt die Datei schon — dann kommt keine zweite Erwaehnung dazu.
  const alreadyMentioned = appendUploadReferences("Read @sample.csv and print it", [{ path: "sample.csv" }]);
  assert.equal(alreadyMentioned, "Read @sample.csv and print it");
  assert.equal((alreadyMentioned.match(/@sample\.csv(?:\s|$)/g) ?? []).length, 1, "genau eine Erwaehnung");

  // Dieselbe Datei in gequoteter Form ist dieselbe Erwaehnung, nicht eine neue.
  const quoted = appendUploadReferences('read @"two words.csv" now', [{ path: "two words.csv" }]);
  assert.equal(quoted, 'read @"two words.csv" now');
  assert.equal((quoted.match(/@(?:"two words\.csv"|two words\.csv)/g) ?? []).length, 1, "quoted == unquoted");

  // Satzzeichen nach der Erwaehnung sind kein zweiter Verweis.
  assert.equal(appendUploadReferences("see @sample.csv.", [{ path: "sample.csv" }]), "see @sample.csv.");

  // Ein laengerer Name ist ein anderer Pfad: `@sample.csv` fehlt hier noch.
  assert.equal(
    appendUploadReferences("see @sample.csv.bak", [{ path: "sample.csv" }]),
    "see @sample.csv.bak @sample.csv",
  );

  // Von zwei Anhaengen fehlt nur einer.
  assert.equal(
    appendUploadReferences("look at @a.csv", [{ path: "a.csv" }, { path: "b.csv" }]),
    "look at @a.csv @b.csv",
  );
});

test("formats sizes for the chip", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(1023), "1023 B");
  assert.equal(formatFileSize(1536), "1.5 kB");
  assert.equal(formatFileSize(20 * 1024), "20 kB");
  assert.equal(formatFileSize(Math.round(1.5 * 1024 * 1024)), "1.5 MB");
  assert.equal(formatFileSize(20 * 1024 * 1024), "20 MB");
  assert.equal(formatFileSize(1024 * 1024 * 1024), "1.0 GB");
  assert.equal(formatFileSize(10 * 1024 ** 3), "10 GB");
});

/** Mint und PUT getrennt beantwortbar; alles landet in `calls`. */
function stubUpload({ mint = { status: 200, body: { token: "tok-1" } }, put = { status: 200, body: {} } } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    calls.push({ url: href, init });
    const reply = href.startsWith("/upload/") ? put : mint;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    };
  };
  return calls;
}

test("mints a ticket for the cwd with conflict=skip, then PUTs the file to /upload/<token>", async () => {
  const original = globalThis.fetch;
  const calls = stubUpload({
    put: { status: 200, body: { uploaded: ["report.csv"], skipped: [], errors: [] } },
  });
  try {
    const file = new File(["a,b\n"], "report.csv", { type: "text/csv" });
    const result = await uploadFileToCwd("/home/alice/project", file);

    assert.deepEqual(result, { ok: true, file: { name: "report.csv", size: 4, path: "report.csv" } });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "/api/files/home/alice/project?type=upload-ticket&conflict=skip");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body), { name: "report.csv", size: 4 });
    assert.equal(calls[1].url, "/upload/tok-1");
    assert.equal(calls[1].init.method, "PUT");
    assert.equal(calls[1].init.body, file, "der Blob geht unveraendert als Body");
  } finally {
    globalThis.fetch = original;
  }
});

test("a skipped name is a conflict, not a silent success", async () => {
  const original = globalThis.fetch;
  const calls = stubUpload({ mint: { status: 200, body: { skipped: ["report.csv"] } } });
  try {
    const result = await uploadFileToCwd("/home/alice/project", new File(["new"], "report.csv"));
    assert.equal(result.ok, false);
    assert.equal(result.kind, "conflict");
    assert.equal(result.name, "report.csv");
    assert.equal(calls.length, 1, "ohne Ticket wird kein Body geschickt");
  } finally {
    globalThis.fetch = original;
  }
});

test("a failed PUT is reported with the server text", async () => {
  const original = globalThis.fetch;
  stubUpload({ put: { status: 500, body: { error: "ENOSPC: no space left on device" } } });
  try {
    const result = await uploadFileToCwd("/home/alice/project", new File(["x"], "x.csv"));
    assert.equal(result.ok, false);
    assert.equal(result.kind, "failed");
    assert.equal(result.error, "ENOSPC: no space left on device");
  } finally {
    globalThis.fetch = original;
  }
});

test("a mint without a token is a failure, not an upload", async () => {
  const original = globalThis.fetch;
  const calls = stubUpload({ mint: { status: 200, body: {} } });
  try {
    const result = await uploadFileToCwd("/home/alice/project", new File(["x"], "x.csv"));
    assert.deepEqual(result, { ok: false, kind: "failed", error: "The server sent no upload ticket" });
    assert.equal(calls.length, 1, "ohne Ticket wird kein Body geschickt");
  } finally {
    globalThis.fetch = original;
  }
});

test("a dropped PUT connection is reported, not thrown", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/upload/")) throw new Error("connection reset");
    return { ok: true, status: 200, json: async () => ({ token: "tok-1" }) };
  };
  try {
    const result = await uploadFileToCwd("/home/alice/project", new File(["x"], "x.csv"));
    assert.deepEqual(result, { ok: false, kind: "failed", error: "connection reset" });
  } finally {
    globalThis.fetch = original;
  }
});

test("a PUT that reports a write error or no file is a failure", async () => {
  const original = globalThis.fetch;
  try {
    stubUpload({ put: { status: 200, body: { uploaded: [], skipped: [], errors: [{ name: "x.csv", error: "disk full" }] } } });
    const writeError = await uploadFileToCwd("/home/alice/project", new File(["x"], "x.csv"));
    assert.deepEqual(writeError, { ok: false, kind: "failed", error: "disk full" });

    stubUpload({ put: { status: 200, body: { uploaded: [], skipped: [], errors: [] } } });
    const missing = await uploadFileToCwd("/home/alice/project", new File(["x"], "x.csv"));
    assert.deepEqual(missing, { ok: false, kind: "failed", error: "The server reported no uploaded file" });
  } finally {
    globalThis.fetch = original;
  }
});

test("maps statuses to kinds and never throws on a network failure", async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, kind] of [[413, "tooLarge"], [403, "forbidden"], [404, "forbidden"], [400, "forbidden"], [500, "failed"]]) {
      stubUpload({ mint: { status, body: {} } });
      const result = await uploadFileToCwd("/home/alice/project", new File(["x"], "x.csv"));
      assert.equal(result.ok, false);
      assert.equal(result.kind, kind, `HTTP ${status}`);
    }

    globalThis.fetch = async () => { throw new Error("connection reset"); };
    const result = await uploadFileToCwd("/home/alice/project", new File(["x"], "x.csv"));
    assert.deepEqual(result, { ok: false, kind: "failed", error: "connection reset" });
  } finally {
    globalThis.fetch = original;
  }
});

test("a file above the cap is refused before any request is sent", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    // 10 GiB + 1 darf nicht alloziert werden; die Pruefung liest nur `size`.
    const big = { name: "big.bin", size: MAX_CHAT_UPLOAD_BYTES + 1 };
    const result = await uploadFileToCwd("/home/alice/project", big);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "tooLarge");
    assert.equal(result.error, `Files must be ${MAX_CHAT_UPLOAD_LABEL} or smaller`);
    assert.equal(calls, 0, "die Grenze greift vor dem Netz");
  } finally {
    globalThis.fetch = original;
  }
});
