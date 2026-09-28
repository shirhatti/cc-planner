/**
 * Claude Code PreToolUse hook applying the web TTY's Bash policy
 * (web/lib/bash-policy.ts) to plain CLI sessions on a lazily-hydrated
 * workspace — scripts/claude-vfs.ts registers it via --settings.
 *
 * Reads the hook payload on stdin. For read-only commands (git ls-tree,
 * git log, ...) it answers "allow" so no permission prompt appears; for
 * VFS-hostile ones (find, cat <file>, git grep) it answers "deny" with
 * guidance; otherwise it prints nothing and the normal permission flow
 * decides.
 */

import { evaluateBashCommand } from "../web/lib/bash-policy";

const input = JSON.parse(await Bun.stdin.text()) as {
  tool_name?: string;
  tool_input?: { command?: unknown };
};

if (input.tool_name === "Bash") {
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  const policy = evaluateBashCommand(command, { hydrating: true });
  if (policy.verdict !== "ask") {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: policy.verdict,
          permissionDecisionReason: policy.reason,
        },
      }),
    );
  }
}
