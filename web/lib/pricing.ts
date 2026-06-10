/**
 * Public Claude API token pricing, used to estimate session cost in real
 * time while usage streams in. The SDK's final result message carries the
 * authoritative cost; these estimates only cover the gap until then.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * (model pricing table; cache read = 0.1x input, 5m cache write = 1.25x
 * input). Cache writes are priced at the 5-minute TTL rate — 1-hour cache
 * writes cost 2x input, so the estimate can undercount sessions that use
 * long-TTL caching.
 */

import type { TokenUsage } from "./protocol";

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** USD per million cache-read tokens (0.1x input). */
  cacheReadPerMTok: number;
  /** USD per million cache-write tokens (5m TTL, 1.25x input). */
  cacheWritePerMTok: number;
}

function rates(input: number, output: number): ModelPricing {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: input * 0.1,
    cacheWritePerMTok: input * 1.25,
  };
}

/**
 * Prices keyed by model-ID prefix. SDK messages report dated IDs
 * (e.g. "claude-sonnet-4-5-20250929"), so lookup is by longest prefix.
 */
const PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": rates(10, 50),
  "claude-opus-4-8": rates(5, 25),
  "claude-opus-4-7": rates(5, 25),
  "claude-opus-4-6": rates(5, 25),
  "claude-opus-4-5": rates(5, 25),
  "claude-opus-4-1": rates(15, 75),
  "claude-opus-4": rates(15, 75),
  "claude-sonnet-4-6": rates(3, 15),
  "claude-sonnet-4-5": rates(3, 15),
  "claude-sonnet-4": rates(3, 15),
  "claude-haiku-4-5": rates(1, 5),
  "claude-3-5-haiku": rates(0.8, 4),
};

const PRICING_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);

/** Pricing for a (possibly date-suffixed) model ID, or undefined if unknown. */
export function priceForModel(modelId: string): ModelPricing | undefined {
  const key = PRICING_KEYS.find((k) => modelId.startsWith(k));
  return key ? PRICING[key] : undefined;
}

/** Estimated USD cost of `usage` on `modelId`; undefined for unknown models. */
export function estimateModelCostUsd(modelId: string, usage: TokenUsage): number | undefined {
  const p = priceForModel(modelId);
  if (!p) return undefined;
  return (
    (usage.inputTokens * p.inputPerMTok +
      usage.outputTokens * p.outputPerMTok +
      usage.cacheReadTokens * p.cacheReadPerMTok +
      usage.cacheCreationTokens * p.cacheWritePerMTok) /
    1e6
  );
}
