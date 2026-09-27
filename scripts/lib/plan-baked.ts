/**
 * Run a Claude Code session against a repo that is already fully present on
 * disk — e.g. one baked into the container image at build time (see
 * Dockerfile, BAKE_REPO build arg). Defaults to plan mode, but any
 * permission mode works.
 *
 * Unlike planRemoteRepo() there is no blob-less clone and no hydration:
 * every file is already on disk, so only the plan-file VFS
 * (preload/vfs-virtual.ts) is injected to stream plan content over IPC.
 */

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { buildChildEnv } from "./child-env";
import { runSession, type SessionOptions } from "./run-session";

export interface BakedPlanOptions extends SessionOptions {
  /** Absolute path of the checked-out repo (e.g. /repo in the container). */
  root: string;
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
    throw new Error(`Repo folder not found: ${options.root}`);
  }

  const session = runSession(options, {
    cwd: options.root,
    env: buildChildEnv(),
    preloads: ["vfs-virtual.ts"],
  });

  return { session, root: options.root, ref: resolveBakedRef(options.root) };
}
