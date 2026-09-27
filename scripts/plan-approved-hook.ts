/**
 * Claude Code PostToolUse hook for ExitPlanMode, registered by
 * scripts/claude-vfs.ts. PostToolUse only fires once the tool call was
 * allowed — i.e. the user approved the plan — so this is where a
 * cc-planner session ends: the approved plan is the deliverable.
 *
 * Writes the plan to $CC_PLANNER_APPROVED_FILE (the launcher watches for it
 * and shuts the CLI down) and tells Claude to stop before implementing.
 */

import { writeFileSync } from "fs";

const input = JSON.parse(await Bun.stdin.text()) as {
  tool_input?: { plan?: unknown };
};

const plan = typeof input.tool_input?.plan === "string" ? input.tool_input.plan : "";
const approvedFile = process.env.CC_PLANNER_APPROVED_FILE;
if (approvedFile) writeFileSync(approvedFile, plan);

console.log(
  JSON.stringify({
    continue: false,
    stopReason: "Plan approved — cc-planner sessions end at plan approval.",
  }),
);
