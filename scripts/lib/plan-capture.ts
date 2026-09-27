/**
 * Plan-file capture for SDK sessions.
 *
 * Plans are written by Claude's own Write/Edit tool calls, so an in-process
 * PostToolUse hook sees every plan write as it happens — no filesystem
 * watching. When the tool's file_path is inside the plans directory, the
 * hook reads the file and reports it.
 *
 * Where plans go: Claude Code's `plansDirectory` setting must point inside
 * the project root, so git workspaces use .git/cc-planner-plans/ — inside
 * the workspace (a throwaway temp dir for lazy sessions), invisible to git,
 * and passed through untouched by the hydrating VFS (which ignores .git).
 * Workspaces without a .git directory keep the default ~/.claude/plans/.
 */

import type { HookCallback, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";

/** plansDirectory relative to the project root. */
export const PLANS_SUBDIR = path.join(".git", "cc-planner-plans");

/** The plansDirectory setting for a workspace, or undefined to keep the default. */
export function plansDirectorySetting(cwd: string): string | undefined {
  try {
    return statSync(path.join(cwd, ".git")).isDirectory() ? PLANS_SUBDIR : undefined;
  } catch {
    return undefined;
  }
}

/** Absolute directory Claude Code writes this workspace's plans to. */
export function plansDirectoryPath(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const setting = plansDirectorySetting(cwd);
  if (setting) return path.join(cwd, setting);
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "plans");
}

/** The path plus its realpath (macOS: /var/folders → /private/var/folders). */
function spellings(p: string): string[] {
  const resolved = path.resolve(p);
  try {
    return [...new Set([resolved, realpathSync(resolved)])];
  } catch {
    return [resolved];
  }
}

/**
 * PostToolUse hooks reporting each Write/Edit of a plan file in `plansDir`.
 * Merge into the session's hooks option.
 */
export function planCaptureHooks(
  plansDir: string,
  onPlan: (content: string, filename: string) => void,
): HookCallbackMatcher[] {
  const dirs = spellings(plansDir);
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    const filePath = (input.tool_input as { file_path?: unknown } | undefined)?.file_path;
    if (typeof filePath !== "string" || !filePath.endsWith(".md")) return {};
    if (!dirs.includes(path.dirname(path.resolve(filePath)))) return {};
    try {
      onPlan(readFileSync(filePath, "utf-8"), path.basename(filePath));
    } catch {
      // Unreadable right after the write — ExitPlanMode still carries the plan.
    }
    return {};
  };
  return [{ matcher: "Write|Edit|MultiEdit", hooks: [hook] }];
}
