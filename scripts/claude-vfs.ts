/**
 * Run the plain Claude Code CLI (interactive or -p print mode) as a planner
 * on top of the hydrating VFS — no web app, no SDK wrapper. Makes a
 * blob-less clone of the repo, configures the preload, and runs the CLI in
 * plan mode inside that workspace:
 *
 *   bun run scripts/claude-vfs.ts <owner/repo> [--branch <b>] [--strategy gh|git] [-- <claude args...>]
 *
 * Examples:
 *   bun run scripts/claude-vfs.ts vercel/next.js
 *   bun run scripts/claude-vfs.ts owner/repo --branch dev -- -p "Plan a CLI --version flag"
 *
 * Sessions are plan-only: the CLI starts in plan mode, and once a plan is
 * approved (ExitPlanMode allowed) the session ends and the plan is printed.
 * Uses your existing claude login/config (~/.claude). The preload rides in
 * BUN_OPTIONS, which the native (Bun-compiled) claude binary honors.
 */

import { spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { bloblessClone, ghAvailable, hydrateEnv } from "./lib/blobless-clone";
import { buildChildEnv } from "./lib/child-env";
import { PLANS_SUBDIR } from "./lib/plan-capture";
import { claudeExecutablePath, preloadScript } from "./lib/runtime-paths";
import { preloadEnv } from "./lib/spawn-vfs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage(message?: string): never {
  if (message) console.error(`[claude-vfs] ${message}`);
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

// Plan-only: refuse flags that would leave plan mode or replace the
// settings that enforce it.
for (let i = 0; i < claudeArgs.length; i++) {
  const arg = claudeArgs[i];
  const mode = arg === "--permission-mode" ? claudeArgs[i + 1] : arg.split("--permission-mode=")[1];
  if (mode !== undefined && mode !== "plan") {
    usage(`sessions are plan-only; --permission-mode ${mode} is not supported`);
  }
  if (arg === "--settings" || arg.startsWith("--settings=")) {
    usage("--settings is not supported: the launcher supplies its own (hooks, plansDirectory)");
  }
  if (arg === "--dangerously-skip-permissions" || arg === "--allow-dangerously-skip-permissions") {
    usage(`${arg} is not supported: sessions are plan-only`);
  }
}

const claudeBin = claudeExecutablePath();

const root = mkdtempSync(path.join(tmpdir(), "cc-planner-"));
console.error(`[claude-vfs] blob-less cloning ${repo}${branch ? `@${branch}` : ""} ...`);
const clone = bloblessClone(repo, root, branch);
const resolvedStrategy = strategy ?? (ghAvailable() ? "gh" : "git");
console.error(
  `[claude-vfs] workspace ${root} @ ${clone.ref.slice(0, 12)} (hydration: ${resolvedStrategy})`,
);

const shellQuote = (part: string): string => `'${part.replace(/'/g, `'\\''`)}'`;
const hookCommand = (script: string): string =>
  [process.execPath, path.join(__dirname, script)].map(shellQuote).join(" ");

// - Bash policy (PreToolUse): read-only commands such as git ls-tree run
//   without a prompt; VFS-hostile ones are denied with guidance.
// - Plan approval (PostToolUse on ExitPlanMode): ends the session.
// - plansDirectory: plan files stay inside the throwaway clone's .git dir.
const settings = JSON.stringify({
  plansDirectory: PLANS_SUBDIR,
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: hookCommand("bash-policy-hook.ts") }],
      },
    ],
    PostToolUse: [
      {
        matcher: "ExitPlanMode",
        hooks: [{ type: "command", command: hookCommand("plan-approved-hook.ts") }],
      },
    ],
  },
});

const approvedFile = path.join(mkdtempSync(path.join(tmpdir(), "cc-planner-approved-")), "plan.md");
const baseEnv = { ...buildChildEnv(), ...hydrateEnv(clone, resolvedStrategy) };
const child = spawn(
  claudeBin,
  ["--permission-mode", "plan", "--settings", settings, ...claudeArgs],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...baseEnv,
      ...preloadEnv([preloadScript("vfs-hydrate.ts")], baseEnv),
      CC_PLANNER_APPROVED_FILE: approvedFile,
    },
  },
);

// The approval hook writes the plan; give the CLI a moment to render, then
// end the session (interactive mode would otherwise wait for more input).
let approved = false;
const poll = setInterval(() => {
  if (approved || !existsSync(approvedFile)) return;
  approved = true;
  setTimeout(() => child.kill("SIGTERM"), 500);
}, 250);

child.on("exit", (code) => {
  clearInterval(poll);
  if (approved) {
    console.error("\n[claude-vfs] plan approved — session ended.\n");
    console.log(readFileSync(approvedFile, "utf-8"));
    process.exit(0);
  }
  process.exit(code ?? 1);
});
