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
 * This example also demonstrates plan capture: planBakedRepo() runs the
 * session in plan mode on the current directory and reports each plan-file
 * write through onPlan (see lib/plan-capture.ts).
 */

import { isRemoteSandbox } from "./lib/child-env";
import { planBakedRepo } from "./lib/plan-baked";

console.log(`[sdk-example] sandbox=${isRemoteSandbox}, starting query...`);

const { session } = planBakedRepo({
  root: process.cwd(),
  prompt:
    "Create a plan for adding a --version flag to scripts/claude-vfs.ts. Do not ask clarifying questions — just write the plan.",
  onPlan: (content, filename) => {
    console.log(`[plan] updated: ${filename}`);
    console.log(`[plan] content preview: ${content.substring(0, 200)}`);
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
        msg.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
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
