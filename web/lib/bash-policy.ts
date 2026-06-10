/**
 * Bash command policy for lazily-hydrated workspaces.
 *
 * A blob-less clone serves the directory tree from a manifest inside the
 * claude process, but shell commands run as subprocesses *outside* the VFS:
 * readers (cat/head/tail) see only files that have already been hydrated,
 * and tree-walkers (tree, find, recursive grep, git grep) either return
 * misleading results or force the whole repo to be fetched. This policy
 * auto-denies those commands with guidance toward the VFS-optimal tools
 * (Glob/LS for structure, Read for contents, targeted git metadata
 * commands), auto-allows known-safe commands, and leaves everything else to
 * the normal permission flow.
 */

export interface BashPolicyResult {
  verdict: "allow" | "deny" | "ask";
  reason?: string;
}

const USE_GLOB =
  "this workspace is a lazily-hydrated clone; the directory tree is served from the repo manifest, so use the Glob or LS tools instead — they see the full tree without fetching any file contents";
const USE_READ =
  "this workspace hydrates file contents on demand; subprocess readers only see files that were already fetched, so use the Read tool instead — it hydrates exactly the files you read";
const USE_TARGETED =
  "recursive content search in a lazily-hydrated clone either misses unfetched files or forces the whole repo to download; locate files with Glob and Read the relevant ones instead";

/** git subcommands that only touch commit/tree metadata (always present). */
const GIT_SAFE = new Set([
  "status",
  "log",
  "diff",
  "show",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "branch",
  "tag",
  "remote",
  "shortlog",
  "describe",
  "blame",
  "cat-file",
  "rev-list",
  "config",
]);

/** Commands that are always safe and need no permission round-trip. */
const ALWAYS_SAFE = new Set(["pwd", "echo", "true", "which", "basename", "dirname", "date", "ls"]);

/** Tokenize one pipeline segment, tracking flags vs. positional args. */
function parseSegment(segment: string): { cmd: string; flags: string[]; args: string[] } {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  // Skip env-var prefixes (FOO=bar cmd ...).
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();

  const cmd = tokens.shift() ?? "";
  const flags: string[] = [];
  const args: string[] = [];
  let prevWasFlag = false;
  for (const token of tokens) {
    if (token.startsWith("-")) {
      flags.push(token);
      prevWasFlag = true;
    } else if (prevWasFlag && /^\d+$/.test(token)) {
      // Numeric value of the preceding flag (e.g. `head -n 20`).
      prevWasFlag = false;
    } else {
      args.push(token);
      prevWasFlag = false;
    }
  }
  return { cmd: cmd.replace(/^.*\//, ""), flags, args };
}

function evaluateSegment(segment: string): BashPolicyResult {
  const { cmd, flags, args } = parseSegment(segment);
  if (!cmd) return { verdict: "allow" };

  const hasRecursiveFlag = flags.some(
    (f) => f === "-R" || f === "--recursive" || /^-[a-zA-Z]*r/.test(f),
  );

  switch (cmd) {
    case "tree":
      return { verdict: "deny", reason: `Don't use tree: ${USE_GLOB}` };
    case "find":
      return { verdict: "deny", reason: `Don't use find: ${USE_GLOB}` };
    case "ls":
      if (hasRecursiveFlag) {
        return { verdict: "deny", reason: `Don't use ls -R: ${USE_GLOB}` };
      }
      return { verdict: "allow" };
    case "rg":
    case "ag":
    case "ack":
      return { verdict: "deny", reason: `Don't use ${cmd}: ${USE_TARGETED}` };
    case "grep":
    case "egrep":
    case "fgrep":
      if (hasRecursiveFlag) {
        return { verdict: "deny", reason: `Don't use recursive ${cmd}: ${USE_TARGETED}` };
      }
      // Pattern plus file operands reads files outside the VFS; a bare
      // pattern (stdin filter in a pipeline) is fine.
      if (args.length > 1) {
        return { verdict: "deny", reason: `Don't ${cmd} files directly: ${USE_READ}` };
      }
      return { verdict: "allow" };
    case "cat":
    case "less":
    case "more":
    case "strings":
      if (args.length > 0) {
        return { verdict: "deny", reason: `Don't use ${cmd} on files: ${USE_READ}` };
      }
      return { verdict: "allow" };
    case "head":
    case "tail":
    case "wc":
      // Fine as a pipeline filter; reading files directly bypasses the VFS.
      if (args.length > 0) {
        return { verdict: "deny", reason: `Don't use ${cmd} on files: ${USE_READ}` };
      }
      return { verdict: "allow" };
    case "du":
      return { verdict: "deny", reason: `Don't use du: ${USE_GLOB}` };
    case "git": {
      const sub = args[0];
      if (sub === "grep") {
        return {
          verdict: "deny",
          reason:
            "Don't use git grep: in a blob-less clone it lazily fetches every blob it searches, downloading the whole repo. " +
            USE_TARGETED,
        };
      }
      if (sub && GIT_SAFE.has(sub)) return { verdict: "allow" };
      return { verdict: "ask" };
    }
    default:
      return ALWAYS_SAFE.has(cmd) ? { verdict: "allow" } : { verdict: "ask" };
  }
}

/**
 * Evaluate a full Bash command for a hydrating workspace. Compound commands
 * are split on shell separators and the strictest segment verdict wins
 * (deny > ask > allow).
 */
export function evaluateBashCommand(command: string): BashPolicyResult {
  const segments = command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  let result: BashPolicyResult = { verdict: "allow" };
  for (const segment of segments) {
    const verdict = evaluateSegment(segment);
    if (verdict.verdict === "deny") return verdict;
    if (verdict.verdict === "ask") result = verdict;
  }
  return result;
}

/**
 * System-prompt guidance appended to sessions running on a lazily-hydrated
 * workspace, steering exploration toward VFS-optimal tools up front.
 */
export const HYDRATION_GUIDANCE = `
This workspace is a blob-less git clone: the full directory tree is always visible, but file contents are fetched over the network the first time each file is read. Work with that, not against it:
- Use the Glob and LS tools to explore structure — they are served from the repo manifest and fetch nothing.
- Use the Read tool for file contents — it hydrates exactly the files you read.
- The Grep tool and shell commands run outside this layer: they only see files that have already been read. Locate files with Glob and Read the relevant ones rather than searching broadly.
- Read-only git metadata commands (git log, git show, git diff, git ls-files, git ls-tree) are cheap and reliable.
- Avoid tree, find, ls -R, recursive grep/rg, git grep, du, and bulk file readers (cat/head/tail) — they walk the tree, force unnecessary downloads, or return misleading results. These commands are blocked in this workspace.
`.trim();
