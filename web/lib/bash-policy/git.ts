/**
 * git rules: which subcommands (and which forms of them) only read
 * repository metadata. Many "listing" commands double as mutators
 * (`git branch <name>` creates, `git config k v` writes, bare `git stash`
 * pushes), so each is checked form by form.
 */

import {
  ALLOW,
  ask,
  deny,
  flagIs,
  hasFlag,
  parseArgs,
  takesValue,
  USE_TARGETED,
  type BashPolicyResult,
  type ParsedArgs,
} from "./args";
import type { Word } from "./parser";

/** git global options that take a separate value (`git -C <path> ...`). */
const GLOBAL_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
]);

const GLOBAL_FLAGS = new Set([
  "--no-pager",
  "-P",
  "-p",
  "--paginate",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-advice",
  "--version",
  "--help",
]);

/**
 * git global options that can make any subcommand run arbitrary programs
 * (`-c core.pager=...`, `-c core.fsmonitor=...`, a swapped exec path).
 */
const EXEC_CAPABLE = /^(-c|--config-env|--exec-path)(=|$)/;

/** Options that make diff-producing commands write files or run programs. */
const DIFF_DENY = ["--output", "--ext-diff"];

/** History-wide content flags that fetch blobs for every commit shown. */
const LOG_CONTENT_FLAGS = [
  "-p",
  "-u",
  "-S",
  "-G",
  "--patch",
  "--stat",
  "--numstat",
  "--shortstat",
  "--cc",
  "--patch-with-stat",
  "--patch-with-raw",
  "--dirstat",
];

const READ_ONLY_PLAIN = new Set([
  "status",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "cat-file",
  "rev-list",
  "blame",
  "annotate",
  "describe",
  "merge-base",
  "name-rev",
  "for-each-ref",
  "show-ref",
  "count-objects",
  "check-ignore",
  "check-attr",
  "var",
  "version",
  "show-branch",
  "cherry",
]);

const DIFF_LIKE = new Set([
  "log",
  "show",
  "diff",
  "whatchanged",
  "shortlog",
  "diff-tree",
  "diff-index",
  "diff-files",
  "range-diff",
]);

export function evaluateGit(words: Word[], hydrating: boolean): BashPolicyResult {
  // Global options come before the subcommand.
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    const t = w.text;
    if (w.opaque) return ask("git with a dynamic global option");
    if (!t.startsWith("-")) break;
    if (EXEC_CAPABLE.test(t)) return ask(`git ${t.split("=")[0]} can run arbitrary programs`);
    const name = t.split("=")[0];
    if (GLOBAL_WITH_VALUE.has(name)) {
      if (!t.includes("=")) i++;
      continue;
    }
    if (!GLOBAL_FLAGS.has(t)) return ask(`unknown git global option ${t}`);
  }
  const subWord = words[i];
  if (!subWord) return ALLOW; // `git --version`, bare `git`
  if (subWord.dynamic) return ask("git with a dynamic subcommand");
  const sub = subWord.text;
  const rest = words.slice(i + 1);

  if (sub === "grep") {
    if (hydrating) {
      return deny(
        "Don't use git grep: in a blob-less clone it lazily fetches every blob it searches, downloading the whole repo. " +
          USE_TARGETED,
      );
    }
    return checkOpts(parseArgs(rest, { deny: ["-O", "--open-files-in-pager", "--ext-grep"] }));
  }

  if (DIFF_LIKE.has(sub)) {
    const args = parseArgs(rest, { deny: DIFF_DENY });
    const verdict = checkOpts(args);
    if (verdict.verdict !== "allow") return verdict;
    if (hydrating && (sub === "log" || sub === "whatchanged")) {
      const content = args.flags.find((f) => flagIs(f, ...LOG_CONTENT_FLAGS));
      if (content) {
        return deny(
          `Don't use git ${sub} ${content.name}: it promisor-fetches blobs for every commit shown. Use git log --format/--name-only --no-renames for metadata, git show <sha> for one commit, or Read for current file contents`,
        );
      }
    }
    return ALLOW;
  }

  if (READ_ONLY_PLAIN.has(sub)) {
    return checkOpts(parseArgs(rest, {}));
  }

  switch (sub) {
    case "branch":
      return gitBranch(rest);
    case "tag":
      return gitTag(rest);
    case "remote":
      return gitRemote(rest);
    case "config":
      return gitConfig(rest);
    case "reflog":
      return subcommandOnly(rest, "reflog", ["show", "exists"], true);
    case "stash":
      return subcommandOnly(rest, "stash", ["list", "show"], false);
    case "worktree":
      return subcommandOnly(rest, "worktree", ["list"], false);
    case "notes":
      return subcommandOnly(rest, "notes", ["list", "show"], true);
    default:
      return ask(`git ${sub} is not a known read-only git command`);
  }
}

function checkOpts(args: ParsedArgs): BashPolicyResult {
  if (args.unsafe) return ask(`git option ${args.unsafe} can write files or run programs`);
  if (args.hasOpaque) return ask("dynamic arguments could inject git options");
  return ALLOW;
}

/** `git reflog [show]`, `git stash list`, ...: only listed sub-subcommands. */
function subcommandOnly(
  rest: Word[],
  sub: string,
  allowed: string[],
  bareIsReadOnly: boolean,
): BashPolicyResult {
  const args = parseArgs(rest, {
    values: takesValue("--ref", "-n"),
    deny: DIFF_DENY,
    stopAtPositional: true,
  });
  const verdict = checkOpts(args);
  if (verdict.verdict !== "allow") return verdict;
  const action = args.positionals[0];
  if (!action) {
    return bareIsReadOnly ? ALLOW : ask(`bare git ${sub} modifies the repository`);
  }
  if (!allowed.includes(action.text)) return ask(`git ${sub} ${action.text} is not read-only`);
  return checkOpts(parseArgs(args.rest, { deny: DIFF_DENY }));
}

function gitBranch(rest: Word[]): BashPolicyResult {
  const args = parseArgs(rest, {
    values: takesValue("--contains", "--no-contains", "--points-at", "--format", "--sort"),
    allow: [
      "--list",
      "-l",
      "-a",
      "--all",
      "-r",
      "--remotes",
      "-v",
      "--verbose",
      "--show-current",
      "--merged",
      "--no-merged",
      "--color",
      "--no-color",
      "--column",
      "--no-column",
      "-i",
      "--ignore-case",
      "--abbrev",
      "--no-abbrev",
      "-q",
      "--quiet",
      "--omit-empty",
    ],
  });
  if (args.unsafe) return ask(`git branch ${args.unsafe} modifies branches`);
  if (args.hasOpaque) return ask("dynamic arguments to git branch");
  const listing = hasFlag(
    args,
    "--list",
    "-l",
    "-a",
    "--all",
    "-r",
    "--remotes",
    "--contains",
    "--no-contains",
    "--merged",
    "--no-merged",
    "--points-at",
  );
  if (args.positionals.length && !listing) return ask("git branch <name> creates a branch");
  return ALLOW;
}

function gitTag(rest: Word[]): BashPolicyResult {
  const args = parseArgs(rest, {
    values: takesValue("--contains", "--no-contains", "--points-at", "--format", "--sort"),
    allow: [
      "-l",
      "--list",
      "-n",
      "--merged",
      "--no-merged",
      "--column",
      "--no-column",
      "--color",
      "-i",
      "--ignore-case",
      "--omit-empty",
      // -n takes an attached count (`-n5`); digits parse as short flags.
      ..."0123456789".split("").map((d) => "-" + d),
    ],
  });
  if (args.unsafe) return ask(`git tag ${args.unsafe} modifies tags`);
  if (args.hasOpaque) return ask("dynamic arguments to git tag");
  const listing = hasFlag(
    args,
    "-l",
    "--list",
    "-n",
    "--contains",
    "--no-contains",
    "--points-at",
    "--merged",
    "--no-merged",
  );
  if (args.positionals.length && !listing) return ask("git tag <name> creates a tag");
  return ALLOW;
}

function gitRemote(rest: Word[]): BashPolicyResult {
  const args = parseArgs(rest, { allow: ["-v", "--verbose"], stopAtPositional: true });
  if (args.unsafe || args.hasOpaque) return ask("git remote with unknown options");
  const action = args.positionals[0];
  if (!action) return ALLOW;
  const actionArgs = parseArgs(args.rest, { allow: ["-n", "--push", "--all"] });
  if (actionArgs.unsafe || actionArgs.hasOpaque) return ask("git remote with unknown options");
  if (action.text === "get-url") return ALLOW;
  if (action.text === "show") {
    // Without -n, `git remote show <name>` queries the remote over the network.
    if (actionArgs.positionals.length && !hasFlag(actionArgs, "-n")) {
      return ask("git remote show <name> contacts the remote; add -n to stay offline");
    }
    return ALLOW;
  }
  return ask(`git remote ${action.text} modifies remotes`);
}

const CONFIG_READ_OPS = [
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--get-color",
  "--get-colorbool",
  "-l",
  "--list",
];

function gitConfig(rest: Word[]): BashPolicyResult {
  const first = rest[0];
  // git 2.46+ subcommand syntax.
  if (first && !first.text.startsWith("-")) {
    if (first.text === "get" || first.text === "list") {
      const args = parseArgs(rest.slice(1), {
        values: takesValue("--file", "-f", "--blob", "--type", "--default", "--url", "--value"),
        allow: [
          "--show-origin",
          "--show-scope",
          "--global",
          "--system",
          "--local",
          "--worktree",
          "--all",
          "--regexp",
          "--name-only",
          "-z",
          "--null",
          "--includes",
          "--no-includes",
          "--fixed-value",
          "--bool",
          "--int",
          "--path",
        ],
      });
      if (args.unsafe || args.hasOpaque) return ask("git config with unknown options");
      return ALLOW;
    }
  }
  const args = parseArgs(rest, {
    values: takesValue("--file", "-f", "--blob", "--type", "--default"),
    allow: [
      ...CONFIG_READ_OPS,
      "--show-origin",
      "--show-scope",
      "--global",
      "--system",
      "--local",
      "--worktree",
      "--name-only",
      "-z",
      "--null",
      "--includes",
      "--no-includes",
      "--bool",
      "--int",
      "--bool-or-int",
      "--path",
      "--expiry-date",
      "--fixed-value",
    ],
  });
  if (args.unsafe) return ask(`git config ${args.unsafe} modifies configuration`);
  if (args.hasOpaque) return ask("dynamic arguments to git config");
  if (args.flags.some((f) => CONFIG_READ_OPS.includes(f.name))) return ALLOW;
  // `git config <key>` reads; `git config <key> <value>` writes. Keys always
  // contain a dot, which also rules out newer verbs like `git config edit`.
  if (args.positionals.length === 1 && args.positionals[0].text.includes(".")) return ALLOW;
  if (args.positionals.length === 0) return ask("git config without an action");
  if (args.positionals.length === 1)
    return ask(`git config ${args.positionals[0].text} is not a read`);
  return ask("git config <key> <value> writes configuration");
}
