/**
 * Session statistics: duration (ticking live), token counts by type and per
 * model, estimated cost (public token pricing), and for lazy workspaces the
 * bandwidth used versus a full clone.
 */

import { useEffect, useState } from "react";
import { bandwidthSummary } from "../../lib/bandwidth";
import { formatBytes, formatDuration, formatTokens, percent } from "../format";
import { LIVE_STATUSES, type SessionRecord } from "../store";

/** Stats cells for a lazy workspace's bandwidth. */
function bandwidthCells(b: NonNullable<ReturnType<typeof bandwidthSummary>>): [string, string][] {
  const cells: [string, string][] = [
    [
      "Files hydrated",
      b.totalFiles
        ? `${b.filesHydrated} of ${b.totalFiles.toLocaleString()} (${percent(b.filesHydrated / b.totalFiles)})`
        : String(b.filesHydrated),
    ],
    [
      "Content fetched",
      b.totalBytes != null
        ? `${formatBytes(b.bytesFetched)} of ${formatBytes(b.totalBytes)}`
        : formatBytes(b.bytesFetched),
    ],
  ];
  if (b.downloadedBytes != null) cells.push(["Downloaded (total)", formatBytes(b.downloadedBytes)]);
  if (b.fullCloneBytes != null)
    cells.push(["Full clone (at least)", formatBytes(b.fullCloneBytes)]);
  if (b.savedBytes != null && b.savedFraction != null) {
    cells.push(["Saved (at least)", `${formatBytes(b.savedBytes)} (${percent(b.savedFraction)})`]);
  }
  return cells;
}

/** Re-render every second while `active`, returning the current time. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, [active]);
  return now;
}

export function StatsPanel({ record }: { record: SessionRecord }) {
  const stats = record.stats;
  const live = Boolean(stats && !stats.final && LIVE_STATUSES.includes(record.status));
  const now = useNow(live);
  if (!stats) return null;

  const durationMs = live && record.startedAt ? now - record.startedAt : stats.durationMs;
  const cost = (value: number): string => `${stats.estimated ? "~" : ""}$${value.toFixed(4)}`;
  // All tokens processed, cached ones included — uncached input alone is
  // tiny once the prompt cache is warm.
  const t = stats.totals;
  const allTokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;
  const bandwidth = bandwidthSummary(stats);
  const summary = [formatDuration(durationMs), `${formatTokens(allTokens)} tokens`];
  if (stats.costUsd != null) summary.push(cost(stats.costUsd));
  if (bandwidth?.downloadedBytes != null) {
    summary.push(`${formatBytes(bandwidth.downloadedBytes)} downloaded`);
  }
  if (!stats.final) summary.push("live");

  const cells: [string, string][] = [
    ["Duration", formatDuration(durationMs)],
    ...(stats.apiDurationMs != null
      ? ([["API time", formatDuration(stats.apiDurationMs)]] as [string, string][])
      : []),
    ...(stats.numTurns != null ? ([["Turns", String(stats.numTurns)]] as [string, string][]) : []),
    ...(stats.costUsd != null
      ? ([[stats.estimated ? "Cost (est.)" : "Cost", cost(stats.costUsd)]] as [string, string][])
      : []),
    ["Input", formatTokens(t.inputTokens)],
    ["Output", formatTokens(t.outputTokens)],
    ["Cache read", formatTokens(t.cacheReadTokens)],
    ["Cache write", formatTokens(t.cacheCreationTokens)],
    ...(bandwidth
      ? bandwidthCells(bandwidth)
      : stats.filesHydrated
        ? ([["Files hydrated", `${stats.filesHydrated} (${formatBytes(stats.bytesFetched)})`]] as [
            string,
            string,
          ][])
        : []),
  ];
  const models = Object.entries(stats.byModel);

  return (
    <details className="border-border group border-t">
      <summary className="hover:bg-panel flex cursor-pointer items-baseline gap-2 px-4 py-2.5">
        <span className="font-semibold">Session stats</span>
        <span className="text-muted truncate text-xs">{summary.join(" · ")}</span>
      </summary>
      <div className="max-h-80 space-y-3 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-2 gap-2">
          {cells.map(([label, value]) => (
            <div key={label} className="bg-panel rounded-md px-2.5 py-1.5">
              <div className="text-muted text-[11px]">{label}</div>
              <div className="font-mono text-xs">{value}</div>
            </div>
          ))}
        </div>
        {models.length > 0 && (
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="text-muted">
              <tr>
                {["Model", "Input", "Output", "Cache read", "Cache write", "Cost"].map((h) => (
                  <th key={h} className="pr-2 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {models.map(([model, usage]) => (
                <tr key={model}>
                  <td className="pr-2">{model}</td>
                  <td className="pr-2">{formatTokens(usage.inputTokens)}</td>
                  <td className="pr-2">{formatTokens(usage.outputTokens)}</td>
                  <td className="pr-2">{formatTokens(usage.cacheReadTokens)}</td>
                  <td className="pr-2">{formatTokens(usage.cacheCreationTokens)}</td>
                  <td>{usage.costUsd != null ? cost(usage.costUsd) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}
