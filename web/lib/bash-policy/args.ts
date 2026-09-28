/**
 * Shared pieces of the Bash policy: verdict helpers, hydration guidance
 * messages, and a getopt-style option parser driven by per-command specs.
 */

import type { Word } from "./parser";

export interface BashPolicyResult {
  verdict: "allow" | "deny" | "ask";
  reason?: string;
}

export const ALLOW: BashPolicyResult = { verdict: "allow" };

export function ask(reason: string): BashPolicyResult {
  return { verdict: "ask", reason };
}

export function deny(reason: string): BashPolicyResult {
  return { verdict: "deny", reason };
}

const RANK = { allow: 0, ask: 1, deny: 2 } as const;

/** The stricter of two verdicts (deny > ask > allow); the first wins ties. */
export function strictest(a: BashPolicyResult, b: BashPolicyResult): BashPolicyResult {
  return RANK[b.verdict] > RANK[a.verdict] ? b : a;
}

export const USE_GLOB =
  "this workspace is a lazily-hydrated clone; the directory tree is served from the repo manifest, so use the Glob or LS tools instead — they see the full tree without fetching any file contents";
export const USE_READ =
  "this workspace hydrates file contents on demand; subprocess readers only see files that were already fetched, so use the Read tool instead — it hydrates exactly the files you read";
export const USE_TARGETED =
  "recursive content search in a lazily-hydrated clone either misses unfetched files or forces the whole repo to download; locate files with Glob and Read the relevant ones instead";

// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------

export interface FlagSpec {
  /**
   * Options that consume a value (`-n 5`, `-n5`, `--lines 5`,
   * `--lines=5`), mapped to how many separate words they consume when the
   * value is not attached (jq's `--arg name value` takes 2).
   */
  values?: Record<string, number>;
  /** Options that make the command unsafe (long ones match abbreviations). */
  deny?: string[];
  /** If present, any option not listed here (or in `values`) is unsafe. */
  allow?: string[];
  /** `-20` style numeric options are accepted (head, tail). */
  numeric?: boolean;
  /**
   * Short options whose value may only be attached (`xargs -i{}`,
   * `-e<eof>`): the rest of the cluster is the value, never the next word.
   */
  attachedOnly?: string[];
  /** Options stop at the first positional (POSIX order, e.g. xargs, env). */
  stopAtPositional?: boolean;
}

export interface ParsedFlag {
  /** `-x` for short options, `--name` for long ones. */
  name: string;
  value?: string;
  /** The value word(s), when given separately. */
  valueWords?: Word[];
}

export interface ParsedArgs {
  flags: ParsedFlag[];
  positionals: Word[];
  /** Words after the first positional when `stopAtPositional` is set. */
  rest: Word[];
  /** An opaque word appeared where options are parsed. */
  hasOpaque: boolean;
  /** First option not allowed by the spec, if any. */
  unsafe?: string;
}

/** `--out` abbreviates `--output`: getopt_long and git accept unique prefixes. */
function matchesLong(given: string, target: string): boolean {
  return given === target || (given.length >= 3 && target.startsWith(given));
}

export function flagIs(flag: ParsedFlag, ...names: string[]): boolean {
  return names.some((n) => (n.startsWith("--") ? matchesLong(flag.name, n) : flag.name === n));
}

export function hasFlag(args: ParsedArgs, ...names: string[]): boolean {
  return args.flags.some((f) => flagIs(f, ...names));
}

export function parseArgs(words: Word[], spec: FlagSpec = {}): ParsedArgs {
  const values = spec.values ?? {};
  const result: ParsedArgs = { flags: [], positionals: [], rest: [], hasOpaque: false };
  let endOfOptions = false;

  const check = (name: string) => {
    if (result.unsafe) return;
    if (spec.deny?.some((d) => (d.startsWith("--") ? matchesLong(name, d) : name === d))) {
      result.unsafe = name;
    } else if (
      spec.allow &&
      !spec.allow.includes(name) &&
      !(name in values) &&
      !spec.attachedOnly?.includes(name)
    ) {
      result.unsafe = name;
    }
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const t = word.text;
    if (endOfOptions || word.procSubst || !t.startsWith("-") || t === "-") {
      if (word.opaque) result.hasOpaque = true;
      result.positionals.push(word);
      if (spec.stopAtPositional) {
        result.rest = words.slice(i + 1);
        break;
      }
      continue;
    }
    if (word.opaque) result.hasOpaque = true;
    if (t === "--") {
      endOfOptions = true;
      continue;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const flag: ParsedFlag = { name };
      const arity = Object.entries(values).find(
        ([k]) => k.startsWith("--") && matchesLong(name, k),
      );
      if (eq !== -1) {
        flag.value = t.slice(eq + 1);
      } else if (arity) {
        flag.valueWords = words.slice(i + 1, i + 1 + arity[1]);
        flag.value = flag.valueWords[0]?.text;
        i += arity[1];
      }
      check(name);
      result.flags.push(flag);
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(t)) {
      result.flags.push({ name: "-#", value: t.slice(1) });
      continue;
    }
    for (let j = 1; j < t.length; j++) {
      const name = "-" + t[j];
      const flag: ParsedFlag = { name };
      check(name);
      result.flags.push(flag);
      if (spec.attachedOnly?.includes(name)) {
        flag.value = t.slice(j + 1);
        break;
      }
      if (name in values) {
        if (j + 1 < t.length) {
          flag.value = t.slice(j + 1);
        } else {
          flag.valueWords = words.slice(i + 1, i + 1 + values[name]);
          flag.value = flag.valueWords[0]?.text;
          i += values[name];
        }
        break;
      }
      if (spec.numeric && /\d/.test(t[j + 1] ?? "") && /^\d+$/.test(t.slice(j + 1))) {
        // `-n20`-style attached count on a numeric-capable command.
        flag.value = t.slice(j + 1);
        break;
      }
    }
  }
  return result;
}

/** Build a `values` map where every listed option takes one word. */
export function takesValue(...names: string[]): Record<string, number> {
  return Object.fromEntries(names.map((n) => [n, 1]));
}
