/**
 * Example: Using the Claude Agent SDK inside a Claude Code sandbox
 *
 * When the SDK spawns a child `claude` process inside a Claude Code remote
 * session (e.g., claude.ai/code), the child inherits environment variables
 * that reference parent-only file descriptors. Those FDs can't be inherited,
 * so the child crashes immediately.
 *
 * The fix: read the session ingress token from disk and pass it via
 * ANTHROPIC_AUTH_TOKEN, then strip the env vars that reference parent-only
 * resources. On a regular desktop this is a no-op.
 *
 * This example also demonstrates the VFS preload for plan mode.
 */

import { query, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VFS_SCRIPT = path.join(__dirname, "..", "preload", "vfs-virtual.ts");

// ---------------------------------------------------------------------------
// Sandbox detection
// ---------------------------------------------------------------------------

const SESSION_INGRESS_TOKEN_PATH =
  process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE ??
  "/home/claude/.claude/remote/.session_ingress_token";

const isRemoteSandbox = process.env.CLAUDE_CODE_REMOTE === "true";

// ---------------------------------------------------------------------------
// Environment fixup for child claude processes
// ---------------------------------------------------------------------------

/**
 * Build a clean environment for spawning a child claude process.
 *
 * Inside a Claude Code remote sandbox the parent authenticates via an OAuth
 * token passed through a file descriptor (pipe). That FD is process-local
 * and can't be inherited by children — the child crashes trying to read it.
 *
 * The same underlying token is also written to disk as a session ingress
 * token (`sk-ant-si-...`). The `claude` CLI accepts it through the
 * `ANTHROPIC_AUTH_TOKEN` env var, bypassing FD-based auth entirely.
 *
 * On a regular desktop this function only unsets `CLAUDECODE` (required to
 * allow nested Claude Code sessions).
 */
function buildChildEnv(
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const childEnv = buildChildEnv();

console.log(`[sdk-example] sandbox=${isRemoteSandbox}, starting query...`);

const session = query({
  prompt: "What is 2 + 2? Reply with just the number.",
  options: {
    env: childEnv,
    permissionMode: "plan",
    executable: "bun",
    cwd: process.cwd(),

    // Custom spawn to inject VFS preload
    spawnClaudeCodeProcess: (options) => {
      const argsWithPreload = ["--preload", VFS_SCRIPT, ...options.args];

      const proc = spawn(options.command, argsWithPreload, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        signal: options.signal,
      });

      // Listen for VFS events via IPC
      proc.on("message", (msg: Record<string, unknown>) => {
        if (msg.type === "vfs_init") {
          console.log(`[vfs] initialized: ${msg.plansDir}`);
        }
        if (msg.type === "plan_file_write") {
          console.log(`[vfs] plan updated: ${msg.filename}`);
          console.log(`[vfs] content preview: ${String(msg.content).substring(0, 200)}`);
        }
      });

      // Use getters so killed/exitCode reflect current state
      return {
        stdin: proc.stdin!,
        stdout: proc.stdout!,
        get killed() {
          return proc.killed;
        },
        get exitCode() {
          return proc.exitCode;
        },
        kill: proc.kill.bind(proc),
        on: proc.on.bind(proc),
        once: proc.once.bind(proc),
        off: proc.off.bind(proc),
      } as SpawnedProcess;
    },
  },
});

// Process SDK events
for await (const msg of session) {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        console.log(`[sdk] session initialized (model=${msg.model})`);
      }
      break;
    case "assistant":
      console.log(
        `[sdk] assistant:`,
        msg.message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(""),
      );
      break;
    case "result":
      if (msg.subtype === "success") {
        console.log(`[sdk] done — result: ${msg.result}`);
      } else {
        console.error(`[sdk] error: ${msg.subtype}`, "errors" in msg ? msg.errors : "");
      }
      break;
  }
}
