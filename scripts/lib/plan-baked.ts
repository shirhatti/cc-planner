/**
 * Run a Claude Code plan-mode session against a repo that is already fully
 * present on disk — e.g. one baked into the container image at build time
 * (see Dockerfile, BAKE_REPO build arg).
 *
 * Unlike planRemoteRepo() there is no blob-less clone and no hydration:
 * every file is already on disk, so only the plan-file VFS
 * (preload/vfs-virtual.ts) is injected to stream plan content over IPC.
 */

import { query, type CanUseTool, type Query } from "@anthropic-ai/claude-agent-sdk";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildChildEnv } from "./child-env";
import { makeSpawnWithPreloads, type VfsMessage } from "./spawn-vfs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VFS_VIRTUAL = path.join(__dirname, "..", "..", "preload", "vfs-virtual.ts");

export interface BakedPlanOptions {
  /** Absolute path of the checked-out repo (e.g. /repo in the container). */
  root: string;
  /** The planning prompt to send to Claude. */
  prompt: string;
  /** Called with the plan content whenever a plan file is finalized. */
  onPlan?: (content: string, filename: string) => void;
  /** Called for every VFS IPC message (vfs_write, plan_file_write, ...). */
  onVfsMessage?: (msg: VfsMessage) => void;
  /** Permission callback — lets the host answer AskUserQuestion / ExitPlanMode. */
  canUseTool?: CanUseTool;
  /** Abort controller for cancelling the session. */
  abortController?: AbortController;
  /**
   * Extra env vars for the child claude process, applied last — e.g.
   * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN to route through an LLM gateway.
   */
  extraEnv?: Record<string, string>;
}

export interface BakedPlanSession {
  /** The SDK session — iterate it for assistant/result messages. */
  session: Query;
  /** The repo working tree the session is planning against. */
  root: string;
  /** HEAD commit sha if the root is a git repo, "local" otherwise. */
  ref: string;
}

/** HEAD sha of the repo at `root`, or "local" if it isn't a git repo. */
export function resolveBakedRef(root: string): string {
  const res = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" });
  return res.status === 0 ? res.stdout.trim() : "local";
}

export function planBakedRepo(options: BakedPlanOptions): BakedPlanSession {
  if (!existsSync(options.root)) {
    throw new Error(`planBakedRepo: baked repo not found at ${options.root}`);
  }

  const handleMessage = (msg: VfsMessage): void => {
    if (msg.type === "plan_file_write" && options.onPlan) {
      options.onPlan(String(msg.content), String(msg.filename));
    }
    options.onVfsMessage?.(msg);
  };

  const session = query({
    prompt: options.prompt,
    options: {
      env: { ...buildChildEnv(), ...options.extraEnv },
      permissionMode: "plan",
      executable: "bun",
      cwd: options.root,
      canUseTool: options.canUseTool,
      abortController: options.abortController,
      spawnClaudeCodeProcess: makeSpawnWithPreloads([VFS_VIRTUAL], handleMessage),
    },
  });

  return { session, root: options.root, ref: resolveBakedRef(options.root) };
}
