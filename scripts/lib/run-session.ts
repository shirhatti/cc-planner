/**
 * Shared session plumbing for planRemoteRepo() and planBakedRepo(): both
 * start the SDK query the same way and differ only in workspace (cwd), the
 * child env, and which VFS preloads are injected.
 */

import {
  query,
  type CanUseTool,
  type HookCallbackMatcher,
  type HookEvent,
  type PermissionMode,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeCliPath, preloadScript } from "./runtime-paths";
import { makeSpawnWithPreloads, type VfsMessage } from "./spawn-vfs";

/** Options common to every session, whatever the workspace. */
export interface SessionOptions {
  /** A one-shot prompt, or a stream of user messages for multi-turn sessions. */
  prompt: string | AsyncIterable<SDKUserMessage>;
  /** Permission mode for the session. Defaults to "plan". */
  permissionMode?: PermissionMode;
  /** Extra instructions appended to the standard Claude Code system prompt. */
  appendSystemPrompt?: string;
  /** Hook callbacks (e.g. a PreToolUse hook gating Bash commands). */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Tools that execute without permission prompts (supports Bash(...) patterns). */
  allowedTools?: string[];
  /** Tools removed from the session entirely. */
  disallowedTools?: string[];
  /** Called with the plan content whenever a plan file is finalized. */
  onPlan?: (content: string, filename: string) => void;
  /** Called for every VFS IPC message (hydrate_fetch, vfs_write, plan_file_write, ...). */
  onVfsMessage?: (msg: VfsMessage) => void;
  /** Permission callback — lets the host answer tool permission requests. */
  canUseTool?: CanUseTool;
  /** Abort controller for cancelling the session. */
  abortController?: AbortController;
  /**
   * Extra env vars for the child claude process, applied last — e.g.
   * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN to route through an LLM gateway.
   */
  extraEnv?: Record<string, string>;
}

export interface WorkspaceConfig {
  /** Working directory of the claude process. */
  cwd: string;
  /** Child env (before extraEnv is applied). */
  env: Record<string, string | undefined>;
  /** Preload script basenames under preload/, e.g. "vfs-virtual.ts". */
  preloads: string[];
}

export function runSession(options: SessionOptions, workspace: WorkspaceConfig): Query {
  const handleMessage = (msg: VfsMessage): void => {
    if (msg.type === "plan_file_write" && options.onPlan) {
      options.onPlan(String(msg.content), String(msg.filename));
    }
    options.onVfsMessage?.(msg);
  };

  return query({
    prompt: options.prompt,
    options: {
      env: { ...workspace.env, ...options.extraEnv },
      permissionMode: options.permissionMode ?? "plan",
      systemPrompt: options.appendSystemPrompt
        ? { type: "preset", preset: "claude_code", append: options.appendSystemPrompt }
        : undefined,
      executable: "bun",
      pathToClaudeCodeExecutable: claudeCliPath(),
      cwd: workspace.cwd,
      hooks: options.hooks,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      canUseTool: options.canUseTool,
      abortController: options.abortController,
      spawnClaudeCodeProcess: makeSpawnWithPreloads(
        workspace.preloads.map((name) => preloadScript(name)),
        handleMessage,
      ),
    },
  });
}
