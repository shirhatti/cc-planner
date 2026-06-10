/**
 * <cc-stats-panel> — session statistics: duration (ticking live), token
 * counts by type and per model, cost, and hydration volume. Updates from
 * streamed session_stats events; the final event carries the SDK's
 * authoritative totals.
 */

const LIVE_STATUSES = ["starting", "running", "awaiting-input", "reviewing"];

export function formatTokens(n) {
  if (n == null) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function formatBytes(n) {
  if (!n) return "0 B";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export class CcStatsPanel extends HTMLElement {
  connectedCallback() {
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
    this.record = null;
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  disconnectedCallback() {
    clearInterval(this.ticker);
  }

  showSession(record) {
    this.record = record;
    this.render();
  }

  /** Keep the duration ticking for a live session between stats events. */
  tick() {
    if (!this.record?.startedAt || !LIVE_STATUSES.includes(this.record.status)) return;
    if (this.record.stats?.final) return;
    this.querySelector(".stat-duration")?.replaceChildren(
      formatDuration(Date.now() - this.record.startedAt),
    );
  }

  render() {
    const record = this.record;
    const stats = record?.stats;
    if (!stats) {
      this.hidden = true;
      return;
    }
    this.hidden = false;

    const live = !stats.final && LIVE_STATUSES.includes(record.status);
    const durationMs = live && record.startedAt ? Date.now() - record.startedAt : stats.durationMs;

    const summary = [
      formatDuration(durationMs),
      `${formatTokens(stats.totals.inputTokens + stats.totals.outputTokens)} tokens`,
    ];
    if (stats.costUsd != null) summary.push(`$${stats.costUsd.toFixed(4)}`);
    if (!stats.final) summary.push("live");
    this.querySelector(".stats-summary").textContent = summary.join(" · ");

    const cells = [
      ["Duration", formatDuration(durationMs), "stat-duration"],
      ...(stats.apiDurationMs != null ? [["API time", formatDuration(stats.apiDurationMs)]] : []),
      ...(stats.numTurns != null ? [["Turns", String(stats.numTurns)]] : []),
      ...(stats.costUsd != null ? [["Cost", `$${stats.costUsd.toFixed(4)}`]] : []),
      ["Input", formatTokens(stats.totals.inputTokens)],
      ["Output", formatTokens(stats.totals.outputTokens)],
      ["Cache read", formatTokens(stats.totals.cacheReadTokens)],
      ["Cache write", formatTokens(stats.totals.cacheCreationTokens)],
      ...(stats.filesHydrated
        ? [["Files hydrated", `${stats.filesHydrated} (${formatBytes(stats.bytesFetched)})`]]
        : []),
    ];

    const grid = this.querySelector(".stats-grid");
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
    const table = this.querySelector(".stats-models");
    table.hidden = models.length === 0;
    const tbody = table.querySelector("tbody");
    tbody.innerHTML = "";
    for (const [model, usage] of models) {
      const row = document.createElement("tr");
      const values = [
        model,
        formatTokens(usage.inputTokens),
        formatTokens(usage.outputTokens),
        formatTokens(usage.cacheReadTokens),
        formatTokens(usage.cacheCreationTokens),
        usage.costUsd != null ? `$${usage.costUsd.toFixed(4)}` : "—",
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
