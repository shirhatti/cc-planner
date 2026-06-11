/**
 * Run the plain Claude Code CLI (interactive or -p print mode) on top of the
 * hydrating VFS — no web app, no SDK wrapper. Makes a blob-less clone of the
 * repo, configures the preload, and execs the CLI inside that workspace:
 *
 *   bun run scripts/claude-vfs.ts <owner/repo> [--branch <b>] [--strategy gh|git] [-- <claude args...>]
 *
 * Examples:
 *   bun run scripts/claude-vfs.ts vercel/next.js -- --permission-mode plan
 *   bun run scripts/claude-vfs.ts owner/repo --branch dev -- -p "Summarize the build system"
 *
 * Uses your existing claude login/config (~/.claude). The CLI must be the JS
 * entrypoint so --preload applies; this script uses the cli.js vendored in
 * @anthropic-ai/claude-agent-sdk.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { bloblessClone, ghAvailable, hydrateEnv } from "./lib/blobless-clone";
import { buildChildEnv } from "./lib/child-env";
import { preloadScript } from "./lib/runtime-paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage(): never {
  console.error(
    "Usage: bun run scripts/claude-vfs.ts <owner/repo> [--branch <b>] [--strategy gh|git] [-- <claude args...>]",
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const splitAt = argv.indexOf("--");
const ours = splitAt === -1 ? argv : argv.slice(0, splitAt);
const claudeArgs = splitAt === -1 ? [] : argv.slice(splitAt + 1);

let repo = "";
let branch: string | undefined;
let strategy: "gh" | "git" | undefined;
for (let i = 0; i < ours.length; i++) {
  if (ours[i] === "--branch") branch = ours[++i];
  else if (ours[i] === "--strategy") strategy = ours[++i] as "gh" | "git";
  else if (!repo) repo = ours[i];
  else usage();
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) usage();

const cliPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "cli.js",
);
if (!existsSync(cliPath)) {
  console.error(`Claude Code CLI not found at ${cliPath} — run \`bun install\` first.`);
  process.exit(1);
}

const root = mkdtempSync(path.join(tmpdir(), "cc-planner-"));
console.error(`[claude-vfs] blob-less cloning ${repo}${branch ? `@${branch}` : ""} ...`);
const clone = bloblessClone(repo, root, branch);
const resolvedStrategy = strategy ?? (ghAvailable() ? "gh" : "git");
console.error(
  `[claude-vfs] workspace ${root} @ ${clone.ref.slice(0, 12)} (hydration: ${resolvedStrategy})`,
);

const result = spawnSync(
  process.execPath, // the running bun
  ["--preload", preloadScript("vfs-hydrate.ts"), cliPath, ...claudeArgs],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...buildChildEnv(), ...hydrateEnv(clone, resolvedStrategy) },
  },
);
process.exit(result.status ?? 1);
