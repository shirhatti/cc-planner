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

import { execFile, spawnSync } from "child_process";
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

/** Bytes of git objects in a repo, from `git count-objects -v` (KiB fields). */
export function parseCountObjects(output: string): number {
  let kib = 0;
  for (const line of output.split("\n")) {
    const match = line.match(/^(size|size-pack|size-garbage):\s*(\d+)/);
    if (match) kib += Number(match[2]);
  }
  return kib * 1024;
}

/** Bytes the blob-less clone downloaded (commits and trees). */
export function cloneSizeBytes(root: string): number | undefined {
  try {
    return parseCountObjects(run("git", ["-C", root, "count-objects", "-v"]));
  } catch {
    return undefined;
  }
}

export interface CheckoutSize {
  /** Files in the tree at the ref. */
  files: number;
  /** Total size of those files — what a full checkout's working tree holds. */
  bytes: number;
}

/**
 * Sum a GitHub trees API response (recursive). Undefined when the listing
 * was truncated (huge repos), since the sum would undercount.
 */
export function sumTreeBlobs(body: unknown): CheckoutSize | undefined {
  const tree = body as { truncated?: boolean; tree?: { type?: string; size?: number }[] };
  if (!Array.isArray(tree?.tree) || tree.truncated) return undefined;
  let files = 0;
  let bytes = 0;
  for (const entry of tree.tree) {
    if (entry.type !== "blob") continue;
    files += 1;
    bytes += typeof entry.size === "number" ? entry.size : 0;
  }
  return { files, bytes };
}

/**
 * Size of the full checkout at `ref`, from one GitHub trees API call: via
 * gh when available (private repos work), else the public API (public repos
 * only, rate-limited). Resolves undefined when it can't be determined.
 */
export async function fetchCheckoutSize(
  repo: string,
  ref: string,
): Promise<CheckoutSize | undefined> {
  const endpoint = `repos/${repo}/git/trees/${ref}?recursive=1`;
  try {
    if (ghAvailable()) {
      const stdout = await new Promise<string>((resolve, reject) =>
        execFile("gh", ["api", endpoint], { maxBuffer: 256 * 1024 * 1024 }, (err, out) =>
          err ? reject(err) : resolve(out),
        ),
      );
      return sumTreeBlobs(JSON.parse(stdout));
    }
    const res = await fetch(`https://api.github.com/${endpoint}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "cc-planner" },
    });
    return res.ok ? sumTreeBlobs(await res.json()) : undefined;
  } catch {
    return undefined;
  }
}
