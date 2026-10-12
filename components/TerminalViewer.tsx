"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "@/hooks/useTheme";
import { Enter } from "./motion/Enter";
import { Shimmer } from "./motion/Shimmer";

interface Props {
  terminalId: string;
  onExit?: () => void;
}

interface ConnectedEvent {
  cols: number;
  rows: number;
  cwd: string;
}

// Minimal JSON codec: the server emits output as a base64-ish array of byte
// values (see app/api/terminal/[id]/stream/route.ts) so we do not have to
// worry about control characters splitting the SSE payload.
function decodeOutput(arr: number[]): string {
  const bytes = Uint8Array.from(arr);
  return new TextDecoder("utf-8").decode(bytes);
}

export function TerminalViewer({ terminalId, onExit }: Props) {
  const { isDark } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const [status, setStatus] = useState<"connecting" | "running" | "exited" | "error">("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Mirrors `status` for the `es.onerror` handler below, which needs the
  // current value but must not be a reason to tear the terminal down. Reading
  // state directly inside a long-lived listener would need `status` in the
  // dependency list, and that would dispose and rebuild the whole xterm
  // instance on every connecting → running → exited transition, wiping the
  // scrollback each time. The ref is written wherever the state is set.
  const statusRef = useRef(status);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      fontFamily: '"JetBrainsMono NF", "JetBrainsMono Nerd Font", "JetBrains Mono NL", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      cursorBlink: true,
      convertEol: false,
      allowProposedApi: true,
      scrollback: 5000,
      theme: isDark
        ? {
            background: "#1e1e1e",
            foreground: "#d4d4d4",
            cursor: "#d4d4d4",
            cursorAccent: "#1e1e1e",
            selectionBackground: "rgba(38, 79, 120, 0.5)",
          }
        : {
            background: "#ffffff",
            foreground: "#1f2328",
            cursor: "#1f2328",
            cursorAccent: "#ffffff",
            selectionBackground: "rgba(38, 79, 120, 0.3)",
          },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Resize observer keeps the PTY cols/rows in sync with the panel size.
    const sendResize = () => {
      const cols = term.cols;
      const rows = term.rows;
      if (cols > 0 && rows > 0) {
        fetch(`/api/terminal/${encodeURIComponent(terminalId)}/resize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cols, rows }),
        }).catch(() => undefined);
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // xterm throws if the container has zero size during teardown.
      }
      sendResize();
    });
    resizeObserver.observe(containerRef.current);

    const sendInput = (data: string) => {
      fetch(`/api/terminal/${encodeURIComponent(terminalId)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      }).catch(() => undefined);
    };
    const inputDisposable = term.onData((data) => sendInput(data));

    const url = `/api/terminal/${encodeURIComponent(terminalId)}/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("connected", (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as ConnectedEvent;
        term.resize(payload.cols, payload.rows);
      } catch {
        // ignore
      }
      setStatus("running");
    });

    es.addEventListener("output", (event: MessageEvent) => {
      try {
        const arr = JSON.parse(event.data) as number[];
        term.write(decodeOutput(arr));
      } catch {
        // ignore malformed chunks
      }
    });

    const handleExit = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { exitCode: number };
        term.write(`\r\n\x1b[2m[Process exited with code ${payload.exitCode}]\x1b[0m\r\n`);
      } catch {
        term.write("\r\n\x1b[2m[Process exited]\x1b[0m\r\n");
      }
      setStatus("exited");
      onExit?.();
    };
    es.addEventListener("exit", handleExit);

    es.onerror = () => {
      // EventSource reconnects automatically on transient errors. If the
      // server explicitly closed the stream (terminal killed) the readyState
      // is CLOSED and we should surface that.
      if (es.readyState === EventSource.CLOSED) {
        if (statusRef.current === "running") {
          setStatus("error");
          setErrorMessage("Stream closed by server");
        }
      }
    };

    return () => {
      inputDisposable.dispose();
      resizeObserver.disconnect();
      es.close();
      esRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [terminalId, isDark, onExit]);

  // Keep the ref in step with the state without pulling `status` back into the
  // effect above. Runs after every render, which is what makes the ref current
  // by the time the next `es.onerror` fires.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  return (
    <Enter direction="down" style={{ position: "relative", height: "100%", width: "100%", display: "flex", flexDirection: "column", background: isDark ? "#1e1e1e" : "#ffffff" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "6px 12px",
          borderBottom: `1px solid ${isDark ? "#333" : "#e5e7eb"}`,
          fontSize: 12,
          fontFamily: '"JetBrainsMono NF", "JetBrainsMono Nerd Font", ui-monospace, monospace',
          color: isDark ? "#a1a1aa" : "#525252",
          flexShrink: 0,
          background: isDark ? "#18181b" : "#fafafa",
        }}
      >
        <span
          aria-label={status}
          title={status}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: status === "running" ? "var(--success)" : status === "exited" ? "var(--text-dim)" : "var(--warning)",
            boxShadow: status === "running" ? "0 0 4px var(--success)" : "none",
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {status === "connecting" ? "Connecting…" : status === "exited" ? "Process exited" : terminalId}
        </span>
        <span style={{ color: isDark ? "#71717a" : "#a3a3a3" }}>type a command and press Enter</span>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, padding: 8, position: "relative" }} />
      {/* The status badge is shown for every state that is not a live
       * terminal, but only `connecting` is actually a wait. `exited` and
       * `error` are final: the process is gone or the stream failed, and
       * neither will change again. Washing them was the same visible defect as
       * a stuck shimmer — a lilac band looping on a panel that has nothing
       * left to wait for — reached through a different door, so it survives a
       * fix that only makes the shimmer well-behaved. `Shimmer` applies no wash
       * at all when animations are off, which is exactly what a finished badge
       * wants, so the non-waiting states use a plain `div`. */}
      {(status === "connecting" || status === "error" || status === "exited") && (
        (status === "connecting" ? (
          <Shimmer
            radius={999}
            style={{
              position: "absolute",
              bottom: 12,
              right: 12,
              fontSize: 11,
              padding: "2px 8px",
              backgroundColor: "rgba(120, 120, 120, 0.2)",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            connecting…
          </Shimmer>
        ) : (
          <div
            style={{
              position: "absolute",
              bottom: 12,
              right: 12,
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 999,
              backgroundColor: status === "error" ? "rgba(239, 68, 68, 0.2)" : "rgba(120, 120, 120, 0.2)",
              color: status === "error" ? "var(--danger)" : "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            {status === "exited" ? "exited" : errorMessage ?? "error"}
          </div>
        ))
      )}
    </Enter>
  );
}
