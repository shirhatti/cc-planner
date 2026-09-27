/**
 * High-level API: run a Claude Code session against a GitHub repo without a
 * full clone. Defaults to plan mode, but any permission mode works — the
 * web TTY uses this with streaming input for interactive sessions.
 *
 * Everything below is handled internally:
 * - a blob-less, checkout-less clone (commit/tree metadata only) into a
 *   temp directory
 * - on-demand file hydration via `gh api` (preload/vfs-hydrate.ts)
 * - plan files captured from the workspace's .git dir (lib/plan-capture.ts)
 * - child env fixups for running inside a Claude Code sandbox
 */

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { bloblessClone, ghAvailable, hydrateEnv } from "./blobless-clone";
import { buildChildEnv } from "./child-env";
import { runSession, type SessionOptions } from "./run-session";

export interface RemotePlanOptions extends SessionOptions {
  /** GitHub repository as "owner/repo". */
  repo: string;
  /** Branch or tag to plan against. Defaults to the repo's default branch. */
  branch?: string;
  /**
   * How file contents are fetched: "gh" uses the GitHub contents API,
   * "git" lazily fetches blobs from the promisor remote. Defaults to "gh"
   * when the gh CLI is available, "git" otherwise.
   */
  strategy?: "gh" | "git";
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
  const session = runSession(options, {
    cwd: root,
    env: { ...buildChildEnv(), ...hydrateEnv(clone, strategy) },
    preloads: ["vfs-hydrate.ts"],
  });

  return { session, root, ref: clone.ref };
}
