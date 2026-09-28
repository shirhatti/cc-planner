/**
 * Custom spawn function for the Claude Agent SDK that injects one or more
 * VFS preload scripts into the child claude process and forwards their IPC
 * messages to a handler.
 *
 * Claude Code ships as a Bun-compiled native binary, which takes runtime
 * flags from the BUN_OPTIONS env var rather than the command line — so the
 * preloads ride in BUN_OPTIONS. Each preload restores the caller's own
 * BUN_OPTIONS on load (see restoreBunOptions in preload/) so subprocesses
 * claude runs (Bash commands, hooks) don't inherit the VFS.
 */

import { spawn } from "child_process";
import { mkdtempSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export type VfsMessage = { type: string } & Record<string, unknown>;

/** Env var the preloads read to restore the caller's BUN_OPTIONS. */
export const ORIGINAL_BUN_OPTIONS_VAR = "CC_VFS_ORIGINAL_BUN_OPTIONS";

/**
 * BUN_OPTIONS is split on whitespace with no quoting, so a preload path with
 * spaces (e.g. inside "My App.app") is reached through a symlink in tmpdir.
 */
function whitespaceFreePath(p: string): string {
  if (!/\s/.test(p)) return p;
  const dir = mkdtempSync(path.join(tmpdir(), "cc-vfs-preload-"));
  const link = path.join(dir, path.basename(p).replace(/\s+/g, "-"));
  symlinkSync(p, link);
  if (/\s/.test(link)) {
    throw new Error(`Cannot pass preload ${p} via BUN_OPTIONS: tmpdir path contains whitespace`);
  }
  return link;
}

/** Env overrides that make a Bun executable load `preloads` first. */
export function preloadEnv(
  preloads: string[],
  env: Record<string, string | undefined>,
): Record<string, string> {
  const original = env.BUN_OPTIONS ?? "";
  const flags = preloads.map((p) => `--preload ${whitespaceFreePath(p)}`).join(" ");
  return {
    BUN_OPTIONS: original ? `${flags} ${original}` : flags,
    [ORIGINAL_BUN_OPTIONS_VAR]: original,
  };
}

export function makeSpawnWithPreloads(
  preloads: string[],
  onMessage: (msg: VfsMessage) => void,
): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    const env = options.env as Record<string, string | undefined>;
    const proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: (preloads.length ? { ...env, ...preloadEnv(preloads, env) } : env) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      signal: options.signal,
    });

    proc.on("message", (msg) => onMessage(msg as VfsMessage));

    // Use getters so killed/exitCode reflect current state
    return {
      stdin: proc.stdin!,
      stdout: proc.stdout!,
      get killed() {
        return proc.killed;
      },
      get exitCode() {
        return proc.exitCode;
      },
      kill: proc.kill.bind(proc),
      on: proc.on.bind(proc),
      once: proc.once.bind(proc),
      off: proc.off.bind(proc),
    } as SpawnedProcess;
  };
}
