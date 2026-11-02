"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { STATS_RANGE_OPTIONS, useStats, type StatsRange } from "@/hooks/useStats";
import { formatTokenCount } from "@/lib/format-tokens";
import { getFileName } from "@/lib/file-paths";
import { formatRelativeTime } from "@/lib/i18n/format";
import type {
  AggregatedStats,
  FolderStats,
  ModelStats,
  TimeSeriesPoint,
  ToolUsageStats,
} from "@oh-my-pi/omp-stats";

/**
 * Die Statistik-Seite.
 *
 * Sie liest `GET /api/stats?range=` und sonst nichts. Die Route ist die einzige
 * Wahrheit: sie antwortet admin-only, sie sagt, ob ein Sync läuft, und sie
 * liefert den letzten indizierten Stand. Diese Komponente formatiert ihn nur —
 * keine eigene Aggregation, keine zweite Zählung.
 *
 * Alle Farben kommen aus den CSS-Variablen; das Balkendiagramm ist handgemachtes
 * SVG, weil eine Diagrammbibliothek für zwei Balken je Zeitfenster zu viel
 * Abhängigkeit wäre.
 */

/** Der Schlüssel je Zeitfenster; die Reihenfolge ist die der Schaltflächen. */
const RANGE_LABEL_KEYS: Record<StatsRange, string> = {
  "24h": "stats.range24h",
  "7d": "stats.range7d",
  "30d": "stats.range30d",
  "90d": "stats.range90d",
};

/** Ein Betrag, wie die Sitzungsleiste ihn zeigt: klein ist nicht null. */
function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

/** Raten kommen als 0–1 aus der Datenbank. */
function formatPercent(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/** Millisekunden: unter einer Sekunde in ms, darüber in s. */
function formatMilliseconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/** `avgTokensPerSecond` ist bereits eine Rate; keine Umrechnung hier. */
function formatThroughput(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(1);
}

function kpiValues(stats: AggregatedStats, locale: string) {
  return [
    { key: "stats.kpiRequests", value: stats.totalRequests.toLocaleString(locale) },
    { key: "stats.kpiCost", value: formatCost(stats.totalCost) },
    { key: "stats.kpiInputTokens", value: formatTokenCount(stats.totalInputTokens) },
    { key: "stats.kpiOutputTokens", value: formatTokenCount(stats.totalOutputTokens) },
    { key: "stats.kpiCacheRate", value: formatPercent(stats.cacheRate) },
    { key: "stats.kpiErrorRate", value: formatPercent(stats.errorRate) },
    { key: "stats.kpiLatency", value: formatMilliseconds(stats.avgDuration) },
    { key: "stats.kpiTtft", value: formatMilliseconds(stats.avgTtft) },
    { key: "stats.kpiThroughput", value: formatThroughput(stats.avgTokensPerSecond) },
  ];
}

const headerCell: CSSProperties = {
  padding: "7px 10px",
  textAlign: "left",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
  whiteSpace: "nowrap",
};

const bodyCell: CSSProperties = {
  padding: "7px 10px",
  fontSize: 12,
  color: "var(--text)",
  borderTop: "1px solid var(--border)",
  whiteSpace: "nowrap",
};

const numericCell: CSSProperties = {
  ...bodyCell,
  textAlign: "right",
  fontFamily: "var(--font-mono)",
};

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "9px 12px",
        border: "1px solid var(--border)",
        borderRadius: 9,
        background: "var(--bg-panel)",
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 18,
          fontWeight: 600,
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 18, minWidth: 0 }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{title}</h2>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 9,
          background: "var(--bg-panel)",
          overflow: "auto",
          maxHeight: 320,
        }}
      >
        {children}
      </div>
    </section>
  );
}

function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ ...bodyCell, color: "var(--text-muted)", fontStyle: "italic" }}>
        {label}
      </td>
    </tr>
  );
}

/**
 * Zwei Balken je Zeitfenster: Token links, Kosten rechts.
 *
 * Die Reihen haben getrennte Maßstäbe (`max` je Reihe), weil ein Token-Balken
 * und ein Kosten-Balken sonst nur den jeweils größeren zeigen würden. Was der
 * Maßstab ist, steht in der Legende — und die Balken tragen ihren Wert im
 * `<title>`.
 */
function TimeSeriesChart({
  series,
  locale,
  t,
}: {
  series: TimeSeriesPoint[];
  locale: string;
  t: (key: string) => string;
}) {
  if (series.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
        {t("stats.chartEmpty")}
      </div>
    );
  }

  const height = 132;
  const baseline = height - 8;
  const plot = height - 22;
  const width = Math.max(320, series.length * 18);
  const slot = width / series.length;
  const barWidth = Math.max(3, Math.min(9, slot * 0.28));
  const gap = 2;
  const maxTokens = Math.max(1, ...series.map((point) => point.tokens));
  const maxCost = Math.max(Number.EPSILON, ...series.map((point) => point.cost));
  const formatTick = (timestamp: number) =>
    new Date(timestamp).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <svg
          role="img"
          aria-label={t("stats.chartAria")}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ display: "block" }}
        >
          <title>{t("stats.chartTitle")}</title>
          {series.map((point, index) => {
            const x = index * slot + 2;
            const tokenHeight = (point.tokens / maxTokens) * plot;
            const costHeight = (point.cost / maxCost) * plot;
            const bucket = formatTick(point.timestamp);
            return (
              <g key={point.timestamp}>
                <rect
                  x={x}
                  y={baseline - tokenHeight}
                  width={barWidth}
                  height={tokenHeight}
                  rx={1}
                  fill="var(--accent)"
                >
                  <title>{`${bucket} · ${t("stats.chartTokens")}: ${point.tokens.toLocaleString(locale)}`}</title>
                </rect>
                <rect
                  x={x + barWidth + gap}
                  y={baseline - costHeight}
                  width={barWidth}
                  height={costHeight}
                  rx={1}
                  fill="var(--success)"
                >
                  <title>{`${bucket} · ${t("stats.chartCost")}: ${formatCost(point.cost)}`}</title>
                </rect>
              </g>
            );
          })}
        </svg>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          padding: "6px 12px 10px",
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: "var(--accent)" }} />
          {t("stats.chartTokens")}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: "var(--success)" }} />
          {t("stats.chartCost")}
        </span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)" }}>
          {formatTick(series[0].timestamp)} – {formatTick(series[series.length - 1].timestamp)}
        </span>
      </div>
    </div>
  );
}

function CenteredState({
  state,
  title,
  body,
  action,
}: {
  state: "loading" | "syncing" | "error" | "empty" | "forbidden";
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      data-state={state}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: 32,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{title}</div>
      {body ? (
        <div style={{ maxWidth: 460, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {body}
        </div>
      ) : null}
      {action}
    </div>
  );
}

export function StatsView() {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<StatsRange>("24h");
  const { payload, stats, tools, loading, forbidden, error, syncing, refresh } = useStats(range);
  const syncError = payload?.error ?? null;
  const failed = error !== null || syncError !== null;

  const retry = (
    <button
      type="button"
      onClick={refresh}
      style={{
        marginTop: 4,
        padding: "6px 12px",
        fontSize: 12,
        fontFamily: "inherit",
        color: "var(--text)",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        cursor: "pointer",
      }}
    >
      {t("stats.retry")}
    </button>
  );

  const rangeControl = (
    <div
      role="group"
      aria-label={t("stats.rangeLabel")}
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {STATS_RANGE_OPTIONS.map((option) => {
        const active = option === range;
        return (
          <button
            key={option}
            type="button"
            data-range={option}
            aria-pressed={active}
            onClick={() => setRange(option)}
            style={{
              padding: "5px 10px",
              fontSize: 12,
              fontFamily: "inherit",
              border: "none",
              cursor: "pointer",
              background: active ? "var(--bg-selected)" : "transparent",
              color: active ? "var(--text)" : "var(--text-muted)",
            }}
          >
            {t(RANGE_LABEL_KEYS[option])}
          </button>
        );
      })}
    </div>
  );

  let content: ReactNode;
  if (forbidden) {
    content = (
      <CenteredState
        state="forbidden"
        title={t("stats.forbiddenTitle")}
        body={t("stats.forbiddenBody")}
      />
    );
  } else if (payload === null && loading) {
    content = <CenteredState state="loading" title={t("stats.loading")} />;
  } else if (payload === null) {
    content = (
      <CenteredState
        state="error"
        title={t("stats.errorTitle")}
        body={error ?? undefined}
        action={retry}
      />
    );
  } else if (stats === null && syncing) {
    content = (
      <CenteredState
        state="syncing"
        title={t("stats.syncTitle")}
        body={t("stats.syncBody")}
        action={retry}
      />
    );
  } else if (stats === null && failed) {
    content = (
      <CenteredState
        state="error"
        title={t("stats.errorTitle")}
        body={syncError ?? error ?? undefined}
        action={retry}
      />
    );
  } else if (payload.totalMessages === 0 || stats === null) {
    content = (
      <CenteredState
        state="empty"
        title={t("stats.emptyTitle")}
        body={t("stats.emptyBody")}
      />
    );
  } else {
    const overall = stats.overall;
    content = (
      <>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 8,
          }}
        >
          {kpiValues(overall, locale).map((kpi) => (
            <Kpi key={kpi.key} label={t(kpi.key)} value={kpi.value} />
          ))}
        </div>

        <Section title={t("stats.chartTitle")}>
          <TimeSeriesChart series={stats.timeSeries} locale={locale} t={t} />
        </Section>

        <Section title={t("stats.modelsTitle")}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headerCell}>{t("stats.colModel")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colRequests")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colErrors")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colInput")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colOutput")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colCost")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colThroughput")}</th>
              </tr>
            </thead>
            <tbody>
              {stats.byModel.length === 0 ? (
                <EmptyRow colSpan={7} label={t("stats.noRows")} />
              ) : (
                stats.byModel.map((model: ModelStats) => (
                  <tr key={`${model.provider}/${model.model}`}>
                    <td style={bodyCell}>
                      {model.model}{" "}
                      <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{model.provider}</span>
                    </td>
                    <td style={numericCell}>{model.totalRequests.toLocaleString(locale)}</td>
                    <td style={numericCell}>{model.failedRequests.toLocaleString(locale)}</td>
                    <td style={numericCell}>{formatTokenCount(model.totalInputTokens)}</td>
                    <td style={numericCell}>{formatTokenCount(model.totalOutputTokens)}</td>
                    <td style={numericCell}>{formatCost(model.totalCost)}</td>
                    <td style={numericCell}>{formatThroughput(model.avgTokensPerSecond)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Section>

        <Section title={t("stats.projectsTitle")}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headerCell}>{t("stats.colProject")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colRequests")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colInput")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colOutput")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colCost")}</th>
              </tr>
            </thead>
            <tbody>
              {stats.byFolder.length === 0 ? (
                <EmptyRow colSpan={5} label={t("stats.noRows")} />
              ) : (
                stats.byFolder.map((folder: FolderStats) => (
                  <tr key={folder.folder}>
                    <td style={bodyCell} title={folder.folder}>
                      {getFileName(folder.folder) || folder.folder}
                    </td>
                    <td style={numericCell}>{folder.totalRequests.toLocaleString(locale)}</td>
                    <td style={numericCell}>{formatTokenCount(folder.totalInputTokens)}</td>
                    <td style={numericCell}>{formatTokenCount(folder.totalOutputTokens)}</td>
                    <td style={numericCell}>{formatCost(folder.totalCost)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Section>

        <Section title={t("stats.toolsTitle")}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headerCell}>{t("stats.colTool")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colCalls")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colErrors")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.chartTokens")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colCost")}</th>
                <th style={{ ...headerCell, textAlign: "right" }}>{t("stats.colLastUsed")}</th>
              </tr>
            </thead>
            <tbody>
              {(tools?.byTool ?? []).length === 0 ? (
                <EmptyRow colSpan={6} label={t("stats.noRows")} />
              ) : (
                (tools?.byTool ?? []).map((tool: ToolUsageStats) => (
                  <tr key={tool.tool}>
                    <td style={bodyCell}>{tool.tool}</td>
                    <td style={numericCell}>{tool.calls.toLocaleString(locale)}</td>
                    <td style={numericCell}>{tool.errors.toLocaleString(locale)}</td>
                    <td style={numericCell}>{formatTokenCount(tool.totalTokensShare)}</td>
                    <td style={numericCell}>{formatCost(tool.costShare)}</td>
                    <td style={numericCell}>{formatRelativeTime(new Date(tool.lastUsed), locale)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Section>
      </>
    );
  }

  return (
    <div
      data-stats-view
      style={{
        height: "100%",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "20px 24px 0",
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 650, color: "var(--text)" }}>
            {t("stats.title")}
          </h1>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("stats.subtitle")}</span>
        </div>
        <div style={{ flex: 1 }} />
        {syncing ? (
          <span
            role="status"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "var(--warning)",
              whiteSpace: "nowrap",
            }}
          >
            <span
              aria-hidden
              style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--warning)" }}
            />
            {t("stats.syncing")}
          </span>
        ) : null}
        {rangeControl}
      </header>

      {failed && stats !== null ? (
        <div
          role="alert"
          style={{
            margin: "12px 24px 0",
            padding: "8px 12px",
            fontSize: 12,
            color: "var(--danger)",
            border: "1px solid var(--danger)",
            borderRadius: 8,
            background: "var(--bg-panel)",
          }}
        >
          {t("stats.syncErrorTitle")}
          {syncError ?? error ? <span style={{ color: "var(--text-muted)" }}> — {syncError ?? error}</span> : null}
        </div>
      ) : null}

      <div style={{ padding: "12px 24px 24px", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        {content}
      </div>
    </div>
  );
}
