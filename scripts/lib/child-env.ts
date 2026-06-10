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

export function buildChildEnv(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env = { ...baseEnv };

  // Always required: unset CLAUDECODE to allow nested sessions
  delete env.CLAUDECODE;

  if (!isRemoteSandbox) {
    return env;
  }

  // --- Remote sandbox fixups ---

  if (!existsSync(SESSION_INGRESS_TOKEN_PATH)) {
    throw new Error(
      `Running in a Claude Code sandbox but the session ingress token was not found at ${SESSION_INGRESS_TOKEN_PATH}`,
    );
  }

  const token = readFileSync(SESSION_INGRESS_TOKEN_PATH, "utf-8").trim();

  // Provide the token the child will use for API auth
  env.ANTHROPIC_AUTH_TOKEN = token;

  // Remove env vars that reference parent-only file descriptors
  delete env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  delete env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR;

  // Remove env vars that conflict with the parent session
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  delete env.CLAUDE_CODE_CONTAINER_ID;
  delete env.CLAUDE_CODE_REMOTE;

  return env;
}
