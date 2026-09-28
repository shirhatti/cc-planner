/**
 * Bash command policy for the web TTY and the CLI PreToolUse hook. It
 * decides deterministically — no model, no subprocesses — whether a Bash
 * command is auto-allowed, auto-denied with guidance, or falls through to
 * the normal permission prompt ("ask").
 *
 * The command line is parsed (./bash-policy/parser.ts) into every simple
 * command it would run, including those inside `$(...)`, backticks,
 * process substitutions, subshells, groups and `bash -c '...'`. Each
 * simple command is judged on its own and the strictest verdict wins
 * (deny > ask > allow). Anything the parser can't model confidently asks.
 *
 * Two layers judge each simple command:
 *
 * 1. Universal read-only layer (every workspace): commands in the rule
 *    table below are allowed when used read-only — no write redirects, no
 *    options that write files or run programs, no dynamic words that could
 *    inject such options. Unknown commands ask.
 *
 * 2. Hydration layer (lazily-hydrated workspaces only): a blob-less clone
 *    serves the directory tree from a manifest inside the claude process,
 *    but shell commands run as subprocesses *outside* the VFS: readers
 *    (cat/head/sed/jq ... on files) see only files that were already
 *    hydrated, and tree-walkers (tree, find, recursive grep, git grep)
 *    either return misleading results or force the whole repo to be
 *    fetched. Those are denied with guidance toward the VFS-optimal tools
 *    (Glob/LS for structure, Read for contents, targeted git metadata
 *    commands). The same readers used as stdin filters stay allowed.
 */

import {
  ALLOW,
  ask,
  deny,
  hasFlag,
  parseArgs,
  strictest,
  takesValue,
  USE_GLOB,
  USE_READ,
  USE_TARGETED,
  type BashPolicyResult,
  type FlagSpec,
  type ParsedArgs,
} from "./bash-policy/args";
import { evaluateGit } from "./bash-policy/git";
import {
  parseCommandLine,
  UnsupportedSyntax,
  type Redirect,
  type SimpleCommand,
  type Word,
} from "./bash-policy/parser";
import { checkAwkScript, checkSedScript } from "./bash-policy/scripts";

export type { BashPolicyResult } from "./bash-policy/args";

export interface BashPolicyOptions {
  /** The workspace is a lazily-hydrated (blob-less) clone. */
  hydrating?: boolean;
}

interface Ctx {
  hydrating: boolean;
  depth: number;
}

const MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// Rule table
// ---------------------------------------------------------------------------

interface Rule {
  flags?: FlagSpec;
  /**
   * No option or argument can make the command write, execute or reach the
   * network, so dynamic words (`$VAR`, globs) are harmless.
   */
  anyArgs?: boolean;
  /** More positionals than this means an output operand (uniq, xxd). */
  maxPositionals?: number;
  /** Index of the first positional naming an input file (hydration layer). */
  filesFrom?: number;
  /** File operands, when they depend on the options used. */
  files?: (args: ParsedArgs) => Word[];
  /** Deny outright on hydrating workspaces (tree walkers). */
  hydrate?: "glob" | "targeted";
  /**
   * Extra safety checks after option parsing; "reads-files" means the
   * command is safe but reads files beyond its operands (sed `r`).
   */
  check?: (args: ParsedArgs, words: Word[]) => BashPolicyResult | "reads-files" | undefined;
  /** Hydration-specific checks with custom guidance (run before `files`). */
  hydrateCheck?: (args: ParsedArgs, cmd: string) => BashPolicyResult | undefined;
}

/** A command that only prints information, whatever its arguments. */
const INFO: Rule = { anyArgs: true };

/** A read-only filter over stdin or its file operands. */
const READER: Rule = { anyArgs: true, filesFrom: 0 };

function reader(values: string[], extra: Partial<Rule> = {}): Rule {
  return { anyArgs: true, filesFrom: 0, flags: { values: takesValue(...values) }, ...extra };
}

const GREP_VALUES = [
  "-e",
  "-f",
  "-m",
  "-A",
  "-B",
  "-C",
  "-d",
  "-D",
  "--regexp",
  "--file",
  "--max-count",
  "--after-context",
  "--before-context",
  "--context",
  "--directories",
  "--devices",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--label",
  "--binary-files",
  "--group-separator",
];

const grepRule: Rule = {
  anyArgs: true,
  flags: { values: takesValue(...GREP_VALUES) },
  files: (args) =>
    hasFlag(args, "-e", "-f", "--regexp", "--file") ? args.positionals : args.positionals.slice(1),
  hydrateCheck: (args, cmd) => {
    const recursive =
      hasFlag(args, "-r", "-R", "--recursive", "--dereference-recursive") ||
      args.flags.some(
        (f) => (f.name === "-d" || f.name === "--directories") && f.value === "recurse",
      );
    if (recursive) return deny(`Don't use recursive ${cmd}: ${USE_TARGETED}`);
    const files = realFiles(grepRule.files!(args));
    // Pattern plus file operands reads files outside the VFS; a bare
    // pattern (stdin filter in a pipeline) is fine.
    if (files.length) return deny(`Don't ${cmd} files directly: ${USE_READ}`);
    return undefined;
  },
};

/** find actions that execute commands, delete, or write files. */
const FIND_MUTATING = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

const sedRule: Rule = {
  flags: {
    values: takesValue("-e", "-f", "-l", "--expression", "--file", "--line-length"),
    allow: [
      "-n",
      "-E",
      "-r",
      "-s",
      "-u",
      "-z",
      "--quiet",
      "--silent",
      "--regexp-extended",
      "--separate",
      "--unbuffered",
      "--null-data",
      "--zero-terminated",
      "--posix",
      "--debug",
      "--sandbox",
    ],
  },
  files: (args) =>
    hasFlag(args, "-e", "--expression", "-f", "--file")
      ? args.positionals
      : args.positionals.slice(1),
  check: (args, words) => {
    if (hasFlag(args, "-f", "--file")) return ask("sed script file can't be inspected");
    const scripts = args.flags
      .filter((f) => f.name === "-e" || f.name === "--expression")
      .map((f) => f.value);
    if (!scripts.length) scripts.push(args.positionals[0]?.text);
    const files = new Set(sedRule.files!(args));
    if (words.some((w) => w.dynamic && !files.has(w))) return ask("dynamic sed script");
    let readsFiles = false;
    for (const script of scripts) {
      if (script === undefined) return ask("sed without a script");
      const check = checkSedScript(script);
      if (!check.safe) return ask(check.reason ?? "unsafe sed script");
      readsFiles ||= !!check.readsFiles;
    }
    return readsFiles ? "reads-files" : undefined;
  },
};

const awkRule: Rule = {
  flags: {
    values: takesValue(
      "-F",
      "-v",
      "-f",
      "-e",
      "--field-separator",
      "--assign",
      "--file",
      "--source",
    ),
    allow: [
      "-b",
      "-c",
      "-P",
      "-r",
      "-S",
      "-N",
      "--characters-as-bytes",
      "--traditional",
      "--posix",
      "--re-interval",
      "--sandbox",
      "--use-lc-numeric",
    ],
  },
  files: (args) => {
    const operands = hasFlag(args, "-e", "--source", "-f", "--file")
      ? args.positionals
      : args.positionals.slice(1);
    // `var=value` operands are assignments, not files.
    return operands.filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text));
  },
  check: (args, words) => {
    if (hasFlag(args, "-f", "--file")) return ask("awk program file can't be inspected");
    const scripts = args.flags
      .filter((f) => f.name === "-e" || f.name === "--source")
      .map((f) => f.value);
    if (!scripts.length) scripts.push(args.positionals[0]?.text);
    const files = new Set(awkRule.files!(args));
    if (words.some((w) => w.dynamic && !files.has(w))) return ask("dynamic awk program");
    for (const script of scripts) {
      if (script === undefined) return ask("awk without a program");
      const check = checkAwkScript(script);
      if (!check.safe) return ask(check.reason ?? "unsafe awk program");
    }
    return undefined;
  },
};

const jqRule: Rule = {
  anyArgs: true,
  flags: {
    values: {
      "--arg": 2,
      "--argjson": 2,
      "--slurpfile": 2,
      "--rawfile": 2,
      "-f": 1,
      "--from-file": 1,
      "-L": 1,
      "--indent": 1,
    },
  },
  files: (args) =>
    hasFlag(args, "-f", "--from-file") ? args.positionals : args.positionals.slice(1),
};

const XXD_VALUE = /^-(c|cols|g|groupsize|l|len|s|seek|o|offset|n|name|R)$/;
const XXD_FLAG =
  /^-(a|autoskip|b|bits|C|capitalize|E|EBCDIC|e|h|help|i|include|p|ps|postscript|plain|u|v|version|d|[cglson]-?\d+|[cglson]0x[0-9a-fA-F]+)$/;

const xxdRule: Rule = {
  // xxd has single-dash long options, so it is parsed by hand.
  files: (args) => args.positionals.slice(0, 1),
  check: (_args, words) => {
    const positionals: Word[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.opaque) return ask("dynamic arguments to xxd");
      if (!w.text.startsWith("-") || w.text === "-") positionals.push(w);
      else if (XXD_VALUE.test(w.text)) i++;
      else if (!XXD_FLAG.test(w.text)) return ask(`xxd ${w.text} may write or patch files`);
    }
    if (positionals.length > 1) return ask("xxd with an output file operand");
    return undefined;
  },
};

const RULES = new Map<string, Rule>([
  // Shell builtins and system information.
  ...[
    "pwd",
    "cd",
    "pushd",
    "popd",
    "dirs",
    "echo",
    "true",
    "false",
    ":",
    "which",
    "type",
    "basename",
    "dirname",
    "readlink",
    "realpath",
    "printenv",
    "whoami",
    "id",
    "groups",
    "uname",
    "arch",
    "nproc",
    "uptime",
    "free",
    "df",
    "ps",
    "locale",
    "logname",
    "tty",
    "sleep",
    "seq",
    "expr",
    "test",
    "[",
  ].map((c): [string, Rule] => [c, INFO]),
  [
    "printf",
    {
      check: (_args, words) => {
        const first = words[0]?.text === "--" ? words[1] : words[0];
        if (first?.opaque) return ask("dynamic printf format");
        if (words[0]?.text.startsWith("-v")) return ask("printf -v assigns a shell variable");
        return undefined;
      },
    },
  ],
  [
    "date",
    {
      flags: {
        values: takesValue("-d", "--date", "-f", "--file", "-r", "--reference"),
        deny: ["-s", "--set"],
      },
      check: (args) =>
        args.positionals.some((w) => !w.text.startsWith("+"))
          ? ask("date with an operand sets the system clock")
          : undefined,
    },
  ],
  [
    "hostname",
    {
      maxPositionals: 0,
      flags: {
        allow: [
          "-f",
          "-s",
          "-i",
          "-I",
          "-d",
          "-A",
          "-a",
          "--fqdn",
          "--long",
          "--short",
          "--domain",
          "--ip-address",
          "--all-ip-addresses",
          "--alias",
          "--all-fqdns",
        ],
      },
    },
  ],

  // Listings and tree walkers.
  [
    "ls",
    {
      anyArgs: true,
      flags: {
        values: takesValue("-I", "-w", "-T", "--ignore", "--width", "--tabsize", "--hide"),
      },
      hydrateCheck: (args) =>
        hasFlag(args, "-R", "--recursive") ? deny(`Don't use ls -R: ${USE_GLOB}`) : ALLOW,
    },
  ],
  [
    "tree",
    {
      hydrate: "glob",
      flags: {
        values: takesValue("-L", "-P", "-I", "-o", "--charset", "--filelimit", "--timefmt", "-H"),
        deny: ["-o", "--output"],
      },
    },
  ],
  [
    "find",
    {
      hydrate: "glob",
      check: (_args, words) => {
        for (const w of words) {
          if (w.opaque) return ask("dynamic arguments to find");
          if (FIND_MUTATING.has(w.text)) return ask(`find ${w.text} runs commands or writes files`);
        }
        return undefined;
      },
    },
  ],
  ["du", { anyArgs: true, hydrate: "glob" }],
  ...["fd", "fdfind"].map((c): [string, Rule] => [
    c,
    {
      hydrate: "glob",
      flags: {
        values: takesValue(
          "-e",
          "-E",
          "-t",
          "-d",
          "-j",
          "-S",
          "-o",
          "-c",
          "--extension",
          "--exclude",
          "--type",
          "--max-depth",
          "--min-depth",
          "--exact-depth",
          "--threads",
          "--size",
          "--owner",
          "--changed-within",
          "--changed-before",
          "--base-directory",
          "--search-path",
          "--color",
          "--max-results",
          "--ignore-file",
        ),
        deny: ["-x", "-X", "--exec", "--exec-batch"],
      },
    },
  ]),

  // Content search.
  ...["grep", "egrep", "fgrep"].map((c): [string, Rule] => [c, grepRule]),
  [
    "rg",
    {
      hydrate: "targeted",
      flags: {
        values: takesValue(
          "-e",
          "-f",
          "-g",
          "-t",
          "-T",
          "-m",
          "-A",
          "-B",
          "-C",
          "-j",
          "-M",
          "-r",
          "--regexp",
          "--file",
          "--glob",
          "--iglob",
          "--type",
          "--type-not",
          "--max-count",
          "--max-depth",
          "--replace",
        ),
        deny: ["--pre", "--pre-glob"],
      },
    },
  ],
  ["ag", { hydrate: "targeted", flags: { deny: ["--pager"] } }],
  ["ack", { hydrate: "targeted", flags: { deny: ["--pager", "--output", "--ackrc"] } }],

  // File readers and stdin filters.
  ...["cat", "tac", "rev", "strings", "more", "md5sum", "sha1sum", "sha224sum"].map(
    (c): [string, Rule] => [c, READER],
  ),
  ...["sha256sum", "sha384sum", "sha512sum", "b2sum", "cksum", "sum", "stat"].map(
    (c): [string, Rule] => [c, READER],
  ),
  [
    "less",
    {
      filesFrom: 0,
      flags: { deny: ["-o", "-O", "--log-file", "--LOG-FILE", "--lesskey-src"] },
      check: (args) =>
        args.positionals.some((w) => w.text.startsWith("+"))
          ? ask("less +commands can run shell commands")
          : undefined,
    },
  ],
  ...["head", "tail"].map((c): [string, Rule] => [
    c,
    {
      ...READER,
      flags: {
        numeric: true,
        values: takesValue("-n", "-c", "--lines", "--bytes", "-s", "--sleep-interval", "--pid"),
      },
    },
  ]),
  ["wc", READER],
  ["nl", reader(["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"])],
  ["fold", reader(["-w", "--width"])],
  ["paste", reader(["-d", "--delimiters"])],
  ["cut", reader(["-b", "-c", "-d", "-f", "--bytes", "--characters", "--delimiter", "--fields"])],
  ["tr", INFO],
  ["column", reader(["-s", "-c", "-o", "-N", "-R", "-H", "-W", "-E", "-l", "-O", "-n"])],
  ["od", reader(["-A", "-j", "-N", "-t", "-w", "-S", "--address-radix", "--skip-bytes"])],
  ["hexdump", reader(["-n", "-s", "-e", "-f"])],
  ["xxd", xxdRule],
  [
    "base64",
    {
      filesFrom: 0,
      maxPositionals: 1,
      flags: { values: takesValue("-w", "--wrap", "-b"), deny: ["-o", "--output"] },
    },
  ],
  [
    "file",
    {
      filesFrom: 0,
      flags: { values: takesValue("-m", "-f", "-F", "-e", "-P"), deny: ["-C", "--compile"] },
    },
  ],
  [
    "diff",
    reader([
      "-U",
      "-L",
      "-x",
      "-X",
      "-I",
      "-F",
      "-W",
      "--label",
      "--exclude",
      "--exclude-from",
      "--ignore-matching-lines",
      "--width",
      "--tabsize",
    ]),
  ],
  ["cmp", reader(["-i", "-n", "--ignore-initial", "--bytes"])],
  ["comm", reader(["--output-delimiter"])],
  [
    "sort",
    {
      filesFrom: 0,
      flags: {
        values: takesValue(
          "-k",
          "-t",
          "-S",
          "-T",
          "-o",
          "--key",
          "--field-separator",
          "--buffer-size",
          "--temporary-directory",
          "--parallel",
          "--batch-size",
          "--files0-from",
          "--random-source",
        ),
        deny: ["-o", "--output", "--compress-program"],
      },
    },
  ],
  [
    "uniq",
    {
      filesFrom: 0,
      // A second operand is uniq's output file.
      maxPositionals: 1,
      flags: {
        values: takesValue("-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"),
      },
    },
  ],
  ["jq", jqRule],
  ...["sed", "gsed"].map((c): [string, Rule] => [c, sedRule]),
  ...["awk", "gawk", "mawk", "nawk"].map((c): [string, Rule] => [c, awkRule]),
]);

// ---------------------------------------------------------------------------
// Environment assignments
// ---------------------------------------------------------------------------

/**
 * Variables that change which program runs or make an allowed command run
 * other programs (pagers, git config lookup, loader hooks).
 */
const DANGEROUS_ENV =
  /^(PATH|LD_\w*|DYLD_\w*|BASH_ENV|ENV|BASH_FUNC_\w*|BASH_\w*|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|IFS|HOME|XDG_CONFIG_HOME|XDG_CONFIG_DIRS|GIT_\w*|PAGER|MANPAGER|LESSOPEN|LESSCLOSE|LESSKEY\w*|EDITOR|VISUAL|NODE_OPTIONS|PYTHON\w*|PERL5\w*|PERLLIB|RUBYOPT|RUBYLIB|SSH_ASKPASS|RIPGREP_CONFIG_PATH|AWKPATH|AWKLIBPATH|JQ_LIBRARY_PATH|GLOBIGNORE|CDPATH)$/;

const SAFE_ENV_VALUES: Record<string, string[]> = {
  GIT_PAGER: ["", "cat"],
  PAGER: ["", "cat"],
  GIT_TERMINAL_PROMPT: ["0", "1"],
  GIT_OPTIONAL_LOCKS: ["0", "1"],
};

function checkAssignment(name: string, value: Word): BashPolicyResult {
  if (!DANGEROUS_ENV.test(name)) return ALLOW;
  if (!value.dynamic && SAFE_ENV_VALUES[name]?.includes(value.text)) return ALLOW;
  return ask(`setting ${name} can change which programs run`);
}

// ---------------------------------------------------------------------------
// Redirections
// ---------------------------------------------------------------------------

const SAFE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

function evaluateRedirect(r: Redirect, ctx: Ctx): BashPolicyResult {
  const t = r.target;
  switch (r.op) {
    case "<<":
    case "<<-":
    case "<<<":
      return ALLOW;
    case "<":
      if (t.procSubst || (!t.dynamic && t.text === "/dev/null")) return ALLOW;
      if (ctx.hydrating) {
        return deny(`Don't redirect files into commands: ${USE_READ}`);
      }
      return ALLOW;
    case "<&":
      return /^(\d+|-)$/.test(t.text) ? ALLOW : ask("unusual input redirection");
    case ">&":
      if (/^(\d+|-)$/.test(t.text)) return ALLOW;
      break;
    case "<>":
      return ask("read-write redirection");
  }
  if (t.procSubst || (!t.dynamic && SAFE_SINKS.has(t.text))) return ALLOW;
  return ask(`output redirection writes to ${t.text}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const SYSTEM_BIN = /^\/(?:usr\/(?:local\/)?|opt\/homebrew\/)?s?bin\/([^/]+)$/;

/** The command's name, or null if it can't be determined statically. */
function commandName(word: Word): string | null {
  if (word.dynamic || word.opaque) return null;
  const t = word.text;
  if (!t.includes("/")) return t;
  // Absolute paths into system bin dirs name the same tool; anything else
  // (./git, /tmp/x/cat) is an arbitrary executable.
  return SYSTEM_BIN.exec(t)?.[1] ?? null;
}

/** File operands that actually name files (not stdin or pipes). */
function realFiles(words: Word[]): Word[] {
  return words.filter(
    (w) => !w.procSubst && w.text !== "-" && !/^\/dev\/(stdin|null)$/.test(w.text),
  );
}

function applyRule(cmd: string, rule: Rule, words: Word[], ctx: Ctx): BashPolicyResult {
  const args = parseArgs(words, rule.flags);
  let result: BashPolicyResult = ALLOW;
  if (args.unsafe) result = ask(`${cmd} ${args.unsafe} can write files or run programs`);
  else if (args.hasOpaque && !rule.anyArgs) {
    result = ask(`dynamic arguments could inject ${cmd} options`);
  } else if (rule.maxPositionals !== undefined && args.positionals.length > rule.maxPositionals) {
    result = ask(`${cmd} with extra operands may write a file`);
  }
  let readsExtraFiles = false;
  if (result.verdict === "allow" && rule.check) {
    const checked = rule.check(args, words);
    if (checked === "reads-files") readsExtraFiles = true;
    else if (checked) result = checked;
  }
  if (!ctx.hydrating) return result;

  // Hydration layer: deny VFS-hostile usage with guidance.
  if (rule.hydrate === "glob") return deny(`Don't use ${cmd}: ${USE_GLOB}`);
  if (rule.hydrate === "targeted") return deny(`Don't use ${cmd}: ${USE_TARGETED}`);
  if (rule.hydrateCheck) {
    const hydrated = rule.hydrateCheck(args, cmd);
    if (hydrated) return strictest(result, hydrated);
  }
  const operands = rule.files
    ? rule.files(args)
    : rule.filesFrom !== undefined
      ? args.positionals.slice(rule.filesFrom)
      : [];
  if (readsExtraFiles || realFiles(operands).length) {
    return deny(`Don't use ${cmd} on files: ${USE_READ}`);
  }
  return result;
}

/** An argument xargs appends from stdin: unknown text, possibly `-x`. */
const XARGS_INPUT: Word = { text: "", dynamic: true, opaque: true, procSubst: false };

type Wrapper = (words: Word[], ctx: Ctx) => BashPolicyResult;

/** Commands that run another command: judge the inner command instead. */
const WRAPPERS = new Map<string, Wrapper>([
  ["!", (words, ctx) => evaluateInner(words, ctx)],
  [
    "time",
    (words, ctx) => {
      const args = parseArgs(words, { allow: ["-p"], stopAtPositional: true });
      if (args.unsafe) return ask(`time ${args.unsafe}`);
      return evaluateInner([...args.positionals, ...args.rest], ctx);
    },
  ],
  [
    "nice",
    (words, ctx) => {
      const args = parseArgs(words, {
        values: takesValue("-n", "--adjustment"),
        allow: [],
        numeric: true,
        stopAtPositional: true,
      });
      if (args.unsafe) return ask(`nice ${args.unsafe}`);
      return evaluateInner([...args.positionals, ...args.rest], ctx);
    },
  ],
  [
    "timeout",
    (words, ctx) => {
      const args = parseArgs(words, {
        values: takesValue("-s", "-k", "--signal", "--kill-after"),
        allow: ["--preserve-status", "--foreground", "-v", "--verbose"],
        stopAtPositional: true,
      });
      if (args.unsafe || args.hasOpaque) return ask("timeout with unknown options");
      if (!args.rest.length) return ask("timeout without a command");
      return evaluateInner(args.rest, ctx);
    },
  ],
  [
    "env",
    (words, ctx) => {
      const args = parseArgs(words, {
        values: takesValue("-u", "-C", "--unset", "--chdir"),
        allow: ["-i", "-0", "--ignore-environment", "--null"],
        stopAtPositional: true,
      });
      if (args.unsafe) return ask(`env ${args.unsafe}`);
      let rest = [...args.positionals, ...args.rest];
      if (rest[0]?.text === "-" && !rest[0].dynamic) rest = rest.slice(1);
      let result = ALLOW;
      while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0].text)) {
        const [name] = rest[0].text.split("=", 1);
        const value = { ...rest[0], text: rest[0].text.slice(name.length + 1) };
        result = strictest(result, checkAssignment(name, value));
        rest = rest.slice(1);
      }
      return rest.length ? strictest(result, evaluateInner(rest, ctx)) : result;
    },
  ],
  [
    "command",
    (words, ctx) => {
      const args = parseArgs(words, { allow: ["-v", "-V", "-p"], stopAtPositional: true });
      if (args.unsafe) return ask(`command ${args.unsafe}`);
      if (hasFlag(args, "-v", "-V")) return ALLOW;
      return evaluateInner([...args.positionals, ...args.rest], ctx);
    },
  ],
  [
    "xargs",
    (words, ctx) => {
      const args = parseArgs(words, {
        values: takesValue(
          "-I",
          "-L",
          "-n",
          "-P",
          "-s",
          "-d",
          "-E",
          "-a",
          "--arg-file",
          "--delimiter",
          "--max-args",
          "--max-lines",
          "--max-procs",
          "--max-chars",
          "--process-slot-var",
        ),
        attachedOnly: ["-i", "-e", "-l"],
        allow: [
          "-0",
          "--null",
          "-r",
          "--no-run-if-empty",
          "-t",
          "--verbose",
          "-x",
          "--exit",
          "-p",
          "--interactive",
          "-o",
          "--open-tty",
          "--replace",
          "--eof",
        ],
        stopAtPositional: true,
      });
      if (args.unsafe) return ask(`xargs ${args.unsafe}`);
      let result = ALLOW;
      if (ctx.hydrating && hasFlag(args, "-a", "--arg-file")) {
        result = deny(`Don't use xargs on files: ${USE_READ}`);
      }
      // With -I/-i/--replace, input lines are spliced into the inner words;
      // a word carrying the placeholder is as unknown as stdin itself.
      const replace = args.flags.find((f) => ["-I", "-i", "--replace"].includes(f.name));
      const placeholder = replace ? replace.value || "{}" : undefined;
      const inner = args.positionals.length
        ? [...args.positionals, ...args.rest].map((w) =>
            placeholder && w.text.includes(placeholder) ? { ...XARGS_INPUT, text: w.text } : w,
          )
        : [{ ...XARGS_INPUT, text: "echo", dynamic: false, opaque: false }];
      // xargs appends arguments read from stdin to the inner command.
      return strictest(result, evaluateInner([...inner, XARGS_INPUT], ctx));
    },
  ],
  ...["bash", "sh", "dash"].map((shell): [string, Wrapper] => [
    shell,
    (words, ctx) => {
      const args = parseArgs(words, {
        values: takesValue("-o"),
        allow: ["-c", "-e", "-u", "-x", "-l", "-v", "-f", "--norc", "--noprofile", "--posix"],
        stopAtPositional: true,
      });
      if (args.unsafe || args.hasOpaque) return ask(`${shell} with unknown options`);
      if (!hasFlag(args, "-c")) return ask(`${shell} runs a script file or stdin`);
      const script = args.positionals[0];
      if (!script) return ask(`${shell} -c without a script`);
      if (script.dynamic) return ask(`${shell} -c with a dynamic script`);
      return evaluateScript(script.text, { ...ctx, depth: ctx.depth + 1 });
    },
  ]),
]);

/** Judge the command a wrapper runs (a missing command is harmless). */
function evaluateInner(words: Word[], ctx: Ctx): BashPolicyResult {
  if (!words.length) return ALLOW;
  return evaluateWords(words, { ...ctx, depth: ctx.depth + 1 });
}

function evaluateWords(words: Word[], ctx: Ctx): BashPolicyResult {
  if (ctx.depth > MAX_DEPTH) return ask("command nesting too deep");
  const name = commandName(words[0]);
  if (name === null) return ask(`can't determine the command '${words[0].text}' statically`);
  const rest = words.slice(1);
  const wrapper = WRAPPERS.get(name);
  if (wrapper) return wrapper(rest, ctx);
  if (name === "git") return evaluateGit(rest, ctx.hydrating);
  const rule = RULES.get(name);
  if (!rule) return ask(`${name} is not a known read-only command`);
  return applyRule(name, rule, rest, ctx);
}

function evaluateSimple(cmd: SimpleCommand, ctx: Ctx): BashPolicyResult {
  let result: BashPolicyResult = ALLOW;
  for (const a of cmd.assignments) result = strictest(result, checkAssignment(a.name, a.value));
  for (const r of cmd.redirects) result = strictest(result, evaluateRedirect(r, ctx));
  if (cmd.words.length) result = strictest(result, evaluateWords(cmd.words, ctx));
  return result;
}

function evaluateScript(script: string, ctx: Ctx): BashPolicyResult {
  if (ctx.depth > MAX_DEPTH) return ask("command nesting too deep");
  let commands: SimpleCommand[];
  try {
    commands = parseCommandLine(script);
  } catch (err) {
    if (err instanceof UnsupportedSyntax) return ask(`unsupported shell syntax: ${err.message}`);
    throw err;
  }
  let result: BashPolicyResult = ALLOW;
  for (const cmd of commands) {
    result = strictest(result, evaluateSimple(cmd, ctx));
    if (result.verdict === "deny") return result;
  }
  return result;
}

/**
 * Evaluate a full Bash command. Every simple command it would run —
 * including substitutions, subshells and `bash -c` bodies — is judged, and
 * the strictest verdict wins (deny > ask > allow).
 */
export function evaluateBashCommand(
  command: string,
  options: BashPolicyOptions = {},
): BashPolicyResult {
  return evaluateScript(command, { hydrating: options.hydrating ?? false, depth: 0 });
}

/**
 * System-prompt guidance appended to sessions running on a lazily-hydrated
 * workspace, steering exploration toward VFS-optimal tools up front.
 */
export const HYDRATION_GUIDANCE = `
This workspace is a blob-less git clone: the full directory tree is always visible to the Glob/LS/Read tools, but file contents are fetched over the network the first time each file is read. Work with that, not against it:
- The working tree looks EMPTY to shell commands (ls, find) — that is expected, not an error or a sparse checkout. The manifest-backed tools see everything; do not probe the checkout configuration.
- git status reports every file as deleted for the same reason (nothing is checked out). That is not a real change to the repo: ignore it, and don't mention it in the plan.
- Use the Glob and LS tools to explore structure — they are served from the repo manifest and fetch nothing.
- Use the Read tool for file contents — it hydrates exactly the files you read.
- The Grep tool and shell commands run outside this layer: they only see files that have already been read. Locate files with Glob and Read the relevant ones rather than searching broadly.
- Cheap git metadata commands: git log (without -p/--stat), git ls-files, git ls-tree, git show <sha> --name-only --no-renames. Filtering metadata in a pipe is fine (git ls-files | grep ...).
- git show <sha> and git diff fetch the changed files' contents for that one commit — fine for inspecting a specific commit, but do not sweep history with git log -p/--stat/-S or git grep; those download blobs for every commit they touch and are blocked here.
- Avoid tree, find, ls -R, recursive grep/rg, du, and bulk file readers (cat/head/tail) — they walk the tree, force unnecessary downloads, or return misleading results. These commands are blocked in this workspace.
`.trim();
