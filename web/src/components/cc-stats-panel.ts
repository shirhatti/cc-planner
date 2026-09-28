/**
 * <cc-stats-panel> — session statistics: duration (ticking live), token
 * counts by type and per model, estimated cost (public token pricing), and
 * for lazy workspaces the bandwidth used versus a full clone.
 */

import { bandwidthSummary } from "../../lib/bandwidth";
import { LIVE_STATUSES, type SessionRecord } from "../store";

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function percent(fraction: number): string {
  const pct = fraction * 100;
  return pct > 0 && pct < 0.1 ? "<0.1%" : `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

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

export class CcStatsPanel extends HTMLElement {
  private record: SessionRecord | null = null;
  private ticker?: ReturnType<typeof setInterval>;

  connectedCallback(): void {
    this.innerHTML = `
      <details class="stats-panel">
        <summary>
          <span class="stats-title">Session stats</span>
          <span class="stats-summary muted"></span>
        </summary>
        <div class="stats-grid"></div>
        <table class="stats-models">
          <thead>
            <tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Cost</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </details>`;
    this.hidden = true;
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  disconnectedCallback(): void {
    clearInterval(this.ticker);
  }

  showSession(record: SessionRecord | undefined): void {
    this.record = record ?? null;
    this.render();
  }

  /** Keep the duration ticking for a live session between stats events. */
  private tick(): void {
    const record = this.record;
    if (!record?.startedAt || !LIVE_STATUSES.includes(record.status)) return;
    if (record.stats?.final) return;
    this.querySelector(".stat-duration")?.replaceChildren(
      formatDuration(Date.now() - record.startedAt),
    );
  }

  private render(): void {
    const record = this.record;
    const stats = record?.stats;
    if (!record || !stats) {
      this.hidden = true;
      return;
    }
    this.hidden = false;

    const live = !stats.final && LIVE_STATUSES.includes(record.status);
    const durationMs = live && record.startedAt ? Date.now() - record.startedAt : stats.durationMs;

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
    this.querySelector(".stats-summary")!.textContent = summary.join(" · ");

    const cells: [string, string, string?][] = [
      ["Duration", formatDuration(durationMs), "stat-duration"],
      ...(stats.apiDurationMs != null
        ? ([["API time", formatDuration(stats.apiDurationMs)]] as [string, string][])
        : []),
      ...(stats.numTurns != null
        ? ([["Turns", String(stats.numTurns)]] as [string, string][])
        : []),
      ...(stats.costUsd != null
        ? ([[stats.estimated ? "Cost (est.)" : "Cost", cost(stats.costUsd)]] as [string, string][])
        : []),
      ["Input", formatTokens(stats.totals.inputTokens)],
      ["Output", formatTokens(stats.totals.outputTokens)],
      ["Cache read", formatTokens(stats.totals.cacheReadTokens)],
      ["Cache write", formatTokens(stats.totals.cacheCreationTokens)],
      ...(bandwidth
        ? bandwidthCells(bandwidth)
        : stats.filesHydrated
          ? ([
              ["Files hydrated", `${stats.filesHydrated} (${formatBytes(stats.bytesFetched)})`],
            ] as [string, string][])
          : []),
    ];

    const grid = this.querySelector(".stats-grid")!;
    grid.innerHTML = "";
    for (const [label, value, cls] of cells) {
      const cell = document.createElement("div");
      cell.className = "stat";
      const labelEl = document.createElement("span");
      labelEl.className = "stat-label muted";
      labelEl.textContent = label;
      const valueEl = document.createElement("span");
      valueEl.className = `stat-value${cls ? ` ${cls}` : ""}`;
      valueEl.textContent = value;
      cell.append(labelEl, valueEl);
      grid.append(cell);
    }

    const models = Object.entries(stats.byModel);
    const table = this.querySelector<HTMLTableElement>(".stats-models")!;
    table.hidden = models.length === 0;
    const tbody = table.querySelector("tbody")!;
    tbody.innerHTML = "";
    for (const [model, usage] of models) {
      const row = document.createElement("tr");
      const values = [
        model,
        formatTokens(usage.inputTokens),
        formatTokens(usage.outputTokens),
        formatTokens(usage.cacheReadTokens),
        formatTokens(usage.cacheCreationTokens),
        usage.costUsd != null ? cost(usage.costUsd) : "—",
      ];
      for (const value of values) {
        const td = document.createElement("td");
        td.textContent = value;
        row.append(td);
      }
      tbody.append(row);
    }
  }
}

customElements.define("cc-stats-panel", CcStatsPanel);

declare global {
  interface HTMLElementTagNameMap {
    "cc-stats-panel": CcStatsPanel;
  }
}
