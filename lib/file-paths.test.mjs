import assert from "node:assert/strict";
import test from "node:test";

import { encodeFilePathForApi, filePathFromSegments } from "./file-paths.ts";

/**
 * The URL a path turns into, and the path that URL turns back into.
 *
 * The root was the case nobody wrote down: `encodeFilePathForApi("/")` returned
 * the empty string, because splitting `/` gives two empty segments and both
 * were filtered out. The client then asked for `/api/files/?type=list`, which
 * is not a request for a path at all — Next redirects it to `/api/files`
 * (308) and there is no catch-all route there (404). The EXPLORER showed
 * "Failed to load files (HTTP 404)" for the home of an admin, whose home *is*
 * `/`.
 *
 * `%2F` is one segment and the route decodes it back to `/`, so the pair below
 * is the contract: whatever the encoder emits for a path, the route's own
 * de-segmentation must produce that same path again. The non-root lines are
 * the counter-check — the fix must not move any other path.
 */
test("die Wurzel wird als ein Segment kodiert und wieder zur Wurzel dekodiert", () => {
  assert.equal(encodeFilePathForApi("/"), "%2F");
  assert.equal(filePathFromSegments(["/"]), "/");
  // Kein leeres Segment: eine URL ohne Pfad ist keine Anfrage an einen Pfad.
  assert.notEqual(encodeFilePathForApi("/"), "");

  // Jeder andere Pfad bleibt, wie er war.
  assert.equal(encodeFilePathForApi("/home/me/workspace"), "home/me/workspace");
  assert.equal(encodeFilePathForApi("/home/me/workspace/"), "home/me/workspace");
  assert.equal(
    filePathFromSegments(encodeFilePathForApi("/home/me/workspace").split("/")),
    "/home/me/workspace",
  );
  // Ein Dateiname mit Prozentzeichen und Leerzeichen bleibt kodiert.
  assert.equal(encodeFilePathForApi("/tmp/a b%c"), "tmp/a%20b%25c");
});
