# Virtual File System for Claude Code Plan Mode

A hydrating Virtual File System (VFS) for Claude Code's Plan Mode, injected as a Bun preload, plus live plan-file capture:

1. **Hydrating repo files** (`preload/vfs-hydrate.ts`) — Claude Code can plan against a repo cloned with `--filter=blob:none --no-checkout` (no file contents downloaded). Files are hydrated on demand via the `gh` CLI the first time Claude reads them, so **a fully cloned repo is never needed**.
2. **Plan capture** (`scripts/lib/plan-capture.ts`) — sessions point Claude Code's `plansDirectory` setting at the workspace's `.git/cc-planner-plans/`, and an in-process SDK PostToolUse hook streams each plan to the UI as Claude writes it.

Every session is a **planning session**: it runs in plan mode and ends when the plan is approved — the approved plan is the deliverable.

On top of this infra, `web/` provides a **browser client for Claude Code planning sessions** — multi-turn sessions, browser-side permissions, diffs, plan review — see [Web TTY](#web-tty).

## Overview

Claude Code (`@anthropic-ai/claude-agent-sdk` ^0.3) ships as a native, Bun-compiled binary installed from a per-platform optional dependency, `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]` (see `nativePackageName()` / `claudeExecutablePath()` in `scripts/lib/runtime-paths.ts`). Because it's a Bun executable, it honors the `BUN_OPTIONS` env var — so the VFS preload is injected as `BUN_OPTIONS="--preload <path>"` rather than on the command line.

**Key Features:**

- 🪶 **Blob-less Clones** - Plan against any GitHub repo without downloading its contents
- 💧 **On-demand Hydration** - Repo files are fetched via `gh api` only when Claude reads them
- 🚀 **Real-time Plan Streaming** - A PostToolUse hook on plan-file writes streams each plan to the UI as it's written
- 🔍 **Full Transparency** - All other filesystem paths work normally
- ⚡ **Zero Overhead** - Uses a Bun preload (via `BUN_OPTIONS`) for early injection

## How It Works

### Preload injection

`makeSpawnWithPreloads()` (`scripts/lib/spawn-vfs.ts`) is a custom SDK spawn function: it spawns the native binary with `BUN_OPTIONS` set to `--preload <path>` for each preload (via `preloadEnv()`) and an IPC channel for VFS events.

- `BUN_OPTIONS` is split on whitespace with no quoting, so a preload path containing whitespace (e.g. inside `My App.app`) is reached through a symlink in the temp directory.
- Each preload restores the caller's original `BUN_OPTIONS` on load (passed in `CC_VFS_ORIGINAL_BUN_OPTIONS`), so subprocesses Claude runs — Bash commands, hooks — don't inherit the VFS.

### Plan files

Plan files are written by Claude's own Write/Edit tool calls. They default to `~/.claude/plans/` (or `$CLAUDE_CONFIG_DIR/plans`). Git workspaces instead set Claude Code's `plansDirectory` setting to `.git/cc-planner-plans` (`PLANS_SUBDIR` / `plansDirectorySetting()` in `scripts/lib/plan-capture.ts`). The setting must point inside the project root; `.git` keeps plans out of git, and the hydrating VFS ignores `.git`, so the files pass through untouched.

Capture needs no filesystem watching and no fs interception inside the claude process: `planCaptureHooks(plansDir, onPlan)` returns an in-process SDK **PostToolUse** hook on `Write|Edit|MultiEdit`. When the tool's `file_path` is a `.md` file directly inside the plans directory (matched under both its path and its realpath, e.g. `/var/folders` vs `/private/var/folders` on macOS), the hook reads the file and calls `onPlan(content, filename)`. `plansDirectoryPath(cwd, env)` gives that directory: `<cwd>/.git/cc-planner-plans` when the workspace has a `.git` directory, otherwise `$CLAUDE_CONFIG_DIR/plans` or `~/.claude/plans`.

Plans live on disk — inside the workspace's `.git` directory for git workspaces (for lazy sessions that's a throwaway temp clone). Workspaces without a `.git` directory get live plan updates too, from the default plans directory. As a fallback, the final plan also arrives in `ExitPlanMode`'s input, which the web session re-emits as a `plan_update`.

> **Legacy:** `preload/vfs-virtual.ts` kept plan files entirely in memory by intercepting `fs` calls under `~/.claude/plans/`. It targets the JS CLI (`cli.js`, SDK ≤0.2.x); the native CLI writes plan files through `/proc/self/fd/<dirfd>/...` paths the preload can't recognize, so sessions no longer inject it. It and its tests remain in the repo — see [Legacy plan-file VFS](#legacy-plan-file-vfs).

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime installed
- API key configured in Claude Code (or an existing `claude` login)

`bun install` installs Claude Code itself: the SDK pulls in the native binary for your platform as an optional dependency.

### Installation

```bash
bun install
```

### Run Tests

```bash
bun test
```

The suite covers:

1. **Hydrating VFS** - Files in a blob-less clone are fetched on demand (tests run fully offline against a local fixture repo and a fake `gh`)
2. **Legacy plan-file VFS** - Plan files never touch disk; regular files pass through
3. **Session plumbing** (`scripts/session-plumbing.test.ts`) - `BUN_OPTIONS` preload injection (including the whitespace symlink and restoring the caller's value), the `plansDirectory` choice, and the plan-capture hook reporting only Write/Edit of plan files in the plans directory.
4. **Web server** - The session bridge, start-message validation, and the Bash policy

## Just the Claude Code CLI (no web app)

The VFS is a plain Bun preload — it works with the regular Claude Code CLI too. To start an interactive (or `-p` print-mode) planning session against any GitHub repo without cloning it:

```bash
# Interactive planning session against a repo you never clone
bun run scripts/claude-vfs.ts owner/repo

# Non-interactive
bun run scripts/claude-vfs.ts owner/repo -- -p "Summarize the build system"

# Pin a branch, force a hydration strategy
bun run scripts/claude-vfs.ts owner/repo --branch dev --strategy git
```

The launcher (`scripts/claude-vfs.ts`) makes a blob-less clone into a temp directory, configures `preload/vfs-hydrate.ts` via the `CC_HYDRATE_*` env vars and `BUN_OPTIONS`, and runs the native binary inside that workspace with `--permission-mode plan` and a `--settings` JSON containing:

- `plansDirectory` — plan files stay inside the throwaway clone's `.git` dir.
- A **PreToolUse** hook on Bash → `scripts/bash-policy-hook.ts`, which applies the web app's [Bash policy](#web-tty) (`web/lib/bash-policy.ts`): read-only commands like `git ls-tree` run without prompts and VFS-hostile ones are denied with guidance.
- A **PostToolUse** hook on ExitPlanMode → `scripts/plan-approved-hook.ts`, which writes the approved plan to `$CC_PLANNER_APPROVED_FILE` and returns `continue: false`. The launcher then stops the CLI and prints the plan.

Everything after `--` is passed to `claude` verbatim, except that sessions are plan-only: `--permission-mode` other than `plan`, `--settings`, and `--dangerously-skip-permissions` are rejected. In `-p` print mode there is no one to approve a plan, so ExitPlanMode isn't available and the plan is the final answer. Your existing login and settings (`~/.claude`) apply as usual.

Doing it by hand (e.g. to wire the preload into your own tooling):

```bash
git clone --filter=blob:none --no-checkout https://github.com/owner/repo.git /tmp/ws
cd /tmp/ws
CC_HYDRATE_ROOT=/tmp/ws \
  BUN_OPTIONS="--preload /path/to/cc-planner/preload/vfs-hydrate.ts" \
  /path/to/cc-planner/node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude \
  --permission-mode plan
```

The plain CLI doesn't get the web app's extras (plan streaming UI, prompt-free read-only tools) — it's just Claude Code on a lazily-hydrated workspace. Directory listings, `access` and `realpath` come from the repo manifest. With the `gh` strategy `stat` does too — sizes come from one GitHub trees API call and mtime is the commit time (hydrated files keep it), so a broad listing downloads nothing; with the `git` strategy sizes can't be known without the blob, so `stat` hydrates. File contents are fetched on first read. See [Configuration](#configuration) for the `CC_HYDRATE_*` knobs.

## Web TTY

`web/` is a browser client for Claude Code planning sessions — a TTY with niceties. Sessions are multi-turn, always run in plan mode, end when the plan is approved, and every interactive tool call is handled in the browser. The cc-planner VFS infra provides its repo workspaces.

```bash
bun run build          # build the UI (Vite)
bun run start          # serve http://localhost:3000 (PORT to override)

# development: Bun server + Vite dev server (HMR, proxies /ws to :3000)
bun run start & bun run dev:ui
```

The server binds `127.0.0.1` by default — it runs claude sessions with the host's credentials and filesystem, so exposing it on the network is an explicit opt-in via `CC_WEB_HOST=0.0.0.0` (the Dockerfile sets this; put an authenticating proxy in front of anything reachable by others). WebSocket upgrades from a browser page on a different origin are rejected (403); add trusted origins with `CC_WEB_ALLOWED_ORIGINS`. Start messages are validated server-side (`web/lib/validate.ts`): the permission mode must be `plan` (`SESSION_MODES`) — anything else is rejected — and malformed tool lists or options are dropped.

**Features**

- **Multi-turn sessions** — the first prompt starts the session; a composer sends follow-up messages (queued if a turn is running), `Stop turn` interrupts the current turn, and `End session` closes input so Claude finishes and exits. Multiple concurrent sessions multiplex over one WebSocket, each in its own claude process.
- **Browser permissions** — every gated tool call (Bash, Edit, Write, ...) renders as an allow / always-allow / deny card in the browser via the SDK's `canUseTool` callback.
- **Diff viewer** — Edit/Write tool activity and their permission cards render Shiki-highlighted unified diffs with [@pierre/diffs](https://diffs.com), so changes can be reviewed before they're allowed. Write diffs are computed against the current file on disk.
- **AskUserQuestion in the browser** — question cards (header chips, 2-4 options with descriptions, multi-select, free-text "Other") render inline in the session feed.
- **Plan mode + review** — the plan panel renders the plan markdown live as Claude writes it (via the plan-capture PostToolUse hook). When Claude calls `ExitPlanMode`, a review bar appears: approve or request changes with feedback. Approving ends the session — the approved plan is the deliverable.
- **Session stats** — duration (ticking live), token usage by type and per model, turn count, and hydration volume. Cost is always **estimated from public Claude API token pricing** (`web/lib/pricing.ts`) and marked `~`/`(est.)`; the SDK's own cost figure is never displayed.
- **localStorage persistence** — prompts, repo metadata, status, stats, and the latest plan of every session persist in the browser (live transcripts are not persisted across reloads).
- **Settings in the UI** — the sidebar settings (persisted in localStorage, sent with each new session) cover what would otherwise be server env vars, which matters for the desktop app: an Anthropic API key (`ANTHROPIC_API_KEY`), an LLM gateway base URL + bearer token (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`), and the hydration strategy for lazy sessions (`gh` / `git` / auto). Leave auth empty to use the server's environment — e.g. an existing `claude` login on the desktop.
- **Local folder workspaces** — the start form's workspace picker accepts an absolute path (`~` ok) to a checkout on the server's machine instead of a GitHub repo: no clone, no hydration, sessions run directly against the folder. On the desktop app the server _is_ the user's machine, making this the natural mode for working on local repos.
- **PWA** — installable, with a web manifest and an auto-updating service worker (app shell precached, hashed assets cached on demand).
- **Prompt-free read-only tools** — `Read`, `Glob`, `Grep`, `LS`, `NotebookRead`, and `TodoWrite` never require a permission prompt: they're passed to the CLI as `allowedTools`, with a `canUseTool` short-circuit as fallback. On lazy workspaces Read hydrates on demand and listings come from the manifest (Glob and Grep see only hydrated files — see [Limitations](#limitations)).
- **Per-session tool & prompt configuration** — the start form's _Advanced_ section takes extra always-allowed tools (including `Bash(...)` patterns like `Bash(bun test:*)`), disallowed tools (removed from the session entirely), and extra system-prompt instructions. Custom instructions are appended to the Claude Code preset system prompt (the SDK supports append only — there is no prepend) and compose with the hydration guidance on lazy workspaces.
- **Bash policy** — a deterministic policy (`web/lib/bash-policy.ts`) with two layers. Read-only commands (including read-only git metadata commands) are auto-allowed on every workspace. On lazy workspaces, commands that fight the VFS — tree walks, bulk file readers, recursive searches, and git commands that would promisor-fetch blobs for every commit or file they touch — are denied with guidance (subprocesses only see already-hydrated files; Read hydrates on demand). Anything not provably safe falls through to a normal permission prompt, and git `-c` / `--config-env` / `--exec-path` always prompt. Enforced by a PreToolUse hook (so it catches commands plan mode would auto-allow) plus matching guidance appended to the system prompt, which in practice steers Claude to LS/Read before any command is attempted.

The frontend is TypeScript Web Components built with Vite (`web/src/`), typed against the shared WebSocket protocol (`web/lib/protocol.ts`).

### Repo modes

| Mode                         | Repo contents                                                              | When                                                                |
| ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Lazy hydration** (default) | Blob-less clone per session; file contents hydrated on Claude's first read | Plan against any repo without downloading it                        |
| **Local folder**             | A checkout already on the server's filesystem, chosen per session          | Desktop app, or a volume mounted into the container                 |
| **Baked**                    | Full clone burned into the container image at build time                   | Zero clone/hydration latency and no GitHub access needed at runtime |

The workspace is resolved per session: a local path from the start form wins, then the server's baked default, then lazy hydration against the given `owner/repo`. Baked mode is enabled by pointing `CC_BAKED_REPO_PATH` at a checkout (plus optional `CC_BAKED_REPO=owner/repo` as a label); the Dockerfile wires this up automatically.

### Docker

```bash
# Lazy hydration mode
docker build -t cc-planner .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... cc-planner

# Bake a repo into the image at build time
docker build -t cc-planner-baked \
  --build-arg BAKE_REPO=owner/repo \
  --build-arg BAKE_REF=main \
  .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... cc-planner-baked
```

For a private repo at build time, pass `--build-arg BAKE_TOKEN=$(gh auth token)` (prefer an ephemeral fine-grained token: build args are recorded in image metadata). Instead of `ANTHROPIC_API_KEY` you can set `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` on the container, or supply them per session from the browser's gateway settings.

### Desktop app (macOS)

[Electrobun](https://electrobun.dev) packages the web TTY as a native macOS app, so there's no server lifetime to manage: the Electrobun main process is a Bun process that embeds the same server (`web/lib/server.ts`) on an ephemeral port, opens a native window pointed at it, and exits — server, sessions, and child claude processes included — when the window closes.

```bash
bun run app:dev      # build the UI, then build + launch the dev app
bun run app:build    # production build → build/stable-macos-*/
```

How the bundle stays self-contained (`electrobun.config.ts` + `desktop/index.ts`):

- The Vite UI build, the `preload/` VFS scripts, and the native Claude Code binary package for the build machine's platform (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, which is what sessions spawn) are copied into `Resources/app/` — the binary lands at `Resources/app/claude-native/claude`. `desktop/index.ts` points the session runners at them via `CC_RESOURCES_ROOT` (see `scripts/lib/runtime-paths.ts`). ASAR stays off because the preload scripts and the binary must be real files for `BUN_OPTIONS=--preload` and child spawning. Preload paths inside `My App.app`-style bundles with spaces are handled by the tmpdir symlink described in [Preload injection](#preload-injection).
- The bundled Bun runtime (`Contents/MacOS/bun`) is prepended to `PATH`, so spawned hooks and scripts don't need a system bun install. Homebrew dirs are added too, since GUI apps launch with a minimal `PATH` and lazy hydration needs `git`/`gh`.
- App icons come from `icon.iconset/`, generated alongside the PWA icons by `bun run scripts/generate-icons.ts` and converted by `iconutil` during the build.

No env vars are needed to configure the app: auth (API key or gateway), the hydration strategy, and local-folder workspaces are all set in the UI (see [the settings and workspace features](#web-tty)). Sessions fall back to the server environment for auth, so an existing `claude` login on the machine just works.

The app builds unsigned by default; enable `mac.codesign`/`mac.notarize`/`mac.createDmg` in `electrobun.config.ts` to distribute it.

### Web architecture

```
browser (Vite + TS Web Components)  ←WebSocket→  web/lib/server.ts (Bun.serve, serves web/dist)
                                                   hosts: web/server.ts (CLI) / desktop/index.ts (macOS app)
  cc-app / cc-feed / cc-composer                   ClaudeSession (web/lib/session.ts)
  cc-plan-panel / cc-question-card                   ├─ InputQueue → SDK streaming input (multi-turn)
  cc-diff (@pierre/diffs) / cc-stats-panel           ├─ canUseTool → question / plan review / permission cards
  cc-session-list / cc-settings-panel                ├─ planRemoteRepo() — lazy hydration workspace
                                                     └─ planBakedRepo()  — baked workspace
                                                        (both via runSession(): scripts/lib/run-session.ts)
```

Every session-scoped WebSocket message carries a client-generated `sessionId` (`web/lib/protocol.ts`), which is how one socket multiplexes many sessions.

## Environment Variables

All `CC_`-prefixed env vars in one place:

| Variable                      | Read by                         | Default                          | Description                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CC_BAKED_REPO_PATH`          | `web/lib/server.ts`             | unset                            | Path to a fully checked-out repo. If the directory exists, the web app runs in **baked** mode and plans against it; otherwise it runs in **lazy hydration** mode. The Dockerfile sets this to `/repo`.               |
| `CC_BAKED_REPO`               | `web/lib/server.ts`             | unset                            | `owner/repo` label for the baked checkout, shown in the UI and session records. Set from the `BAKE_REPO` build arg by the Dockerfile.                                                                                |
| `CC_HYDRATE_ROOT`             | `preload/vfs-hydrate.ts`        | unset (preload is inert)         | Path of the blob-less working tree to hydrate into.                                                                                                                                                                  |
| `CC_HYDRATE_REPO`             | `preload/vfs-hydrate.ts`        | parsed from the `origin` remote  | `owner/repo` used for `gh api` content fetches.                                                                                                                                                                      |
| `CC_HYDRATE_REF`              | `preload/vfs-hydrate.ts`        | `HEAD`'s sha                     | Commit to hydrate file contents from.                                                                                                                                                                                |
| `CC_HYDRATE_STRATEGY`         | `preload/vfs-hydrate.ts`        | `gh`                             | How contents are fetched: `gh` (GitHub contents API) or `git` (promisor lazy fetch). See [Hydration Strategies](#hydration-strategies).                                                                              |
| `CC_VFS_ORIGINAL_BUN_OPTIONS` | `preload/*.ts`                  | unset                            | The caller's original `BUN_OPTIONS`, set by `preloadEnv()` (`scripts/lib/spawn-vfs.ts`). Each preload restores it on load so subprocesses Claude runs don't inherit the VFS.                                         |
| `CC_PLANNER_APPROVED_FILE`    | `scripts/plan-approved-hook.ts` | unset                            | File the ExitPlanMode PostToolUse hook writes the approved plan to. Set by `scripts/claude-vfs.ts`, which watches for it to end the session.                                                                         |
| `CC_RESOURCES_ROOT`           | `scripts/lib/runtime-paths.ts`  | unset (resolve from source tree) | Directory containing copies of `preload/` and the native Claude Code binary (`claude-native/claude`). Set by the packaged desktop app (`desktop/index.ts`), where import.meta-relative paths don't survive bundling. |
| `CC_WEB_HOST`                 | `web/server.ts`                 | `127.0.0.1`                      | Interface the web server binds. Set to `0.0.0.0` to accept non-local connections; the Dockerfile does this so `-p 3000:3000` works.                                                                                  |
| `CC_WEB_ALLOWED_ORIGINS`      | `web/server.ts`                 | unset (same-origin only)         | Comma-separated extra browser origins (`https://host:port`) allowed to open the `/ws` WebSocket. Requests without an `Origin` header (non-browser clients) are always allowed.                                       |

The `CC_HYDRATE_*` vars are set automatically by `planRemoteRepo()` for the child claude process — you only set them yourself when wiring up `preload/vfs-hydrate.ts` manually (see [Configuration](#configuration)). `CC_VFS_ORIGINAL_BUN_OPTIONS` and `CC_PLANNER_APPROVED_FILE` are internal plumbing. The `CC_BAKED_*` vars configure the web server's repo mode and are normally set by the Dockerfile; `CC_WEB_*` configure its network exposure.

## Usage Example

Use the VFS with the Claude Agent SDK by pointing it at the native binary and providing a spawn function that injects the preload through `BUN_OPTIONS` (this is what `runSession()` in `scripts/lib/run-session.ts` does):

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  planCaptureHooks,
  plansDirectoryPath,
  plansDirectorySetting,
} from "./scripts/lib/plan-capture";
import { claudeExecutablePath, preloadScript } from "./scripts/lib/runtime-paths";
import { makeSpawnWithPreloads } from "./scripts/lib/spawn-vfs";

const cwd = "/tmp/ws"; // a blob-less clone (see "Doing it by hand" above)

// CRITICAL: Unset CLAUDECODE to allow nested sessions
delete process.env.CLAUDECODE;

// Called with each plan file as Claude writes it into <cwd>/.git/cc-planner-plans
const onPlan = (content: string, filename: string) => {
  console.log(`Plan updated: ${filename}`);
  // Stream to UI via WebSocket, SSE, etc.
};
const plansDirectory = plansDirectorySetting(cwd);

const session = query({
  prompt: "Create a plan for building a REST API",
  options: {
    permissionMode: "plan",
    cwd,
    env: { ...process.env, CC_HYDRATE_ROOT: cwd },
    pathToClaudeCodeExecutable: claudeExecutablePath(),
    settings: plansDirectory ? { plansDirectory } : undefined,
    hooks: { PostToolUse: planCaptureHooks(plansDirectoryPath(cwd), onPlan) },

    // Spawn the native binary with BUN_OPTIONS="--preload .../vfs-hydrate.ts"
    spawnClaudeCodeProcess: makeSpawnWithPreloads([preloadScript("vfs-hydrate.ts")], (msg) => {
      if (msg.type === "hydrate_fetch") console.log(`Hydrated ${msg.rel}`);
    }),
  },
});

// Process SDK events
for await (const msg of session) {
  if (msg.type === "assistant") {
    console.log("Claude:", msg.message);
  }
}
```

## Planning Without a Full Clone (Hydrating VFS)

cc-planner does not need a fully cloned repo to work. `planRemoteRepo()` runs a plan-mode session against any GitHub repo using only its commit/tree metadata:

```typescript
import { planRemoteRepo } from "./scripts/lib/plan-remote";

const { session } = planRemoteRepo({
  repo: "owner/repo",
  prompt: "Create a plan for adding rate limiting to the API",
  onPlan: (content) => console.log(content),
});

for await (const msg of session) {
  // assistant / result messages, same as a normal SDK session
}
```

Or from the command line:

```bash
bun run scripts/plan-remote-repo.ts owner/repo "Create a plan for adding rate limiting"
```

### How It Works

The blob-less clone is an internal implementation detail — you never interact with it directly:

1. `planRemoteRepo()` clones the repo into a temp directory with `git clone --filter=blob:none --no-checkout`. This downloads commits and trees but **zero file contents**, and leaves the working tree empty. For a large repo this is a few hundred KB instead of hundreds of MB.
2. The child claude process is started with `preload/vfs-hydrate.ts` in `BUN_OPTIONS`; the preload builds a manifest of every file in the tree from `git ls-tree` (purely local — trees are always present in a blob-less clone).
3. Directory listings (`readdir`), existence checks (`existsSync`), and path stats are answered from the manifest with **no network access**, so Claude sees the full repo structure immediately. Paths are matched under both the root and its real path (on macOS the temp dir `/var/folders/...` is realpathed to `/private/var/folders/...`).
4. The first time Claude actually reads a file (`readFileSync`, `fs.promises.readFile`, `open`, ...), the preload fetches it with `gh api repos/<owner>/<repo>/contents/<path>?ref=<sha>` (raw media type), writes it to disk, and the read proceeds normally.
5. Hydrated files live on disk, so subsequent access — including from subprocesses like `rg` or `cat` spawned by Bash tools — works without interception. Files Claude writes or deletes behave like a normal filesystem.

Authentication for private repos is delegated entirely to the `gh` CLI (`gh auth login`), both for the initial clone (via `gh auth git-credential`) and for content fetches (via `gh api`).

### Hydration Strategies

Two fetch strategies are supported; `planRemoteRepo()` picks automatically:

- **`gh`** (default when the gh CLI is available) — fetches file contents through the GitHub contents API. Requires `gh` on PATH and network access to `api.github.com`.
- **`git`** — exploits the fact that a blob-less clone is a _promisor_ clone: `git cat-file blob <ref>:<path>` makes git lazily fetch exactly that blob from origin, reusing whatever credentials or proxy the clone itself used. No gh CLI needed; works anywhere the clone worked (e.g., sandboxes that proxy git traffic but block `api.github.com`).

### Configuration

`preload/vfs-hydrate.ts` is configured via env vars (set automatically by `planRemoteRepo()`):

| Variable              | Required | Description                                                   |
| --------------------- | -------- | ------------------------------------------------------------- |
| `CC_HYDRATE_ROOT`     | yes      | Path of the blob-less working tree. Unset = preload is inert. |
| `CC_HYDRATE_REPO`     | no       | `owner/repo`; defaults to parsing the `origin` remote URL.    |
| `CC_HYDRATE_REF`      | no       | Commit to hydrate from; defaults to `HEAD`'s sha.             |
| `CC_HYDRATE_STRATEGY` | no       | `gh` (contents API, default) or `git` (promisor lazy fetch).  |

### Limitations

- Claude Code's Glob and Grep tools shell out to ripgrep, which runs outside the preload and only sees files that have already been hydrated. Explore directory structure with LS/Read and `git ls-files` / `git ls-tree` instead.
- Other content searches that spawn subprocesses (grep, rg from Bash) likewise only see hydrated files. Plan-mode exploration driven by LS/Read works fully.
- Symlinks and submodules in the tree are not hydrated.
- Hydration is synchronous (blocking `gh` call) per first read of each file.

## Running Inside a Claude Code Sandbox

When you use the SDK inside a Claude Code remote session (e.g., `claude.ai/code`), the child `claude` process inherits environment variables that reference **parent-only file descriptors** — pipes that can't be inherited. The child crashes immediately trying to read from a non-existent FD.

**Why it happens:** The parent authenticates via an OAuth token passed through file descriptor 4 (`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=4`). That FD belongs to the parent and isn't available to children.

**The fix:** The same underlying token is written to disk at `~/.claude/remote/.session_ingress_token` as a session ingress token (`sk-ant-si-...`). The `claude` CLI accepts it via `ANTHROPIC_AUTH_TOKEN`, bypassing FD-based auth entirely.

Before spawning a child claude process, you need to:

1. Set `ANTHROPIC_AUTH_TOKEN` to the contents of `~/.claude/remote/.session_ingress_token`
2. Delete env vars that reference parent-only file descriptors:
   - `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`
   - `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR`
3. Delete env vars that conflict with the parent session:
   - `CLAUDE_CODE_SESSION_ID`
   - `CLAUDE_CODE_REMOTE_SESSION_ID`
   - `CLAUDE_CODE_CONTAINER_ID`
   - `CLAUDECODE`
   - `CLAUDE_CODE_REMOTE`

The example at `scripts/sdk-example.ts` demonstrates this with a `buildChildEnv()` helper (`scripts/lib/child-env.ts`) that conditionally applies these fixups only when running inside a sandbox, so the same code works on both a regular desktop and inside `claude.ai/code`:

```bash
bun run scripts/sdk-example.ts
```

### GitHub Access Inside the Sandbox

Sandboxes typically have no `gh` CLI and block `api.github.com` at the egress proxy, while still allowing git traffic to `github.com` (and/or routing it through a local credential-injecting proxy for the session's authorized repos). The hydrating VFS handles this automatically: `planRemoteRepo()` detects that `gh` is unavailable and falls back to the `git` hydration strategy, which fetches blobs through the same channel the blob-less clone used. No extra GitHub auth setup is needed:

```bash
bun run scripts/plan-remote-repo.ts owner/repo "Create a plan for ..."
```

## IPC Events

The hydrating VFS communicates with the host via IPC messages (delivered to the `onMessage` handler of `makeSpawnWithPreloads()` / `onVfsMessage` of `runSession()`). Plan content is not an IPC event any more — it comes from the plan-capture PostToolUse hook (`onPlan`).

### `hydrate_init`

Sent when the hydrating VFS initializes over a blob-less clone.

```typescript
{
  type: "hydrate_init",
  mode: "hydrate",
  root: "/tmp/cc-planner-abc123",
  repo: "owner/repo",
  ref: "0123abcd...",
  files: 1234,
  timestamp: 1234567890
}
```

### `hydrate_fetch`

Sent when a file is hydrated from GitHub on first read.

```typescript
{
  type: "hydrate_fetch",
  path: "/tmp/cc-planner-abc123/src/index.ts",
  rel: "src/index.ts",
  size: 2048,
  timestamp: 1234567890
}
```

### `hydrate_error`

Sent when a `gh api` fetch fails (the read then throws `EIO`).

```typescript
{
  type: "hydrate_error",
  path: "/tmp/cc-planner-abc123/src/index.ts",
  rel: "src/index.ts",
  error: "HTTP 404 ...",
  timestamp: 1234567890
}
```

### Legacy plan-file VFS events

The legacy `preload/vfs-virtual.ts` (JS CLI only; not injected by sessions) emits `vfs_init` (with `plansDir`), `vfs_write` (every write, including `.tmp` files), `plan_file_write` (a plan file finalized by rename, with `filename` and `content`), `vfs_read`, and `vfs_unlink`.

## Project Structure

```
cc-planner/
├── package.json
├── tsconfig.json
├── vite.config.ts              # Vite build + dev server (PWA plugin, /ws proxy)
├── electrobun.config.ts        # macOS app build (bundle layout, copied resources)
├── README.md
├── Dockerfile                  # Web TTY image; BAKE_REPO arg bakes a repo in
├── icon.iconset/               # macOS app icons (generated, converted by iconutil)
├── desktop/
│   └── index.ts                # macOS app entry: embeds the server, opens a window
├── preload/
│   ├── vfs-hydrate.ts          # On-demand hydration over blob-less clones
│   └── vfs-virtual.ts          # Legacy: in-memory plan-file VFS (JS CLI only, unused)
├── scripts/
│   ├── claude-vfs.ts           # Plain Claude Code CLI on a lazily-hydrated workspace
│   ├── bash-policy-hook.ts     # PreToolUse Bash hook for the launcher (bash policy)
│   ├── plan-approved-hook.ts   # PostToolUse ExitPlanMode hook: ends the session
│   ├── sdk-example.ts          # Runnable SDK example (sandbox-safe)
│   ├── plan-remote-repo.ts     # Plan against a repo without cloning it
│   ├── generate-icons.ts       # Regenerates the PWA + macOS icons (no image deps)
│   ├── lib/
│   │   ├── plan-remote.ts      # planRemoteRepo() — lazy-hydration sessions
│   │   ├── plan-baked.ts       # planBakedRepo() — baked-checkout sessions
│   │   ├── run-session.ts      # runSession(): shared SDK query setup for both
│   │   ├── plan-capture.ts     # plansDirectory setting + plan-capture hook
│   │   ├── blobless-clone.ts   # Internal: blob-less clone helper
│   │   ├── child-env.ts        # Internal: sandbox auth env fixups
│   │   ├── runtime-paths.ts    # Internal: preload/native binary paths (packaged override)
│   │   └── spawn-vfs.ts        # Internal: SDK spawn fn with BUN_OPTIONS preloads
│   ├── child-env.test.ts       # Bun test suite (sandbox env fixups)
│   ├── session-plumbing.test.ts # Bun test suite (preload env, plan capture)
│   ├── vfs-virtual.test.ts     # Bun test suite (legacy plan-file VFS)
│   └── vfs-hydrate.test.ts     # Bun test suite (hydrating VFS, offline)
└── web/
    ├── server.ts               # Standalone CLI entry for the server
    ├── index.html              # Vite entry
    ├── lib/
    │   ├── server.ts           # Bun HTTP + WebSocket server (embeddable)
    │   ├── protocol.ts         # Browser <-> server message types
    │   ├── validate.ts         # Validation of untrusted browser messages
    │   ├── bash-policy.ts      # Bash command policy + hydration guidance
    │   ├── pricing.ts          # Public token pricing for cost estimates
    │   └── session.ts          # ClaudeSession: SDK <-> browser bridge
    ├── session.test.ts         # Bun test suite (session bridge, offline)
    ├── validate.test.ts        # Bun test suite (message validation, server)
    ├── bash-policy.test.ts     # Bun test suite (Bash policy)
    ├── public/                 # Static assets (PWA icons)
    └── src/                    # TypeScript Web Components (Vite)
        ├── main.ts             # Entry: styles, components, SW registration
        ├── store.ts            # localStorage persistence
        ├── markdown.ts         # Minimal safe markdown renderer
        ├── styles.css
        └── components/         # cc-app, cc-feed, cc-composer, cc-diff,
                                # cc-plan-panel, cc-question-card, cc-stats-panel,
                                # cc-session-list, cc-start-form, cc-settings-panel
```

## Implementation Details

### Plan capture

`planCaptureHooks()` reports only writes of `.md` files directly inside the plans directory, comparing against both spellings of the directory (path and realpath):

```typescript
const hook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PostToolUse") return {};
  const filePath = (input.tool_input as { file_path?: unknown } | undefined)?.file_path;
  if (typeof filePath !== "string" || !filePath.endsWith(".md")) return {};
  if (!dirs.includes(path.dirname(path.resolve(filePath)))) return {};
  onPlan(readFileSync(filePath, "utf-8"), path.basename(filePath));
  return {};
};
return [{ matcher: "Write|Edit|MultiEdit", hooks: [hook] }];
```

`runSession()` appends these matchers to any caller-supplied PostToolUse hooks when `onPlan` is set. If the file can't be read right after the write, the hook reports nothing — `ExitPlanMode` still carries the plan.

### Legacy plan-file VFS

`preload/vfs-virtual.ts` maintains an in-memory `Map<string, string>` for all files under `~/.claude/plans/`, intercepting `writeFileSync`, `renameSync`, `readFileSync`, `existsSync`, `statSync`, and `unlinkSync` (returning fake `fs.Stats` for virtual files) and passing every other path through. This works against the JS CLI (SDK ≤0.2.x), where plan paths reach `fs` as plain absolute paths. The native CLI writes plan files through `/proc/self/fd/<dirfd>/...` paths the preload can't recognize, which is why sessions switched to `plansDirectory` + the [plan-capture hook](#plan-capture).

## Testing

Run the test suite with:

```bash
bun test
```

The tests verify:

1. **Hydrating VFS** - Blob-less clones list their full tree without network access, hydrate file contents on first read (exactly one `gh` call per file), preserve executable bits, and tombstone deletions. These tests run fully offline against a local fixture repo and a fake `gh` binary.
2. **Legacy plan-file VFS** - Plan files in `~/.claude/plans/` are virtualized and never touch disk; regular files pass through.
3. **Session plumbing** (`scripts/session-plumbing.test.ts`) - `BUN_OPTIONS` preload injection (including the whitespace symlink and restoring the caller's value), the `plansDirectory` choice, and the plan-capture hook reporting only Write/Edit of plan files in the plans directory.
4. **Web server** - The session bridge (`web/session.test.ts`), start/session message validation and origin checks (`web/validate.test.ts`), and the Bash policy (`web/bash-policy.test.ts`).

## Use Cases

### Real-time Plan Streaming

Stream plan content to a web UI as Claude writes it:

```typescript
const { session } = planRemoteRepo({
  repo: "owner/repo",
  prompt: "Create a plan for ...",
  onPlan: (content, filename) => {
    webSocket.send(JSON.stringify({ type: "plan_update", filename, content }));
  },
});
```

### Plan Analytics

Track plan evolution over time:

```typescript
const planHistory: string[] = [];

const { session } = planRemoteRepo({
  repo: "owner/repo",
  prompt: "Create a plan for ...",
  onPlan: (content) => planHistory.push(content),
});
```

### Multi-session Plans

Keep multiple planning sessions isolated — each session's plans live in its own workspace's `.git/cc-planner-plans`, and each session's plan-capture hook (and so its `onPlan` callback) is scoped to that session:

```typescript
const sessions = new Map<string, Map<string, string>>();

function onPlanFor(sessionId: string) {
  return (content: string, filename: string) => {
    const sessionPlans = sessions.get(sessionId) || new Map();
    sessionPlans.set(filename, content);
    sessions.set(sessionId, sessionPlans);
  };
}
```

## License

MIT
