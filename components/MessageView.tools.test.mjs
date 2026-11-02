import assert from "node:assert/strict";
import test from "node:test";
import * as linkedom from "linkedom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * Delegation cards: a vibe tool result, an async background result and a batch
 * `task` call. Most cases render to a string (like MessageView.test.mjs); the
 * disclosure test needs a real DOM, so the linkedom globals are installed
 * before the component is imported — motion reads them at module load.
 */
const dom = linkedom.parseHTML("<!doctype html><html><body></body></html>");
const fakeNavigator = { userAgent: "test", languages: ["en-US"], language: "en-US", platform: "linux" };
// A bare proxy breaks linkedom, whose methods read internal state off `this`.
globalThis.window = new Proxy(dom.window, {
  get(target, prop) {
    if (prop === "navigator") return fakeNavigator;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
globalThis.document = dom.document;
globalThis.navigator = fakeNavigator;
for (const [name, value] of Object.entries(linkedom)) {
  if (name === "parseHTML" || name === "default") continue;
  if (typeof value === "function" && /^[A-Z]/.test(name)) globalThis[name] = value;
}
for (const name of Object.keys(dom.window)) {
  if (name === "window") continue;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.writable) continue;
  globalThis[name] = dom.window[name];
}
globalThis.Event = dom.window.Event;
globalThis.EventTarget = dom.window.EventTarget;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};
globalThis.localStorage = localStorage;
dom.window.localStorage = localStorage;

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

function render(message, toolResults) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, toolResults }),
    ),
  );
}

function assistantWithToolCall(toolName, input, toolCallId) {
  return {
    role: "assistant",
    provider: "test",
    model: "test",
    content: [{ type: "toolCall", toolCallId, toolName, input }],
  };
}

function toolResult(toolCallId, toolName, content, details) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    ...(details === undefined ? {} : { details }),
  };
}

const mountedRoots = [];

async function mount(element) {
  const container = document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => { root.render(React.createElement(I18nProvider, null, element)); });
  return container;
}

test.after(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
});

test("renders a vibe_wait result as a screen wall, not as JSON", () => {
  const html = render(
    assistantWithToolCall("vibe_wait", { sessions: ["fast-1", "good-2"] }, "v1"),
    new Map([["v1", toolResult("v1", "vibe_wait", [{ type: "text", text: "<vibe-turn>fast-1 finished\nwrote the parser</vibe-turn>" }], {
      op: "wait",
      screens: [
        { id: "fast-1", cli: "fast", state: "idle", turns: 3, queued: 0, turnMessage: "port the parser" },
        { id: "good-2", cli: "good", state: "running", turns: 1, queued: 1, turnMessage: "review the diff" },
      ],
    })]]),
  );

  assert.match(html, /fast-1/);
  assert.match(html, /good-2/);
  assert.match(html, /3t/);
  assert.match(html, /1t\+1q/);
  assert.match(html, /review the diff/);
  // The prose stays prose: escaped for HTML, but never re-quoted as JSON.
  assert.match(html, /&lt;vibe-turn&gt;fast-1 finished/);
  assert.doesNotMatch(html, /\\n/);
  assert.doesNotMatch(html, /&quot;op&quot;/);
});

test("renders a vibe_spawn result with the spawned session", () => {
  const html = render(
    assistantWithToolCall("vibe_spawn", { cli: "good", prompt: "review" }, "v2"),
    new Map([["v2", toolResult("v2", "vibe_spawn", [{ type: "text", text: "Spawned good-7." }], {
      op: "spawn",
      screens: [{ id: "good-7", cli: "good", state: "starting", turns: 0, queued: 0 }],
      spawned: { id: "good-7", cli: "good", jobId: "job_42" },
    })]]),
  );

  assert.match(html, /spawned/);
  assert.match(html, /good-7/);
  assert.match(html, /Spawned good-7\./);
  assert.doesNotMatch(html, /job_42/);
});

test("renders an async-result custom message as a background result", () => {
  const html = render({
    role: "custom",
    customType: "async-result",
    display: false,
    content: "Agent Scout finished: found 3 call sites.",
    details: { jobs: [{ jobId: "bg_7", label: "scout" }] },
  });

  assert.match(html, /Background result/);
  assert.match(html, /Agent Scout finished: found 3 call sites\./);
  assert.doesNotMatch(html, /jobId/);
  assert.doesNotMatch(html, /bg_7/);
});

test("renders a batch task call as its task names", () => {
  const html = render(
    assistantWithToolCall("task", {
      context: "shared contract",
      tasks: [
        { name: "Docs", agent: "docs", task: "write the changelog\nand the migration note", solutionSpace: "one fix" },
        { name: "Core", task: "fix the loader", solutionSpace: "one fix" },
      ],
    }, "t1"),
  );

  assert.match(html, /Docs/);
  assert.match(html, /docs/);
  assert.match(html, /write the changelog/);
  assert.match(html, /Core/);
  assert.match(html, /fix the loader/);
  assert.match(html, /2 tasks/);
  // Only the first line of each task, and no JSON keys in place of the list.
  assert.doesNotMatch(html, /and the migration note/);
  assert.doesNotMatch(html, /solutionSpace/);
});

test("keeps a flat task call on the generic card", () => {
  const html = render(
    assistantWithToolCall("task", { agent: "scout", task: "map the vibe tools", solutionSpace: "open" }, "t2"),
    new Map([["t2", toolResult("t2", "task", [{ type: "text", text: "scout report" }])]]),
  );

  // The generic path shows the agent preview and no batch summary; a flat call
  // routed through the batch branch would say "1 task" instead.
  assert.match(html, /scout/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /1 task/);
});

test("uses the brief file when a batch task's task text is empty", () => {
  const html = render(
    assistantWithToolCall("task", {
      context: "shared",
      tasks: [{ name: "Scout", task: "", taskFile: "briefs/scout.md", solutionSpace: "open" }],
    }, "t3"),
  );

  assert.match(html, /briefs\/scout\.md/);
});

test("renders images attached to an async result", () => {
  const html = render({
    role: "custom",
    customType: "async-result",
    display: true,
    content: [
      { type: "text", text: "Screenshot of the failure" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ],
    details: { jobs: [] },
  });

  assert.match(html, /Screenshot of the failure/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,AAAA"/);
});

test("drops the system-notice wrapper and renders the body as markdown", () => {
  const html = render({
    role: "custom",
    customType: "async-result",
    display: true,
    content: "<system-notice>\n\n## Job bg_7\n\n```\nhello from the job\n```\n\n</system-notice>",
    details: null,
  });

  assert.doesNotMatch(html, /system-notice/);
  assert.match(html, /Job bg_7/);
  assert.match(html, /hello from the job/);
});

test("surfaces an artifact capture warning from details.jobs", () => {
  const html = render({
    role: "custom",
    customType: "async-result",
    display: true,
    content: "Some output",
    details: { jobs: [{ jobId: "bg_1", meta: { artifactError: "write" } }] },
  });

  assert.match(html, /Full output was not saved completely \(artifact write failed\)/);
});

test("keeps malformed vibe details on a stable card", () => {
  const html = render(
    assistantWithToolCall("vibe_list", {}, "v4"),
    new Map([["v4", toolResult("v4", "vibe_list", null, {
      op: "list",
      screens: [null, 1, "a", [], true, { id: "odd-1", state: "constructor", turns: "3", queued: null }],
      spawned: [],
      hiddenKilled: "abc",
      killed: 7,
    })]]),
  );

  assert.match(html, /vibe_list/);
  assert.match(html, /1 session/);
  assert.match(html, /odd-1/);
  assert.match(html, />constructor</);
  // A prototype lookup would emit a function into the style attribute, and a
  // missing cli must not invent a "fast" badge.
  assert.doesNotMatch(html, /function Object/);
  assert.doesNotMatch(html, />fast</);
  assert.doesNotMatch(html, /undefined/);
});

test("keeps a malformed async result on a stable card", () => {
  const html = render({
    role: "custom",
    customType: "async-result",
    display: false,
    content: null,
    details: null,
  });

  assert.match(html, /Background result/);
});

test("keeps malformed task items on a stable list", () => {
  const html = render(
    assistantWithToolCall("task", {
      context: "shared",
      tasks: [null, 1, "a", [], true, { name: 5, agent: [], task: ["x"], taskFile: {} }],
    }, "t5"),
  );

  // Only the object survives the filter; it has no usable name, so it is
  // numbered and its non-string task/agent/taskFile render as empty.
  assert.match(html, />#1</);
  assert.match(html, /1 task/);
});

test("reveals a pending vibe_spawn input after expanding", async () => {
  const container = await mount(React.createElement(MessageView, {
    message: assistantWithToolCall("vibe_spawn", { cli: "good", prompt: "review the diff of PR 12" }, "v5"),
  }));

  const button = container.querySelector("button[aria-expanded]");
  assert.ok(button, "the card has a disclosure button");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.doesNotMatch(container.innerHTML, /review the diff of PR 12/);

  await act(async () => { button.click(); });

  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.match(container.innerHTML, /review the diff of PR 12/);
});

test("keeps a batch task's raw input reachable when expanded", async () => {
  const container = await mount(React.createElement(MessageView, {
    message: assistantWithToolCall("task", {
      context: "shared contract",
      tasks: [{ name: "Docs", task: "write the changelog", solutionSpace: "one fix" }],
    }, "t6"),
  }));

  // The readable list is the default summary; the raw call survives the expand.
  assert.match(container.innerHTML, /Docs/);
  assert.doesNotMatch(container.innerHTML, /shared contract/);

  const button = container.querySelector("button[aria-expanded]");
  await act(async () => { button.click(); });

  assert.match(container.innerHTML, /shared contract/);
  assert.match(container.innerHTML, /solutionSpace/);
});

/** Sorted style declarations of a card's disclosure chevron. */
function chevronDeclarations(html) {
  const match = html.match(/<svg[^>]*viewBox="0 0 10 10"[^>]*style="([^"]*)"/);
  assert.ok(match, "the card renders a disclosure chevron");
  return match[1].split(";").map((part) => part.trim()).filter(Boolean).sort();
}

test("gives the vibe chevron the same declarations as the generic one", () => {
  const vibe = render(assistantWithToolCall("vibe_spawn", { cli: "good", prompt: "review" }, "v7"));
  const generic = render(assistantWithToolCall("read", { path: "briefs/scout.md" }, "g7"));

  // The rotation is the generic card's inline transition, pinned declaration by
  // declaration so a later edit cannot quietly drop it from one of the cards.
  assert.deepEqual(chevronDeclarations(vibe), ["flex-shrink:0", "transform:none", "transition:transform 0.15s"]);
  assert.deepEqual(chevronDeclarations(vibe), chevronDeclarations(generic));
});
