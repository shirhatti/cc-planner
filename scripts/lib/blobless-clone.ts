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
import { rmSync } from "fs";

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

let ghAvailableCache: boolean | undefined;

/** Whether a usable `gh` CLI is on PATH (probed once per process). */
export function ghAvailable(): boolean {
  if (ghAvailableCache === undefined) {
    const res = spawnSync("gh", ["--version"], { stdio: "ignore" });
    ghAvailableCache = !res.error && res.status === 0;
  }
  return ghAvailableCache;
}

/** A one-line, actionable description of a failed `git clone`. */
export function describeCloneFailure(repo: string, branch: string | undefined, stderr: string) {
  // Without credentials GitHub answers a missing (or private) repo with an
  // auth challenge, which non-interactive git reports as "could not read
  // Username".
  if (/Repository not found|repository '[^']*' not found|could not read Username/i.test(stderr)) {
    return (
      `GitHub repository "${repo}" not found — check the owner/repo spelling, ` +
      "or that your GitHub login (`gh auth status`) can access it"
    );
  }
  if (branch && /Remote branch .* not found/i.test(stderr)) {
    return `Branch "${branch}" not found in ${repo}`;
  }
  const detail = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Cloning into"))
    .join(" ");
  return `Cloning ${repo} failed: ${detail || "git exited with an error"}`;
}

export function bloblessClone(repo: string, dest: string, branch?: string): BloblessClone {
  // Route credentials through gh (when present) so private repos work
  // without extra setup; without gh, fall back to git's own credential setup.
  const credentialArgs = ghAvailable()
    ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
    : [];
  const res = spawnSync(
    "git",
    [
      ...credentialArgs,
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      ...(branch ? ["--branch", branch] : []),
      `https://github.com/${repo}.git`,
      dest,
    ],
    { encoding: "utf-8" },
  );
  if (res.error || res.status !== 0) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(
      res.error
        ? `Cloning ${repo} failed: ${res.error.message}`
        : describeCloneFailure(repo, branch, res.stderr),
    );
  }
  const ref = run("git", ["-C", dest, "rev-parse", "HEAD"]).trim();
  return { root: dest, repo, ref };
}

/** Env vars that configure preload/vfs-hydrate.ts for this clone. */
export function hydrateEnv(clone: BloblessClone, strategy: "gh" | "git"): Record<string, string> {
  return {
    CC_HYDRATE_ROOT: clone.root,
    CC_HYDRATE_REPO: clone.repo,
    CC_HYDRATE_REF: clone.ref,
    CC_HYDRATE_STRATEGY: strategy,
  };
}
