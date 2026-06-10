/**
 * Create a blob-less, checkout-less clone of a GitHub repository.
 *
 * `--filter=blob:none` downloads commits and trees but no file contents;
 * `--no-checkout` leaves the working tree empty. The result is a repo
 * skeleton the hydrating VFS (preload/vfs-hydrate.ts) can serve files into
 * on demand via the `gh` CLI.
 *
 * Authentication for private repos is delegated to `gh auth git-credential`.
 *
 * This is an internal implementation detail — use planRemoteRepo() from
 * lib/plan-remote.ts instead of calling it directly.
 */

import { spawnSync } from "child_process";

export interface BloblessClone {
  /** Absolute path of the (empty) working tree. */
  root: string;
  /** GitHub "owner/repo". */
  repo: string;
  /** Resolved HEAD commit sha. */
  ref: string;
}

function run(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { encoding: "utf-8" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout;
}

export function bloblessClone(repo: string, dest: string, branch?: string): BloblessClone {
  run("git", [
    // Route credentials through gh so private repos work without extra setup
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    ...(branch ? ["--branch", branch] : []),
    `https://github.com/${repo}.git`,
    dest,
  ]);
  const ref = run("git", ["-C", dest, "rev-parse", "HEAD"]).trim();
  return { root: dest, repo, ref };
}

/** Env vars that configure preload/vfs-hydrate.ts for this clone. */
export function hydrateEnv(clone: BloblessClone): Record<string, string> {
  return {
    CC_HYDRATE_ROOT: clone.root,
    CC_HYDRATE_REPO: clone.repo,
    CC_HYDRATE_REF: clone.ref,
  };
}
