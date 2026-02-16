# Virtual File System for Claude Code Plan Mode

A complete in-memory Virtual File System (VFS) for Claude Code's Plan Mode. Plan files are kept entirely in memory and never touch disk, allowing real-time streaming of plan content via IPC.

## Overview

When Claude Code operates in Plan Mode, it writes plan files to `~/.claude/plans/`. This VFS intercepts all filesystem operations for that directory and virtualizes them completely in memory.

**Key Features:**
- 📁 **Complete Virtualization** - Plan files never touch disk
- 🚀 **Real-time Streaming** - Stream plan content via IPC as it's written
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

This runs two tests:
1. **Virtual VFS Test** - Verifies plan files never touch disk
2. **Passthrough Test** - Verifies regular files work normally

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

## Project Structure

```
cc-planner/
├── package.json
├── tsconfig.json
├── README.md
├── preload/
│   └── vfs-virtual.ts          # Virtual filesystem implementation
└── scripts/
    └── vfs-virtual.test.ts     # Bun test suite
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

Expected output:
```
bun test v1.3.3
 2 pass
 0 fail
 11 expect() calls
Ran 2 tests across 1 file. [339.00ms]
```

## Use Cases

### Real-time Plan Streaming
Stream plan content to a web UI as Claude writes it:

```typescript
proc.on("message", (msg) => {
  if (msg.type === "plan_file_write") {
    webSocket.send(JSON.stringify({
      type: "plan_update",
      content: msg.content,
    }));
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
