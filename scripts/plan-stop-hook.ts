/**
 * Claude Code Stop hook for interactive plan-only sessions, registered by
 * scripts/claude-vfs.ts. An approved plan ends the session (see
 * plan-approved-hook.ts), so any stop before that means Claude answered
 * without submitting a plan: block once and send it back to write one.
 * The retry (stop_hook_active) is always allowed, so this can't loop.
 */

import { stopDecision } from "./lib/plan-workflow";

const input = JSON.parse(await Bun.stdin.text()) as { stop_hook_active?: boolean };
console.log(JSON.stringify(stopDecision(false, input.stop_hook_active === true)));
