/**
 * Example: Using the Claude Agent SDK inside a Claude Code sandbox
 *
 * When the SDK spawns a child `claude` process inside a Claude Code remote
 * session (e.g., claude.ai/code), the child inherits environment variables
 * that reference parent-only file descriptors. Those FDs can't be inherited,
 * so the child crashes immediately.
 *
 * The fix: read the session ingress token from disk and pass it via
 * ANTHROPIC_AUTH_TOKEN, then strip the env vars that reference parent-only
 * resources. On a regular desktop this is a no-op. See lib/child-env.ts.
 *
 * This example also demonstrates the VFS preload for plan mode.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "path";
import { fileURLToPath } from "url";
import { buildChildEnv, isRemoteSandbox } from "./lib/child-env";
import { makeSpawnWithPreloads, type VfsMessage } from "./lib/spawn-vfs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VFS_SCRIPT = path.join(__dirname, "..", "preload", "vfs-virtual.ts");

const childEnv = buildChildEnv();

console.log(`[sdk-example] sandbox=${isRemoteSandbox}, starting query...`);

function handleVfsMessage(msg: VfsMessage): void {
  if (msg.type === "vfs_init") {
    console.log(`[vfs] initialized: ${msg.plansDir}`);
  }
  if (msg.type === "plan_file_write") {
    console.log(`[vfs] plan updated: ${msg.filename}`);
    console.log(`[vfs] content preview: ${String(msg.content).substring(0, 200)}`);
  }
}

const session = query({
  prompt:
    "Create a plan for adding a new IPC message type called 'vfs_stats' that returns the count and total size of all virtual files. Do not ask clarifying questions — just write the plan.",
  options: {
    env: childEnv,
    permissionMode: "plan",
    executable: "bun",
    cwd: process.cwd(),
    spawnClaudeCodeProcess: makeSpawnWithPreloads([VFS_SCRIPT], handleVfsMessage),
  },
});

// Process SDK events
for await (const msg of session) {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        console.log(`[sdk] session initialized (model=${msg.model})`);
      }
      break;
    case "assistant":
      console.log(
        `[sdk] assistant:`,
        msg.message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(""),
      );
      break;
    case "result":
      if (msg.subtype === "success") {
        console.log(`[sdk] done — result: ${msg.result}`);
      } else {
        console.error(`[sdk] error: ${msg.subtype}`, "errors" in msg ? msg.errors : "");
      }
      break;
  }
}
