/**
 * Environment fixup for spawning child claude processes.
 *
 * Inside a Claude Code remote sandbox the parent authenticates via an OAuth
 * token passed through a file descriptor (pipe). That FD is process-local
 * and can't be inherited by children — the child crashes trying to read it.
 *
 * The same underlying token is also written to disk as a session ingress
 * token (`sk-ant-si-...`). The `claude` CLI accepts it through the
 * `ANTHROPIC_AUTH_TOKEN` env var, bypassing FD-based auth entirely.
 *
 * On a regular desktop this is a no-op apart from unsetting `CLAUDECODE`
 * (required to allow nested Claude Code sessions).
 */

import { readFileSync, existsSync } from "fs";

export const SESSION_INGRESS_TOKEN_PATH =
  process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE ??
  "/home/claude/.claude/remote/.session_ingress_token";

export const isRemoteSandbox = process.env.CLAUDE_CODE_REMOTE === "true";

/**
 * CLAUDE_CODE_* settings a user may deliberately configure for the sandbox
 * (provider routing, output limits). Every other CLAUDE_CODE_* var in a
 * remote sandbox belongs to the parent session's harness — e.g.
 * CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES, which makes a `claude -p` child exit
 * with "--include-partial-messages requires --print and
 * --output-format=stream-json" — and must not leak into the child.
 */
const USER_CLAUDE_CODE_VARS = new Set([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
]);

/** Parent-session CLAUDE_* vars (outside the CLAUDE_CODE_ namespace). */
const PARENT_SESSION_VARS = [
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AFTER_LAST_COMPACT",
  "CLAUDE_AUTO_BACKGROUND_TASKS",
  "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
  "CLAUDE_ENABLE_STREAM_WATCHDOG",
  "CLAUDE_ADDITIONAL_DIRECTORIES",
  "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
];

export function buildChildEnv(
  baseEnv: Record<string, string | undefined> = process.env,
  tokenPath: string = SESSION_INGRESS_TOKEN_PATH,
): Record<string, string | undefined> {
  const env = { ...baseEnv };

  // Always required: unset CLAUDECODE to allow nested sessions
  delete env.CLAUDECODE;

  if (baseEnv.CLAUDE_CODE_REMOTE !== "true") {
    return env;
  }

  // --- Remote sandbox fixups ---

  if (!existsSync(tokenPath)) {
    throw new Error(
      `Running in a Claude Code sandbox but the session ingress token was not found at ${tokenPath}`,
    );
  }

  // The parent authenticates through file descriptors (OAuth / websocket
  // tokens) the child can't inherit; strip every harness var (FD pointers,
  // session ids, streaming/transport flags) and authenticate the child with
  // the on-disk session ingress token instead.
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") && !USER_CLAUDE_CODE_VARS.has(key)) {
      delete env[key];
    }
  }
  for (const key of PARENT_SESSION_VARS) {
    delete env[key];
  }

  env.ANTHROPIC_AUTH_TOKEN = readFileSync(tokenPath, "utf-8").trim();

  return env;
}
