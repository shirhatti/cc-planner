/**
 * WebSocket protocol between web/server.ts and the browser UI.
 *
 * The web app is a general browser client for Claude Code ("a TTY with
 * niceties"): a single connection multiplexes any number of concurrent
 * multi-turn sessions, and every session-scoped message carries the
 * client-generated `sessionId`.
 */

/** Permission modes the browser can start a session in. */
export type SessionMode = "plan" | "default" | "acceptEdits";

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

/** A file change extracted from an Edit/Write tool call, for diff rendering. */
export interface DiffPayload {
  filePath: string;
  oldText: string;
  newText: string;
}

/** Token counts by type. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Session statistics. Streamed with `final: false` as usage accumulates from
 * each assistant turn, then with `final: true` after each completed turn,
 * built from the SDK's authoritative token counts.
 */
export interface SessionStats {
  durationMs: number;
  /** Time spent waiting on the API (final stats only). */
  apiDurationMs?: number;
  /** Number of agentic turns (final stats only). */
  numTurns?: number;
  /**
   * Cost in USD, always estimated from public token pricing (never the
   * SDK's own cost figure). Undefined when no model in the session has a
   * known price. Final stats estimate from the SDK's authoritative token
   * counts.
   */
  costUsd?: number;
  /** Always true: costUsd (total and per-model) is estimated from public pricing. */
  estimated?: boolean;
  totals: TokenUsage;
  byModel: Record<string, TokenUsage & { costUsd?: number }>;
  /** Repo files hydrated on demand (lazy hydration mode only). */
  filesHydrated: number;
  /** Bytes of repo content fetched during hydration (lazy mode only). */
  bytesFetched: number;
  final: boolean;
}

// ---------------------------------------------------------------------------
// Browser -> server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | {
      type: "start";
      sessionId: string;
      /** The first user message of the session. */
      prompt: string;
      /** owner/repo — required in lazy mode, ignored in baked mode. */
      repo?: string;
      branch?: string;
      /** Permission mode. Defaults to "plan". */
      mode?: SessionMode;
      /**
       * Plan mode only: end the session once the plan is approved (the
       * classic planner workflow). When false, approval lets Claude continue
       * into implementation, with tool permissions prompted in the browser.
       * Defaults to true in plan mode.
       */
      stopOnPlanApproval?: boolean;
      auth?: AuthConfig;
    }
  /** A follow-up user message (multi-turn). Queued if a turn is running. */
  | { type: "user_message"; sessionId: string; text: string }
  /** Answers an ask_user_question event. `answers` is keyed by question text. */
  | { type: "answer_question"; sessionId: string; id: string; answers: Record<string, string> }
  /** Answers a permission_request event. */
  | { type: "permission_decision"; sessionId: string; id: string; allow: boolean; always?: boolean }
  /** Answers a plan_review event. */
  | {
      type: "plan_decision";
      sessionId: string;
      id: string;
      approved: boolean;
      feedback?: string;
    }
  /** Stop the turn in progress; the session stays open for more messages. */
  | { type: "interrupt"; sessionId: string }
  /** Close the session's input — Claude finishes the current turn and exits. */
  | { type: "end_session"; sessionId: string };

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
  /** A tool Claude used (Read, Glob, Bash, Edit, ...). */
  | { type: "tool_activity"; name: string; detail: string; diff?: DiffPayload }
  | { type: "hydrate_init"; files: number }
  | { type: "hydrate_fetch"; rel: string; size: number }
  /** Live plan content, streamed as Claude writes the plan file. */
  | { type: "plan_update"; filename: string; content: string }
  /** Claude called AskUserQuestion — render the questions and reply. */
  | { type: "ask_user_question"; id: string; questions: UserQuestion[] }
  /**
   * Claude needs permission for a tool call (Bash, Edit, Write, ...) —
   * answer with permission_decision. Sent for every gated tool outside of
   * AskUserQuestion / ExitPlanMode, which have dedicated events.
   */
  | { type: "permission_request"; id: string; toolName: string; detail: string; diff?: DiffPayload }
  /**
   * Claude called ExitPlanMode — approve or request changes. `plan` is the
   * plan content the CLI injected into the tool input from the plan file;
   * the server also re-emits it as a plan_update so the panel is always
   * current, even if no plan_file_write event was streamed.
   */
  | {
      type: "plan_review";
      id: string;
      allowedPrompts: { tool: string; prompt: string }[];
      plan?: string;
    }
  | { type: "plan_decided"; approved: boolean }
  /** Server-side note about the session (e.g. a Bash command auto-denied by policy). */
  | { type: "notice"; text: string }
  /** Live (and per-turn authoritative) duration/token/cost statistics. */
  | { type: "session_stats"; stats: SessionStats }
  /**
   * A turn completed — the session is idle and accepts the next
   * user_message. costUsd is estimated from public token pricing.
   */
  | { type: "result"; subtype: string; result?: string; costUsd?: number; durationMs?: number }
  /** The session has exited; no more events will follow. */
  | { type: "session_done" }
  | { type: "error"; message: string };

export type ServerMessage = ConfigMessage | (SessionEvent & { sessionId: string });
