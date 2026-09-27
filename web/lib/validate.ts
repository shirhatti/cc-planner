/**
 * Validation of untrusted WebSocket messages from the browser.
 *
 * Everything a client sends is attacker-controlled as far as the server is
 * concerned: a start message picks the SDK permission mode, tool allowlists,
 * and a filesystem path to run against. These pure functions coerce the raw
 * JSON into well-typed requests, dropping (or rejecting) anything malformed
 * so web/lib/server.ts never forwards unchecked values to the SDK.
 */

import type { AuthConfig, ClientMessage, HydrateStrategy, SessionMode } from "./protocol";
import type { StartRequest } from "./session";

/** Permission modes a browser may request: sessions are plan-only. */
export const SESSION_MODES: readonly SessionMode[] = ["plan"];

const HYDRATE_STRATEGIES: readonly HydrateStrategy[] = ["gh", "git"];

/** Upper bounds that keep a single message from ballooning server memory. */
const MAX_PROMPT_CHARS = 1_000_000;
const MAX_TOOL_ENTRIES = 200;
const MAX_TOOL_CHARS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function isSessionMode(value: unknown): value is SessionMode {
  return typeof value === "string" && (SESSION_MODES as readonly string[]).includes(value);
}

/**
 * @returns the array's non-empty string entries (trimmed, capped), or
 *   undefined when `value` isn't an array or has no usable entries
 */
export function sanitizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry.length <= MAX_TOOL_CHARS)
    .slice(0, MAX_TOOL_ENTRIES);
  return out.length ? out : undefined;
}

function sanitizeAuth(value: unknown): AuthConfig | undefined {
  if (!isRecord(value)) return undefined;
  const auth: AuthConfig = {
    baseUrl: optionalString(value.baseUrl),
    authToken: optionalString(value.authToken),
    apiKey: optionalString(value.apiKey),
  };
  if (auth.baseUrl) {
    try {
      const url = new URL(auth.baseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") auth.baseUrl = undefined;
    } catch {
      auth.baseUrl = undefined;
    }
  }
  return auth.baseUrl || auth.authToken || auth.apiKey ? auth : undefined;
}

export type SanitizeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Coerce a raw `start` message into a StartRequest. Unknown or malformed
 * optional fields are dropped (an invalid mode falls back to "plan", the
 * most restrictive); a missing prompt or a mode outside SESSION_MODES that
 * the client explicitly asked for is rejected outright.
 */
export function sanitizeStartMessage(raw: Record<string, unknown>): SanitizeResult<StartRequest> {
  if (typeof raw.prompt !== "string" || !raw.prompt.trim()) {
    return { ok: false, error: "A prompt is required" };
  }
  if (raw.prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false, error: "Prompt is too long" };
  }
  if (raw.mode !== undefined && raw.mode !== null && !isSessionMode(raw.mode)) {
    return {
      ok: false,
      error: `Unsupported permission mode: ${String(raw.mode).slice(0, 40)} (expected ${SESSION_MODES.join(", ")})`,
    };
  }
  const mode: SessionMode = isSessionMode(raw.mode) ? raw.mode : "plan";

  return {
    ok: true,
    value: {
      prompt: raw.prompt,
      repo: optionalString(raw.repo),
      branch: optionalString(raw.branch),
      localPath: optionalString(raw.localPath),
      strategy:
        typeof raw.strategy === "string" &&
        (HYDRATE_STRATEGIES as readonly string[]).includes(raw.strategy)
          ? (raw.strategy as HydrateStrategy)
          : undefined,
      mode,
      appendSystemPrompt: optionalString(raw.appendSystemPrompt)?.slice(0, MAX_PROMPT_CHARS),
      allowedTools: sanitizeStringList(raw.allowedTools),
      disallowedTools: sanitizeStringList(raw.disallowedTools),
      auth: sanitizeAuth(raw.auth),
    },
  };
}

/**
 * Validate a non-start, session-scoped client message.
 *
 * @returns the typed message, or undefined if its shape is wrong
 */
export function sanitizeSessionMessage(
  raw: Record<string, unknown>,
): Exclude<ClientMessage, { type: "start" }> | undefined {
  const sessionId = raw.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return undefined;
  switch (raw.type) {
    case "user_message":
      return typeof raw.text === "string" && raw.text.length <= MAX_PROMPT_CHARS
        ? { type: "user_message", sessionId, text: raw.text }
        : undefined;
    case "answer_question": {
      if (typeof raw.id !== "string" || !isRecord(raw.answers)) return undefined;
      const answers: Record<string, string> = {};
      for (const [question, answer] of Object.entries(raw.answers)) {
        if (typeof answer === "string") answers[question] = answer;
      }
      return { type: "answer_question", sessionId, id: raw.id, answers };
    }
    case "permission_decision":
      return typeof raw.id === "string" && typeof raw.allow === "boolean"
        ? {
            type: "permission_decision",
            sessionId,
            id: raw.id,
            allow: raw.allow,
            always: raw.always === true,
          }
        : undefined;
    case "plan_decision":
      return typeof raw.id === "string" && typeof raw.approved === "boolean"
        ? {
            type: "plan_decision",
            sessionId,
            id: raw.id,
            approved: raw.approved,
            feedback: typeof raw.feedback === "string" ? raw.feedback : undefined,
          }
        : undefined;
    case "interrupt":
    case "end_session":
      return { type: raw.type, sessionId };
    default:
      return undefined;
  }
}

/**
 * Same-origin check for WebSocket upgrades (cross-site WebSocket hijacking
 * defense). Requests without an Origin header come from non-browser
 * clients and are allowed; browsers always send one.
 *
 * @param origin the request's Origin header
 * @param host the request's Host header
 * @param allowedOrigins extra origins (scheme://host[:port]) to accept
 */
export function isAllowedOrigin(
  origin: string | null,
  host: string | null,
  allowedOrigins: readonly string[] = [],
): boolean {
  if (origin === null) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (allowedOrigins.some((allowed) => allowed.replace(/\/+$/, "") === parsed.origin)) {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return host !== null && parsed.host.toLowerCase() === host.toLowerCase();
}

/** Parse a comma-separated origin allowlist env var. */
export function parseOriginList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}
