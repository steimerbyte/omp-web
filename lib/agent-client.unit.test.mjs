import assert from "node:assert/strict";
import test from "node:test";
import { canApplySessionIdentity } from "./agent-client.ts";

/**
 * `canApplySessionIdentity` decides whether a late HTTP answer may still
 * overwrite the identity the composer is showing. The rule has two legs: the
 * answer belongs to the identity already applied, or it belongs to the request
 * that still owns the selected runtime.
 */

const identity = (sessionId, runtimeId) => ({ sessionId, runtimeId });

test("an answer for the identity already applied is accepted", () => {
  const applied = identity("session-1", "runtime-1");

  assert.equal(canApplySessionIdentity(applied, identity("session-1", "runtime-1"), identity("session-2", "runtime-2")), true);
});

test("an answer is accepted while its own request still owns the runtime", () => {
  const request = identity("session-old", "runtime-1");

  // The selected session is still the request's own persisted id.
  assert.equal(
    canApplySessionIdentity(identity("session-old", "runtime-1"), identity("session-old", "runtime-2"), request),
    true,
  );
  // The selected session is still the request's own persisted id, so the
  // answer's persisted id may replace it even though the identities differ.
  assert.equal(
    canApplySessionIdentity(identity("session-old", "runtime-1"), identity("session-new", "runtime-1"), request),
    true,
  );
});

test("an answer from a superseded request is dropped", () => {
  const request = identity("session-old", "runtime-1");

  // Another runtime was selected: the answer belongs to a session nobody is
  // looking at any more.
  assert.equal(
    canApplySessionIdentity(identity("session-new", "runtime-2"), identity("session-newer", "runtime-2"), request),
    false,
  );
  // Same runtime, but the selected session is neither the request's nor the
  // answered one.
  assert.equal(
    canApplySessionIdentity(identity("someone-else", "runtime-1"), identity("session-new", "runtime-1"), request),
    false,
  );
});

test("a transition from runtime id to persisted id stays applicable", () => {
  // The request started on a live runtime handle before the file existed; the
  // answer carries the persisted id. The runtime still matches, so it applies.
  const request = identity("session-live", "runtime-9");

  assert.equal(
    canApplySessionIdentity(identity("session-live", "runtime-9"), identity("session-persisted", "runtime-9"), request),
    true,
  );
  // A null runtime is a value, not a wildcard.
  assert.equal(
    canApplySessionIdentity(identity("session-live", null), identity("session-persisted", null), identity("session-live", "runtime-9")),
    false,
  );
});
