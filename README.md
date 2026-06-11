# Virtual File System for Claude Code Plan Mode

Two complementary Virtual File Systems (VFS) for Claude Code's Plan Mode, both injected via Bun's `--preload`:

1. **Virtual plan files** (`preload/vfs-virtual.ts`) — plan files are kept entirely in memory and never touch disk, allowing real-time streaming of plan content via IPC.
2. **Hydrating repo files** (`preload/vfs-hydrate.ts`) — Claude Code can plan against a repo cloned with `--filter=blob:none --no-checkout` (no file contents downloaded). Files are hydrated on demand via the `gh` CLI the first time Claude reads them, so **a fully cloned repo is never needed**.

On top of this infra, `web/` provides a **general browser client for Claude Code** — multi-turn sessions, browser-side permissions, diffs, plan review — see [Web TTY](#web-tty).

## Overview

When Claude Code operates in Plan Mode, it writes plan files to `~/.claude/plans/`. This VFS intercepts all filesystem operations for that directory and virtualizes them completely in memory.

**Key Features:**

- 📁 **Complete Virtualization** - Plan files never touch disk
- 🚀 **Real-time Streaming** - Stream plan content via IPC as it's written
- 🪶 **Blob-less Clones** - Plan against any GitHub repo without downloading its contents
- 💧 **On-demand Hydration** - Repo files are fetched via `gh api` only when Claude reads them
- 🔍 **Full Transparency** - All other filesystem paths work normally
- ⚡ **Zero Overhead** - Uses Bun's `--preload` for early injection

## How It Works

Claude Code uses an atomic write pattern when creating plan files:

1. Write content to: `~/.claude/plans/plan.md.tmp.{pid}.{timestamp}`
2. Rename to final: `~/.claude/plans/plan.md`

The VFS intercepts both operations:

- **writeFileSync** - captures content and stores in memory
- **renameSync** - updates the virtual filename and broadcasts via IPC
- **readFileSync** - returns content from memory
- **existsSync** - checks virtual filesystem
- **statSync** - returns fake stats for virtual files
- **unlinkSync** - deletes from virtual filesystem

All paths outside `~/.claude/plans/` pass through to the original `fs` methods.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime installed
- Claude Code CLI installed
- API key configured in Claude Code

### Installation

```bash
bun install
```

### Run Tests

```bash
bun test
```

The suite covers both VFS layers:

1. **Virtual VFS** - Plan files never touch disk; regular files pass through
2. **Hydrating VFS** - Files in a blob-less clone are fetched on demand (tests run fully offline against a local fixture repo and a fake `gh`)

## Web TTY

`web/` is a general browser client for Claude Code — a TTY with niceties. It's decoupled from the planner: sessions are multi-turn, run in any permission mode, and every interactive tool call is handled in the browser. The cc-planner VFS infra provides its repo workspaces.

```bash
bun run build          # build the UI (Vite)
bun run start          # serve http://localhost:3000 (PORT to override)

# development: Bun server + Vite dev server (HMR, proxies /ws to :3000)
bun run start & bun run dev:ui
```

**Features**

- **Multi-turn sessions** — the first prompt starts the session; a composer sends follow-up messages (queued if a turn is running), `Stop turn` interrupts the current turn, and `End session` closes input so Claude finishes and exits. Multiple concurrent sessions multiplex over one WebSocket, each in its own claude process.
- **Permission modes** — start a session in `plan`, `default`, or `acceptEdits`. Outside plan mode, every gated tool call (Bash, Edit, Write, ...) renders as an allow / always-allow / deny card in the browser via the SDK's `canUseTool` callback.
- **Diff viewer** — Edit/Write tool activity and their permission cards render Shiki-highlighted unified diffs with [@pierre/diffs](https://diffs.com), so changes can be reviewed before they're allowed. Write diffs are computed against the current file on disk.
- **AskUserQuestion in the browser** — question cards (header chips, 2-4 options with descriptions, multi-select, free-text "Other") render inline in the session feed.
- **Plan mode + review** — the plan panel renders the plan markdown live as Claude writes it (via the plan-file VFS IPC events). When Claude calls `ExitPlanMode`, a review bar appears: approve or request changes with feedback. "End session when plan is approved" (on by default in plan mode) preserves the classic planner workflow; turn it off and approval lets Claude continue into implementation under browser-prompted permissions.
- **Session stats** — duration (ticking live), token usage by type and per model, turn count, and hydration volume. Cost is always **estimated from public Claude API token pricing** (`web/lib/pricing.ts`) and marked `~`/`(est.)`; the SDK's own cost figure is never displayed.
- **localStorage persistence** — prompts, repo metadata, status, stats, and the latest plan of every session persist in the browser (live transcripts are not persisted across reloads).
- **LLM gateway support** — set an Anthropic base URL and bearer token in the sidebar; they become `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` in the child claude process.
- **PWA** — installable, with a web manifest and an auto-updating service worker (app shell precached, hashed assets cached on demand).
- **Prompt-free read-only tools** — `Read`, `Glob`, `Grep`, `LS`, `NotebookRead`, and `TodoWrite` never require a permission prompt in any permission mode: they're answered by the VFS layer (manifest-backed listings, on-demand reads) and passed to the CLI as `allowedTools`, with a `canUseTool` short-circuit as fallback.
- **Per-session tool & prompt configuration** — the start form's _Advanced_ section takes extra always-allowed tools (including `Bash(...)` patterns like `Bash(bun test:*)`), disallowed tools (removed from the session entirely), and extra system-prompt instructions. Custom instructions are appended to the Claude Code preset system prompt (the SDK supports append only — there is no prepend) and compose with the hydration guidance on lazy workspaces.
- **Hydration-aware Bash policy** — on lazy workspaces, shell commands that fight the VFS are blocked with guidance: `tree`/`find`/`ls -R`/`du` (the tree is served from the manifest — Glob/LS see it for free), `cat`/`head`/`tail`/direct `grep` on files (subprocesses only see already-hydrated files — Read hydrates on demand), recursive `grep`/`rg` and `git grep` (which promisor-fetches every blob it searches). Read-only git metadata commands and pipeline filters (`git log | head`) are auto-allowed. Enforced by a PreToolUse hook (so it catches commands plan mode would auto-allow) plus matching guidance appended to the system prompt, which in practice steers Claude to Glob/Read before any command is attempted (`web/lib/bash-policy.ts`).

The frontend is TypeScript Web Components built with Vite (`web/src/`), typed against the shared WebSocket protocol (`web/lib/protocol.ts`).

### Repo modes

| Mode                         | Repo contents                                                              | When                                                                |
| ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Lazy hydration** (default) | Blob-less clone per session; file contents hydrated on Claude's first read | Plan against any repo without downloading it                        |
| **Baked**                    | Full clone burned into the container image at build time                   | Zero clone/hydration latency and no GitHub access needed at runtime |

Baked mode is enabled by pointing `CC_BAKED_REPO_PATH` at a checkout (plus optional `CC_BAKED_REPO=owner/repo` as a label); the Dockerfile wires this up automatically.

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

### Web architecture

```
browser (Vite + TS Web Components)  ←WebSocket→  web/server.ts (Bun.serve, serves web/dist)
  cc-app / cc-feed / cc-composer                   ClaudeSession (web/lib/session.ts)
  cc-plan-panel / cc-question-card                   ├─ InputQueue → SDK streaming input (multi-turn)
  cc-diff (@pierre/diffs) / cc-stats-panel           ├─ canUseTool → question / plan review / permission cards
  cc-session-list / cc-settings-panel                ├─ planRemoteRepo() — lazy hydration workspace
                                                     └─ planBakedRepo()  — baked workspace
```

Every session-scoped WebSocket message carries a client-generated `sessionId` (`web/lib/protocol.ts`), which is how one socket multiplexes many sessions.

## Environment Variables

All `CC_`-prefixed env vars in one place:

| Variable              | Read by                  | Default                         | Description                                                                                                                                                                                            |
| --------------------- | ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CC_BAKED_REPO_PATH`  | `web/server.ts`          | unset                           | Path to a fully checked-out repo. If the directory exists, the web app runs in **baked** mode and plans against it; otherwise it runs in **lazy hydration** mode. The Dockerfile sets this to `/repo`. |
| `CC_BAKED_REPO`       | `web/server.ts`          | unset                           | `owner/repo` label for the baked checkout, shown in the UI and session records. Set from the `BAKE_REPO` build arg by the Dockerfile.                                                                  |
| `CC_HYDRATE_ROOT`     | `preload/vfs-hydrate.ts` | unset (preload is inert)        | Path of the blob-less working tree to hydrate into.                                                                                                                                                    |
| `CC_HYDRATE_REPO`     | `preload/vfs-hydrate.ts` | parsed from the `origin` remote | `owner/repo` used for `gh api` content fetches.                                                                                                                                                        |
| `CC_HYDRATE_REF`      | `preload/vfs-hydrate.ts` | `HEAD`'s sha                    | Commit to hydrate file contents from.                                                                                                                                                                  |
| `CC_HYDRATE_STRATEGY` | `preload/vfs-hydrate.ts` | `gh`                            | How contents are fetched: `gh` (GitHub contents API) or `git` (promisor lazy fetch). See [Hydration Strategies](#hydration-strategies).                                                                |

The `CC_HYDRATE_*` vars are set automatically by `planRemoteRepo()` for the child claude process — you only set them yourself when wiring up `preload/vfs-hydrate.ts` manually (see [Configuration](#configuration)). The `CC_BAKED_*` vars configure the web server's repo mode and are normally set by the Dockerfile.

## Usage Example

Use the VFS with the Claude Agent SDK by providing a custom spawn function:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "child_process";
import path from "path";

const VFS_SCRIPT = path.join(__dirname, "preload", "vfs-virtual.ts");

// CRITICAL: Unset CLAUDECODE to allow nested sessions
delete process.env.CLAUDECODE;

const session = query({
  prompt: "Create a plan for building a REST API",
  options: {
    permissionMode: "plan",
    executable: "bun",
    cwd: "/path/to/codebase",

    // Custom spawn to inject VFS preload
    spawnClaudeCodeProcess: (options) => {
      const argsWithPreload = ["--preload", VFS_SCRIPT, ...options.args];

      const proc = spawn(options.command, argsWithPreload, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        signal: options.signal,
      });

      // Listen for VFS events via IPC
      proc.on("message", (msg: any) => {
        if (msg.type === "vfs_init") {
          console.log(`VFS initialized: ${msg.plansDir}`);
        }
        if (msg.type === "plan_file_write") {
          // Real-time plan content streaming!
          console.log(`Plan updated: ${msg.filename}`);
          console.log(`Content: ${msg.content}`);
          // Stream to UI via WebSocket, SSE, etc.
        }
      });

      return {
        stdin: proc.stdin,
        stdout: proc.stdout,
        killed: proc.killed,
        exitCode: proc.exitCode,
        kill: proc.kill.bind(proc),
        on: proc.on.bind(proc),
        once: proc.once.bind(proc),
        off: proc.off.bind(proc),
      };
    },
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
2. The child claude process is started with `preload/vfs-hydrate.ts`, which builds a manifest of every file in the tree from `git ls-tree` (purely local — trees are always present in a blob-less clone).
3. Directory listings (`readdir`), existence checks (`existsSync`), and path stats are answered from the manifest with **no network access**, so Claude sees the full repo structure immediately.
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

- Content searches that spawn subprocesses (ripgrep, grep) only see files that have already been hydrated. Plan-mode exploration driven by Read/Glob/LS works fully.
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

The example at `scripts/sdk-example.ts` demonstrates this with a `buildChildEnv()` helper that conditionally applies these fixups only when running inside a sandbox, so the same code works on both a regular desktop and inside `claude.ai/code`:

```bash
bun run scripts/sdk-example.ts
```

### GitHub Access Inside the Sandbox

Sandboxes typically have no `gh` CLI and block `api.github.com` at the egress proxy, while still allowing git traffic to `github.com` (and/or routing it through a local credential-injecting proxy for the session's authorized repos). The hydrating VFS handles this automatically: `planRemoteRepo()` detects that `gh` is unavailable and falls back to the `git` hydration strategy, which fetches blobs through the same channel the blob-less clone used. No extra GitHub auth setup is needed:

```bash
bun run scripts/plan-remote-repo.ts owner/repo "Create a plan for ..."
```

## IPC Events

The VFS communicates via IPC messages:

### `vfs_init`

Sent when VFS initializes.

```typescript
{
  type: "vfs_init",
  plansDir: "/Users/you/.claude/plans",
  mode: "virtual",
  timestamp: 1234567890
}
```

### `vfs_write`

Sent when content is written (including temp files).

```typescript
{
  type: "vfs_write",
  path: "/Users/you/.claude/plans/plan.md.tmp.123.456",
  filename: "plan.md.tmp.123.456",
  content: "# Plan Content",
  size: 123,
  timestamp: 1234567890
}
```

### `plan_file_write`

Sent when a plan file is finalized (after rename).

```typescript
{
  type: "plan_file_write",
  path: "/Users/you/.claude/plans/plan.md",
  filename: "plan.md",
  content: "# Plan Content",
  size: 123,
  timestamp: 1234567890
}
```

### `vfs_read`

Sent when a virtual file is read.

```typescript
{
  type: "vfs_read",
  path: "/Users/you/.claude/plans/plan.md",
  filename: "plan.md",
  size: 123,
  timestamp: 1234567890
}
```

### `vfs_unlink`

Sent when a virtual file is deleted.

```typescript
{
  type: "vfs_unlink",
  path: "/Users/you/.claude/plans/plan.md",
  filename: "plan.md",
  timestamp: 1234567890
}
```

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

## Project Structure

```
cc-planner/
├── package.json
├── tsconfig.json
├── vite.config.ts              # Vite build + dev server (PWA plugin, /ws proxy)
├── README.md
├── Dockerfile                  # Web TTY image; BAKE_REPO arg bakes a repo in
├── preload/
│   ├── vfs-virtual.ts          # In-memory VFS for plan files
│   └── vfs-hydrate.ts          # On-demand hydration over blob-less clones
├── scripts/
│   ├── sdk-example.ts          # Runnable SDK example (sandbox-safe)
│   ├── plan-remote-repo.ts     # Plan against a repo without cloning it
│   ├── generate-icons.ts       # Regenerates the PWA icons (no image deps)
│   ├── lib/
│   │   ├── plan-remote.ts      # planRemoteRepo() — lazy-hydration sessions
│   │   ├── plan-baked.ts       # planBakedRepo() — baked-checkout sessions
│   │   ├── blobless-clone.ts   # Internal: blob-less clone helper
│   │   ├── child-env.ts        # Internal: sandbox auth env fixups
│   │   └── spawn-vfs.ts        # Internal: SDK spawn fn with preloads
│   ├── vfs-virtual.test.ts     # Bun test suite (plan-file VFS)
│   └── vfs-hydrate.test.ts     # Bun test suite (hydrating VFS, offline)
└── web/
    ├── server.ts               # Bun HTTP + WebSocket server (serves dist/)
    ├── index.html              # Vite entry
    ├── lib/
    │   ├── protocol.ts         # Browser <-> server message types
    │   ├── pricing.ts          # Public token pricing for cost estimates
    │   └── session.ts          # ClaudeSession: SDK <-> browser bridge
    ├── session.test.ts         # Bun test suite (session bridge, offline)
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

### Virtual Filesystem

The VFS maintains an in-memory `Map<string, string>` for all plan files:

```typescript
const virtualFiles = new Map<string, string>();

function isVirtualPath(filePath: string): boolean {
  const normalized = path.resolve(filePath);
  return normalized.startsWith(PLANS_DIR);
}

fs.writeFileSync = function (filePath, data, options) {
  if (isVirtualPath(filePath)) {
    const content = typeof data === "string" ? data : data?.toString("utf-8");
    virtualFiles.set(path.resolve(filePath), content);
    process.send({ type: "vfs_write", content, ... });
    return; // Don't touch disk!
  }
  return orig.writeFileSync.call(this, filePath, data, options);
};
```

### Atomic Writes

Claude Code's atomic write pattern ensures consistency:

1. **Write temp file**: Content is stored in virtual filesystem
2. **Rename to final**: Map key is updated, final event is broadcast

```typescript
const tempFileContents = new Map<string, string>();

// Capture temp file writes
fs.writeFileSync = function (filePath, data, options) {
  if (isVirtualPath(filePath) && filePath.includes(".md.tmp.")) {
    tempFileContents.set(filePath, content);
  }
  // ... store in virtualFiles
};

// Finalize on rename
fs.renameSync = function (oldPath, newPath) {
  if (isVirtualPath(newPath)) {
    const content = virtualFiles.get(oldPath);
    virtualFiles.delete(oldPath);
    virtualFiles.set(newPath, content);
    process.send({ type: "plan_file_write", content, ... });
  }
};
```

### Fake Stats

The VFS returns realistic `fs.Stats` objects for virtual files:

```typescript
fs.statSync = function (filePath, options) {
  if (isVirtualPath(filePath)) {
    const content = virtualFiles.get(path.resolve(filePath));
    if (!content) throw ENOENT;

    return {
      size: content.length,
      isFile: () => true,
      isDirectory: () => false,
      // ... other stat properties
    };
  }
  return orig.statSync.call(this, filePath, options);
};
```

## Testing

Run the test suite with:

```bash
bun test
```

The tests verify:

1. **Virtual VFS** - Plan files in `~/.claude/plans/` are completely virtualized and never touch disk
2. **Passthrough** - Regular files outside `~/.claude/plans/` work normally and are written to disk
3. **Hydrating VFS** - Blob-less clones list their full tree without network access, hydrate file contents on first read (exactly one `gh` call per file), preserve executable bits, tombstone deletions, and compose with the plan-file VFS. These tests run fully offline against a local fixture repo and a fake `gh` binary.

## Use Cases

### Real-time Plan Streaming

Stream plan content to a web UI as Claude writes it:

```typescript
proc.on("message", (msg) => {
  if (msg.type === "plan_file_write") {
    webSocket.send(
      JSON.stringify({
        type: "plan_update",
        content: msg.content,
      }),
    );
  }
});
```

### Plan Analytics

Track plan evolution over time without disk I/O:

```typescript
const planHistory: string[] = [];

proc.on("message", (msg) => {
  if (msg.type === "vfs_write") {
    planHistory.push(msg.content);
  }
});
```

### Multi-session Plans

Keep multiple planning sessions isolated in memory:

```typescript
const sessions = new Map<string, Map<string, string>>();

proc.on("message", (msg) => {
  if (msg.type === "plan_file_write") {
    const sessionPlans = sessions.get(sessionId) || new Map();
    sessionPlans.set(msg.filename, msg.content);
    sessions.set(sessionId, sessionPlans);
  }
});
```

## License

MIT
