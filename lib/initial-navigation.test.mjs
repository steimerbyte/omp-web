import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./initial-navigation.ts");
}

test("uses cwd instead of session when both parameters are present", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(new URLSearchParams({
    cwd: " /work/project ",
    session: "saved-session",
  }));

  assert.deepEqual(result, {
    requestedCwd: "/work/project",
    sessionId: null,
    requestedView: "chat",
  });
});

test("restores session when cwd is absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session", requestedView: "chat" },
  );
});

test("treats an empty cwd as absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ cwd: "  ", session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session", requestedView: "chat" },
  );
});

test("preserves a URL-encoded Windows path", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams("cwd=C%3A%5CProjects%5Comp-web")),
    { requestedCwd: "C:\\Projects\\omp-web", sessionId: null, requestedView: "chat" },
  );
});

test("asks for the projects view when the URL says so", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.equal(
    getInitialNavigation(new URLSearchParams({ view: "projects" })).requestedView,
    "projects",
  );
});

test("an unknown view name falls back to chat", async () => {
  const { getInitialNavigation } = await loadSubject();

  // A view name arriving from a URL is user input. It must be able to select
  // the one view that exists and nothing else.
  for (const view of ["admin", "PROJECTS", "chat", "", "projects;drop"]) {
    assert.equal(
      getInitialNavigation(new URLSearchParams({ view })).requestedView,
      "chat",
      `view=${view} must not select a view`,
    );
  }
});

test("no view parameter means chat", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.equal(getInitialNavigation(new URLSearchParams({})).requestedView, "chat");
});
