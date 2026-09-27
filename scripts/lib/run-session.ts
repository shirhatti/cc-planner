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
import { planCaptureHooks, plansDirectoryPath, plansDirectorySetting } from "./plan-capture";
import { claudeExecutablePath, preloadScript } from "./runtime-paths";
import { makeSpawnWithPreloads, type VfsMessage } from "./spawn-vfs";

/** Options common to every session, whatever the workspace. */
export interface SessionOptions {
  /** A one-shot prompt, or a stream of user messages for multi-turn sessions. */
  prompt: string | AsyncIterable<SDKUserMessage>;
  /** Permission mode for the session. Defaults to "plan". */
  permissionMode?: PermissionMode;
  /** Extra instructions appended to the standard Claude Code system prompt. */
  appendSystemPrompt?: string;
  /** Replaces the plan-mode workflow body of the plan-mode system reminder. */
  planModeInstructions?: string;
  /** Hook callbacks (e.g. a PreToolUse hook gating Bash commands). */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Tools that execute without permission prompts (supports Bash(...) patterns). */
  allowedTools?: string[];
  /** Tools removed from the session entirely. */
  disallowedTools?: string[];
  /** Called with the plan content whenever a plan file is finalized. */
  onPlan?: (content: string, filename: string) => void;
  /** Called for every VFS IPC message (hydrate_init, hydrate_fetch, ...). */
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
  /** Preload script basenames under preload/, e.g. "vfs-hydrate.ts". */
  preloads: string[];
}

export function runSession(options: SessionOptions, workspace: WorkspaceConfig): Query {
  const plansDirectory = plansDirectorySetting(workspace.cwd);
  const hooks = { ...options.hooks };
  if (options.onPlan) {
    const planDir = plansDirectoryPath(workspace.cwd, workspace.env);
    hooks.PostToolUse = [
      ...(hooks.PostToolUse ?? []),
      ...planCaptureHooks(planDir, options.onPlan),
    ];
  }

  return query({
    prompt: options.prompt,
    options: {
      env: { ...workspace.env, ...options.extraEnv },
      permissionMode: options.permissionMode ?? "plan",
      systemPrompt: options.appendSystemPrompt
        ? { type: "preset", preset: "claude_code", append: options.appendSystemPrompt }
        : undefined,
      planModeInstructions: options.planModeInstructions,
      pathToClaudeCodeExecutable: claudeExecutablePath(),
      cwd: workspace.cwd,
      hooks,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      canUseTool: options.canUseTool,
      abortController: options.abortController,
      settings: plansDirectory ? { plansDirectory } : undefined,
      spawnClaudeCodeProcess: makeSpawnWithPreloads(
        workspace.preloads.map((name) => preloadScript(name)),
        (msg) => options.onVfsMessage?.(msg),
      ),
    },
  });
}
