/**
 * Keeping plan-only sessions on track. Plan mode only makes Claude
 * read-only; for requests that read like questions it may just answer and
 * stop. cc-planner sessions exist to produce an approved plan, so:
 *
 * - PLAN_WORKFLOW_INSTRUCTIONS replaces the plan-mode workflow body
 *   (SDK `planModeInstructions`; appended to the system prompt by the
 *   interactive launcher, where the CLI flag isn't available).
 * - A Stop hook blocks ending a turn before ExitPlanMode has been called,
 *   once per stop attempt (`stop_hook_active` marks the retry), so Claude
 *   is sent back to write the plan without risking a loop.
 */

export const PLAN_WORKFLOW_INSTRUCTIONS = `
This is a planning session: every request, including ones phrased as questions, ends in a written implementation plan that the user approves.
1. Explore the relevant code with read-only tools until you understand what needs to change.
2. If the request is ambiguous, ask with the AskUserQuestion tool, not in plain text, then continue planning.
3. Write the plan to the plan file: the goal and context (answer any question the user asked here), the specific files and changes, and how to verify them.
4. Call ExitPlanMode to present the plan for approval. Never end your turn without calling ExitPlanMode; if the user requests changes, revise the plan and call it again.
`.trim();

export const PLAN_REQUIRED_REASON =
  "This is a plan-only session: write the implementation plan to the plan file and call ExitPlanMode before finishing. If you need information from the user, ask with AskUserQuestion.";

/**
 * Stop-hook decision: block (sending Claude back to plan) unless the plan
 * was already submitted or this stop is itself the retry of a block.
 */
export function stopDecision(planSubmitted: boolean, stopHookActive: boolean) {
  if (planSubmitted || stopHookActive) return {};
  return { decision: "block" as const, reason: PLAN_REQUIRED_REASON };
}
