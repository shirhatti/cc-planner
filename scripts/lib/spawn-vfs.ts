/**
 * Custom spawn function for the Claude Agent SDK that injects one or more
 * VFS preload scripts into the child claude process and forwards their IPC
 * messages to a handler.
 */

import { spawn } from "child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export type VfsMessage = { type: string } & Record<string, unknown>;

export function makeSpawnWithPreloads(
  preloads: string[],
  onMessage: (msg: VfsMessage) => void,
): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    const argsWithPreloads = [...preloads.flatMap((p) => ["--preload", p]), ...options.args];

    const proc = spawn(options.command, argsWithPreloads, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
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
