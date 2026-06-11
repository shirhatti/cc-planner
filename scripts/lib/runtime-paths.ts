/**
 * Resolves on-disk resources the session runners need at runtime: the VFS
 * preload scripts (passed to `bun --preload`, so they must be real files)
 * and the Claude Code CLI the SDK spawns.
 *
 * From a source checkout everything resolves relative to this file. In the
 * packaged desktop app (see electrobun.config.ts) the bun process is bundled
 * to a single file, which breaks import.meta-relative paths — the desktop
 * entrypoint sets CC_RESOURCES_ROOT to the bundle's Resources/app directory,
 * where build.copy placed copies of preload/ and the agent SDK package.
 */

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resourcesRoot(): string | undefined {
  return process.env.CC_RESOURCES_ROOT || undefined;
}

/** Absolute path of a VFS preload script (preload/<name>). */
export function preloadScript(name: string): string {
  const root = resourcesRoot();
  return root
    ? path.join(root, "preload", name)
    : path.join(__dirname, "..", "..", "preload", name);
}

/**
 * Path to the Claude Code CLI for spawned sessions, or undefined to let the
 * SDK use the cli.js inside its own package. The packaged app ships a copy
 * of the SDK package (cli.js + vendored ripgrep) under Resources/app.
 */
export function claudeCliPath(): string | undefined {
  const root = resourcesRoot();
  return root ? path.join(root, "claude-agent-sdk", "cli.js") : undefined;
}
