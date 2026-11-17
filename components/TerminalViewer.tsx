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

// A ResizeObserver ticks on every layout change; one POST per tick starved the
// input POSTs in dev (measured: ten resizes per mount).
const RESIZE_DEBOUNCE_MS = 150;
// FitAddon clamps at 2 columns / 1 row, so a panel that is not laid out (or is
// 1 px wide during StrictMode's double mount, measured) fits to that sentinel.
// A terminal below these thresholds is not a measured panel and must not open
// the stream: the replay would be painted into ~2 columns and the later refit
// cannot put the prompt back.
const MIN_READY_COLS = 20;
const MIN_READY_ROWS = 5;
// One hung input POST would block every later keystroke (dev measured 1.0–3.1 s
// per POST, up to 15 s). After this the request is aborted and the chain goes on.
const INPUT_TIMEOUT_MS = 15_000;

/**
 * Ab wann eine gefittete Geometrie ein gemessenes Panel ist.
 *
 * `false` heisst: das ist FitAddons Kleinstwert (2 Spalten / 1 Zeile) oder ein
 * Panel mitten im Layout, kein Terminal, in das man den Verlauf schreiben darf.
 */
export function isMeasuredTerminal(cols: number, rows: number): boolean {
  return cols >= MIN_READY_COLS && rows >= MIN_READY_ROWS;
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
    termRef.current = term;
    fitRef.current = fit;

    // `script(1)` besitzt die PTY-Master-Seite, also kann der Server sie nicht
    // umgroessen (siehe TerminalManager.resize). Das Panel bestimmt trotzdem
    // die Anzeige: fit() auf den Container, dann die gefittete Groesse melden —
    // einmal pro Aenderung, nicht pro Tick.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let sentSize = "";
    const sendResize = (cols: number, rows: number) => {
      const size = `${cols}x${rows}`;
      // Unter der Messgrenze ist die Geometrie xterms Kleinstwert, keine
      // gemessene Panelgroesse — die darf nicht beim Server landen.
      if (cols < MIN_READY_COLS || rows < MIN_READY_ROWS || size === sentSize) return;
      sentSize = size;
      fetch(`/api/terminal/${encodeURIComponent(terminalId)}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => undefined);
    };

    // Jeder Tastendruck war ein eigener POST; ohne Reihenfolge kam
    // "echo verify" bei 250 ms pro Zeichen als "yehco veirfy" an (gemessen).
    // Die Bytes sind ein Strom, also wird auch so gesendet: genau ein POST
    // gleichzeitig, der naechste erst nach seiner Antwort. Ein Fehler bricht
    // die Kette nicht ab — sonst ginge jedes spaetere Zeichen still verloren —
    // und wird nur einmal gemeldet, weil eine tote Verbindung sonst pro
    // Zeichen eine Zeile schriebe.
    let inputChain = Promise.resolve();
    let inputFailed = false;
    const sendInput = (data: string) => {
      inputChain = inputChain.then(async () => {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), INPUT_TIMEOUT_MS);
        try {
          const response = await fetch(`/api/terminal/${encodeURIComponent(terminalId)}/input`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data }),
            signal: abort.signal,
          });
          if (!response.ok) throw new Error(`input POST answered ${response.status}`);
        } catch (error) {
          if (!inputFailed) {
            inputFailed = true;
            console.warn("[terminal] input POST failed; later keystrokes are still sent", error);
          }
        } finally {
          clearTimeout(timer);
        }
      });
    };
    const inputDisposable = term.onData((data) => sendInput(data));

    let eventSource: EventSource | null = null;
    const connect = () => {
      if (eventSource) return;
      const es = new EventSource(`/api/terminal/${encodeURIComponent(terminalId)}/stream`);
      eventSource = es;
      esRef.current = es;

      es.addEventListener("connected", (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data) as ConnectedEvent;
          // Der Server schickt den Verlauf, bevor live weiterfliesst (siehe
          // TerminalManager.attach). Ein Reconnect bekaeme ihn sonst ein zweites
          // Mal auf den alten Bildschirm — also beginnt der Bildschirm leer und
          // der Verlauf ist die einzige Quelle.
          term.reset();
          fitIfMeasured();
          // Der Spawn hat die PTY schon auf diese Groesse gesetzt (stty in
          // TerminalManager.spawn); nur eine Abweichung ist ein POST wert.
          sentSize = `${payload.cols}x${payload.rows}`;
          sendResize(term.cols, term.rows);
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

      // Die Exit-Zeile schreibt bereits der Manager in den Byte-Strom; ein
      // zweites `term.write` hier haette sie doppelt gezeigt.
      const handleExit = () => {
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
    };

    // Erst den Vorschlag pruefen, dann fitten: `fit()` selbst ruft
    // `term.resize()` mit FitAddons `Math.max(2, …)`, sobald das Panel noch
    // keine Breite hat (1-px-Panel aus StrictModes doppeltem Mount, gemessen).
    // Ein solcher Resize zerlegt eine bereits gezeichnete Zeile im Puffer —
    // gemessen `[s` statt des 31 Zeichen langen Prompts, und ein spaeterer
    // Refit holt sie nicht zurueck (gemessen: 62 -> 61 Spalten togglen
    // korrumpiert die Zeile; ein Reattach malt sie neu). Also wird unterhalb
    // der Messgrenze gar nicht gefittet und nicht verbunden; der
    // ResizeObserver kommt wieder, sobald das Layout steht.
    const fitIfMeasured = () => {
      const proposal = fit.proposeDimensions();
      if (!proposal || !isMeasuredTerminal(proposal.cols, proposal.rows)) return false;
      fit.fit();
      // Der Strom oeffnet erst, wenn die Geometrie wirklich am Terminal steht
      // — in diese Spalten wird der Verlauf geschrieben.
      return isMeasuredTerminal(term.cols, term.rows);
    };

    const resizeObserver = new ResizeObserver(() => {
      if (fitIfMeasured()) connect();
      clearTimeout(resizeTimer ?? undefined);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        sendResize(term.cols, term.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    if (fitIfMeasured()) connect();
    resizeObserver.observe(containerRef.current);

    return () => {
      clearTimeout(resizeTimer ?? undefined);
      inputDisposable.dispose();
      resizeObserver.disconnect();
      eventSource?.close();
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
