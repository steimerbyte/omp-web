import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderMessage(message) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message }),
    ),
  );
}

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("renders shell blocks as themed terminal content", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-test",
          content: [{
            type: "toolCall",
            toolCallId: "shell-1",
            toolName: "bash",
            input: { command: "git status --short" },
          }],
        },
        toolResults: new Map([
          ["shell-1", {
            role: "toolResult",
            toolCallId: "shell-1",
            content: [{ type: "text", text: "staged 0, unstaged 1\n M components/MessageView.tsx" }],
          }],
        ]),
      }),
    ),
  );

  assert.match(html, /class="shell-output-preview"/);
  // Das Markup ist die Server-/Erst-Render-Fassung: CodeHighlighterLazy zeigt
  // dort den reinen Block, die Hervorhebung kommt erst mit dem Chunk.
  assert.doesNotMatch(html, /class="token/);
  assert.match(html, />git status --short</);
  assert.match(html, /--short/);
  assert.match(html, /Output/);
  assert.match(html, /components\/MessageView\.tsx/);
});

test("uses i/title in the standard header for grep, read, write, glob, and eval blocks", () => {
  const cases = [
    ["read", "i", "Verifico bridge startSessionReplay e campionamento", { i: "Verifico bridge startSessionReplay e campionamento", path: "lib/main.dart" }, "lib/main.dart"],
    ["grep", "i", "Individuo avvio e stop del session replay", { i: "Individuo avvio e stop del session replay", path: "lib/main.dart" }, "lib/main.dart"],
    ["write", "i", "Individuo simbolo Main dell'app Flutter", { i: "Individuo simbolo Main dell'app Flutter", path: "lib/main.dart" }, "lib/main.dart"],
    ["glob", "i", "Individuo componenti TypeScript", { i: "Individuo componenti TypeScript", path: "components/**/*.tsx" }, "components/**/*.tsx"],
    ["eval", "title", "Valuto il risultato del parser", { title: "Valuto il risultato del parser", code: "return 42" }, "return 42"],
  ];

  for (const [toolName, property, preview, input, fallback] of cases) {
    const html = renderMessage({
      role: "assistant",
      provider: "openai",
      model: "gpt-test",
      content: [{
        type: "toolCall",
        toolCallId: `${toolName}-preview`,
        toolName,
        input,
      }],
    });

    const renderedPreview = preview.replaceAll("'", "&#x27;");
    const previewPosition = html.indexOf(renderedPreview);
    const toolPosition = html.indexOf(`>${toolName}</span>`);
    assert.ok(previewPosition > toolPosition, `expected ${property} from ${toolName} in the standard header`);
    assert.doesNotMatch(html, /class="tool-intent-preview"/);
    assert.ok(!html.includes(fallback), `expected ${toolName} fallback to stay out of the header`);
  }
});

test("shows an operation icon beside every standard tool label", () => {
  const cases = [
    ["read", {}, "read", "var(--accent)", "read"],
    ["write", {}, "write", "var(--warning)", "write"],
    ["glob", {}, "glob", "var(--accent-hover)", "glob"],
    ["grep", {}, "grep", "var(--accent)", "grep"],
    ["edit", {}, "edit", "var(--warning)", "edit"],
    ["eval", {}, "eval", "var(--accent-hover)", "eval"],
    ["functions.task", {}, "task", "var(--accent)", "functions.task"],
    ["unknown_tool", {}, "generic", "var(--text-dim)", "unknown_tool"],
    // MCP tools: native `mcp__<server>_<tool>` names, and the same call made
    // through the `xd://` transport (`write`/`read` with an xd:// path).
    ["mcp__ghidra_mcp_get_functions", {}, "mcp", "var(--violet)", "mcp__ghidra_mcp_get_functions"],
    ["write", { path: "xd://mcp__openrouter_ping", content: "{}" }, "mcp", "var(--violet)", "mcp__openrouter_ping"],
    ["read", { path: "xd://mcp__openrouter_ping" }, "mcp", "var(--violet)", "mcp__openrouter_ping"],
    // A non-MCP device keeps the transport's icon but shows its own name.
    ["write", { path: "xd://sudo_run", content: "{}" }, "write", "var(--warning)", "sudo_run"],
  ];

  for (const [toolName, input, iconKind, themeColor, label] of cases) {
    const html = renderMessage({
      role: "assistant",
      provider: "openai",
      model: "gpt-test",
      content: [{
        type: "toolCall",
        toolCallId: `${toolName}-icon`,
        toolName,
        input,
      }],
    });

    const iconPosition = html.indexOf(`data-tool-icon="${iconKind}"`);
    const iconEnd = html.indexOf(">", iconPosition);
    const toolPosition = html.indexOf(`>${label}</span>`);
    assert.ok(iconPosition >= 0, `expected ${iconKind} icon for ${toolName}`);
    assert.ok(html.slice(iconPosition, iconEnd).includes(`color:${themeColor}`), `expected ${toolName} icon to use ${themeColor}`);
    assert.ok(toolPosition >= 0, `expected ${toolName} to be labelled ${label}`);
    assert.ok(iconPosition < toolPosition, `expected ${iconKind} icon before ${label}`);
  }
});


test("renders every todo task in an integrated checklist", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-test",
          content: [{
            type: "toolCall",
            toolCallId: "todo-1",
            toolName: "todo",
            input: {
              list: [{
                phase: "Implementation",
                items: ["First task", "Second task", "Third task", "Fourth task"],
              }],
            },
          }],
        },
        toolResults: new Map([
          ["todo-1", {
            role: "toolResult",
            toolCallId: "todo-1",
            details: {
              phases: [{
                name: "Implementation",
                tasks: [
                  { content: "First task", status: "completed" },
                  { content: "Second task", status: "completed" },
                  { content: "Third task", status: "in_progress" },
                  { content: "Fourth task", status: "pending" },
                ],
              }],
            },
            content: [],
          }],
        ]),
      }),
    ),
  );

  assert.match(html, /class="todo-checklist-preview"/);
  assert.match(html, /Todo 4 tasks/);
  assert.match(html, /First task/);
  assert.match(html, /Second task/);
  assert.match(html, /Third task/);
  assert.match(html, /Fourth task/);
  assert.doesNotMatch(html, /… 1/);
});

test("renders thinking markdown directly without a collapsible card", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-test",
          content: [{ type: "thinking", thinking: "**Direct thought**" }],
        },
      }),
    ),
  );

  assert.match(html, /class="markdown-thinking"/);
  assert.match(html, /<strong>Direct thought<\/strong>/);
  assert.doesNotMatch(html, /aria-expanded/);
});
