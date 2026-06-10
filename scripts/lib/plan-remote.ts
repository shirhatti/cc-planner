/**
 * High-level API: run a Claude Code session against a GitHub repo without a
 * full clone. Defaults to plan mode, but any permission mode works — the
 * web TTY uses this with streaming input for interactive sessions.
 *
 * Everything below is handled internally:
 * - a blob-less, checkout-less clone (commit/tree metadata only) into a
 *   temp directory
 * - on-demand file hydration via `gh api` (preload/vfs-hydrate.ts)
 * - in-memory plan files streamed over IPC (preload/vfs-virtual.ts)
 * - child env fixups for running inside a Claude Code sandbox
 */

import {
  query,
  type CanUseTool,
  type PermissionMode,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { bloblessClone, ghAvailable, hydrateEnv } from "./blobless-clone";
import { buildChildEnv } from "./child-env";
import { makeSpawnWithPreloads, type VfsMessage } from "./spawn-vfs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VFS_VIRTUAL = path.join(__dirname, "..", "..", "preload", "vfs-virtual.ts");
const VFS_HYDRATE = path.join(__dirname, "..", "..", "preload", "vfs-hydrate.ts");

export interface RemotePlanOptions {
  /** GitHub repository as "owner/repo". */
  repo: string;
  /** A one-shot prompt, or a stream of user messages for multi-turn sessions. */
  prompt: string | AsyncIterable<SDKUserMessage>;
  /** Branch or tag to plan against. Defaults to the repo's default branch. */
  branch?: string;
  /** Permission mode for the session. Defaults to "plan". */
  permissionMode?: PermissionMode;
  /**
   * How file contents are fetched: "gh" uses the GitHub contents API,
   * "git" lazily fetches blobs from the promisor remote. Defaults to "gh"
   * when the gh CLI is available, "git" otherwise.
   */
  strategy?: "gh" | "git";
  /** Called with the plan content whenever a plan file is finalized. */
  onPlan?: (content: string, filename: string) => void;
  /** Called for every VFS IPC message (hydrate_fetch, vfs_write, ...). */
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

export interface RemotePlanSession {
  /** The SDK session — iterate it for assistant/result messages. */
  session: Query;
  /** Where the (initially empty) working tree lives; hydrated files land here. */
  root: string;
  /** The commit sha the session is planning against. */
  ref: string;
}

export function planRemoteRepo(options: RemotePlanOptions): RemotePlanSession {
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) {
    throw new Error(`planRemoteRepo: expected "owner/repo", got "${options.repo}"`);
  }

  const strategy = options.strategy ?? (ghAvailable() ? "gh" : "git");
  const root = mkdtempSync(path.join(tmpdir(), "cc-planner-"));
  const clone = bloblessClone(options.repo, root, options.branch);
  const childEnv = { ...buildChildEnv(), ...hydrateEnv(clone, strategy), ...options.extraEnv };

  const handleMessage = (msg: VfsMessage): void => {
    if (msg.type === "plan_file_write" && options.onPlan) {
      options.onPlan(String(msg.content), String(msg.filename));
    }
    options.onVfsMessage?.(msg);
  };

  const session = query({
    prompt: options.prompt,
    options: {
      env: childEnv,
      permissionMode: options.permissionMode ?? "plan",
      executable: "bun",
      cwd: root,
      canUseTool: options.canUseTool,
      abortController: options.abortController,
      spawnClaudeCodeProcess: makeSpawnWithPreloads([VFS_VIRTUAL, VFS_HYDRATE], handleMessage),
    },
  });

  return { session, root, ref: clone.ref };
}
