/**
 * Bandwidth summary for a lazy workspace: what the session downloaded
 * (blob-less clone + hydrated files) versus what a full clone would need.
 *
 * A full clone downloads at least the same commits and trees plus every
 * file at the planned commit — and in practice every historical version of
 * every file too — so "saved" is a lower bound.
 */

import type { SessionStats } from "./protocol";

export interface BandwidthSummary {
  filesHydrated: number;
  totalFiles?: number;
  bytesFetched: number;
  totalBytes?: number;
  /** Clone metadata + hydrated content, when the clone size is known. */
  downloadedBytes?: number;
  /** Lower bound on a full clone: clone metadata + all files at the commit. */
  fullCloneBytes?: number;
  /** Lower bound on bytes not downloaded thanks to lazy hydration. */
  savedBytes?: number;
  /** savedBytes as a fraction of fullCloneBytes (0–1). */
  savedFraction?: number;
}

export function bandwidthSummary(
  stats: Pick<SessionStats, "filesHydrated" | "bytesFetched" | "workspace">,
): BandwidthSummary | undefined {
  const ws = stats.workspace;
  if (!ws) return undefined;
  const summary: BandwidthSummary = {
    filesHydrated: stats.filesHydrated,
    totalFiles: ws.totalFiles,
    bytesFetched: stats.bytesFetched,
    totalBytes: ws.totalBytes,
  };
  if (ws.cloneBytes != null) summary.downloadedBytes = ws.cloneBytes + stats.bytesFetched;
  if (ws.cloneBytes != null && ws.totalBytes != null) {
    summary.fullCloneBytes = ws.cloneBytes + ws.totalBytes;
    summary.savedBytes = Math.max(0, ws.totalBytes - stats.bytesFetched);
    summary.savedFraction =
      summary.fullCloneBytes > 0 ? summary.savedBytes / summary.fullCloneBytes : 0;
  }
  return summary;
}
