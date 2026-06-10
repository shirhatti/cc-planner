/**
 * Example: plan against a GitHub repo WITHOUT a full clone.
 *
 * All the machinery (blob-less clone, on-demand hydration via `gh`,
 * in-memory plan files) is an internal detail of planRemoteRepo() —
 * just point it at a repo and give it a prompt.
 *
 * Usage:
 *   bun run scripts/plan-remote-repo.ts <owner/repo> [prompt...]
 */

import { planRemoteRepo } from "./lib/plan-remote";

const [repoArg, ...promptParts] = process.argv.slice(2);
if (!repoArg) {
  console.error("Usage: bun run scripts/plan-remote-repo.ts <owner/repo> [prompt...]");
  process.exit(1);
}
const prompt =
  promptParts.join(" ") ||
  "Explore this codebase and create a plan for improving its test coverage. " +
    "Do not ask clarifying questions — just write the plan.";

const { session, root, ref } = planRemoteRepo({
  repo: repoArg,
  prompt,
  onPlan: (content, filename) => {
    console.log(`\n===== PLAN (${filename}) =====\n${content}\n=====\n`);
  },
  onVfsMessage: (msg) => {
    switch (msg.type) {
      case "hydrate_init":
        console.log(`[hydrate] ready: ${msg.files} files in manifest @ ${msg.ref}`);
        break;
      case "hydrate_fetch":
        console.log(`[hydrate] fetched ${msg.rel} (${msg.size} bytes)`);
        break;
      case "hydrate_error":
        console.error(`[hydrate] error fetching ${msg.rel}: ${msg.error}`);
        break;
    }
  },
});

console.log(`[plan] planning against ${repoArg}@${ref.slice(0, 12)} (workdir: ${root})`);

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
