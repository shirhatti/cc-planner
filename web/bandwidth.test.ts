import { describe, expect, test } from "bun:test";
import { bandwidthSummary } from "./lib/bandwidth";

describe("bandwidthSummary", () => {
  test("full checkouts have no bandwidth summary", () => {
    expect(bandwidthSummary({ filesHydrated: 0, bytesFetched: 0 })).toBeUndefined();
  });

  test("compares downloads with a full clone's lower bound", () => {
    const summary = bandwidthSummary({
      filesHydrated: 8,
      bytesFetched: 200_000,
      workspace: { totalFiles: 17_636, totalBytes: 150_000_000, cloneBytes: 50_000_000 },
    });
    expect(summary).toEqual({
      filesHydrated: 8,
      totalFiles: 17_636,
      bytesFetched: 200_000,
      totalBytes: 150_000_000,
      downloadedBytes: 50_200_000,
      fullCloneBytes: 200_000_000,
      savedBytes: 149_800_000,
      savedFraction: 0.749,
    });
  });

  test("omits comparisons whose inputs are unknown", () => {
    const summary = bandwidthSummary({
      filesHydrated: 3,
      bytesFetched: 1_000,
      workspace: { totalFiles: 100, cloneBytes: 5_000 },
    });
    expect(summary?.downloadedBytes).toBe(6_000);
    expect(summary?.fullCloneBytes).toBeUndefined();
    expect(summary?.savedBytes).toBeUndefined();
  });
});
