/**
 * WebSocket protocol between web/server.ts and the browser UI.
 *
 * A single connection can run multiple concurrent planning sessions; every
 * session-scoped message carries the client-generated `sessionId`.
 */

/** A single question from Claude Code's AskUserQuestion tool. */
export interface UserQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: { label: string; description: string }[];
}

/** Optional overrides for routing API traffic through an LLM gateway. */
export interface AuthConfig {
  /** Sets ANTHROPIC_BASE_URL for the claude process. */
  baseUrl?: string;
  /** Sets ANTHROPIC_AUTH_TOKEN (sent as a Bearer token) for the claude process. */
  authToken?: string;
}

// ---------------------------------------------------------------------------
// Browser -> server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | {
      type: "start";
      sessionId: string;
      prompt: string;
      /** owner/repo — required in lazy mode, ignored in baked mode. */
      repo?: string;
      branch?: string;
      auth?: AuthConfig;
    }
  /** Answers an ask_user_question event. `answers` is keyed by question text. */
  | { type: "answer_question"; sessionId: string; id: string; answers: Record<string, string> }
  /** Answers a plan_review event. */
  | {
      type: "plan_decision";
      sessionId: string;
      id: string;
      approved: boolean;
      feedback?: string;
    }
  | { type: "interrupt"; sessionId: string };

// ---------------------------------------------------------------------------
// Server -> browser
// ---------------------------------------------------------------------------

/** Sent once when the socket opens; not session-scoped. */
export interface ConfigMessage {
  type: "config";
  mode: "baked" | "lazy";
  repo?: string;
  ref?: string;
}

export type SessionEvent =
  | { type: "session_started"; repo: string; ref: string }
  | { type: "session_init"; model: string }
  | { type: "assistant_text"; text: string }
  /** A read-only tool Claude used while exploring (Read, Glob, Grep, ...). */
  | { type: "tool_activity"; name: string; detail: string }
  | { type: "hydrate_init"; files: number }
  | { type: "hydrate_fetch"; rel: string; size: number }
  /** Live plan content, streamed as Claude writes the plan file. */
  | { type: "plan_update"; filename: string; content: string }
  /** Claude called AskUserQuestion — render the questions and reply. */
  | { type: "ask_user_question"; id: string; questions: UserQuestion[] }
  /** Claude called ExitPlanMode — approve or request changes. */
  | { type: "plan_review"; id: string; allowedPrompts: { tool: string; prompt: string }[] }
  | { type: "plan_decided"; approved: boolean }
  | { type: "result"; subtype: string; result?: string; costUsd?: number; durationMs?: number }
  | { type: "session_done" }
  | { type: "error"; message: string };

export type ServerMessage = ConfigMessage | (SessionEvent & { sessionId: string });
