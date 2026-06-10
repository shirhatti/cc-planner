/**
 * Tests for the web session bridge (web/lib/session.ts) using a fake
 * session runner — no claude process, no network.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionEvent } from "./lib/protocol";
import {
  gatewayEnv,
  PlanSession,
  resolveRepoMode,
  summarizeToolInput,
  type RunnerResult,
  type SessionRunner,
} from "./lib/session";

const QUESTIONS = [
  {
    question: "Which database?",
    header: "Database",
    options: [
      { label: "Postgres", description: "relational" },
      { label: "Redis", description: "key-value" },
    ],
  },
];

function toolOptions(toolUseID: string): { toolUseID: string; signal: AbortSignal } {
  return { toolUseID, signal: new AbortController().signal };
}

/** Builds a runner whose "session" just runs `body` and yields its messages. */
function fakeRunner(
  body: (args: Parameters<SessionRunner>[0]) => AsyncGenerator<SDKMessage, void>,
  extras?: Partial<RunnerResult>,
): SessionRunner {
  return (args) => ({ session: body(args), repo: "owner/repo", ref: "abc123def456", ...extras });
}

describe("gatewayEnv", () => {
  test("returns nothing without overrides", () => {
    expect(gatewayEnv()).toEqual({});
    expect(gatewayEnv({ baseUrl: "  ", authToken: "" })).toEqual({});
  });

  test("maps base URL and bearer token to env vars", () => {
    expect(gatewayEnv({ baseUrl: " https://gw.example.com ", authToken: "tok" })).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      ANTHROPIC_AUTH_TOKEN: "tok",
    });
  });
});

describe("resolveRepoMode", () => {
  test("lazy when no baked repo is configured", () => {
    expect(resolveRepoMode({}).mode).toBe("lazy");
    expect(resolveRepoMode({ CC_BAKED_REPO_PATH: "/does/not/exist" }).mode).toBe("lazy");
  });

  test("baked when CC_BAKED_REPO_PATH exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cc-baked-"));
    try {
      const mode = resolveRepoMode({ CC_BAKED_REPO_PATH: dir, CC_BAKED_REPO: "owner/repo" });
      expect(mode).toEqual({ mode: "baked", root: dir, repo: "owner/repo", ref: "local" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("summarizeToolInput", () => {
  test("picks the most descriptive string field", () => {
    expect(summarizeToolInput({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeToolInput({ pattern: "foo.*" })).toBe("foo.*");
    expect(summarizeToolInput({ count: 3 })).toBe("");
  });

  test("truncates long values", () => {
    const long = "x".repeat(200);
    expect(summarizeToolInput({ command: long })).toHaveLength(120);
  });
});

describe("PlanSession", () => {
  test("AskUserQuestion round-trips answers from the browser", async () => {
    const results: PermissionResult[] = [];
    const sent: SessionEvent[] = [];
    const runner = fakeRunner(async function* (args) {
      results.push(
        await args.canUseTool("AskUserQuestion", { questions: QUESTIONS }, toolOptions("tu_1")),
      );
      yield* [] as SDKMessage[];
    });

    const session: PlanSession = new PlanSession((msg) => {
      sent.push(msg);
      if (msg.type === "ask_user_question") {
        expect(msg.id).toBe("tu_1");
        expect(msg.questions).toEqual(QUESTIONS);
        session.handleClientMessage({
          type: "answer_question",
          sessionId: "s1",
          id: msg.id,
          answers: { "Which database?": "Postgres" },
        });
      }
    }, runner);

    await session.start({ prompt: "plan something" });

    expect(results).toEqual([
      {
        behavior: "allow",
        updatedInput: { questions: QUESTIONS, answers: { "Which database?": "Postgres" } },
      },
    ]);
    expect(sent.at(-1)?.type).toBe("session_done");
  });

  test("plan approval allows ExitPlanMode and interrupts the session", async () => {
    const results: PermissionResult[] = [];
    const sent: SessionEvent[] = [];
    let interrupted = false;

    const runner: SessionRunner = (args) => {
      const gen = (async function* () {
        results.push(
          await args.canUseTool("ExitPlanMode", { allowedPrompts: [] }, toolOptions("tu_2")),
        );
        yield undefined as unknown as SDKMessage;
      })() as RunnerResult["session"];
      gen.interrupt = async () => {
        interrupted = true;
      };
      return { session: gen, repo: "owner/repo", ref: "abc123def456" };
    };

    const session: PlanSession = new PlanSession((msg) => {
      sent.push(msg);
      if (msg.type === "plan_review") {
        session.handleClientMessage({
          type: "plan_decision",
          sessionId: "s1",
          id: msg.id,
          approved: true,
        });
      }
    }, runner);

    await session.start({ prompt: "plan something" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(results[0]?.behavior).toBe("allow");
    expect(interrupted).toBe(true);
    expect(sent.some((m) => m.type === "plan_decided" && m.approved)).toBe(true);
  });

  test("plan rejection denies ExitPlanMode with the user's feedback", async () => {
    const results: PermissionResult[] = [];
    const runner = fakeRunner(async function* (args) {
      results.push(await args.canUseTool("ExitPlanMode", {}, toolOptions("tu_3")));
      yield* [] as SDKMessage[];
    });

    const session: PlanSession = new PlanSession((msg) => {
      if (msg.type === "plan_review") {
        session.handleClientMessage({
          type: "plan_decision",
          sessionId: "s1",
          id: msg.id,
          approved: false,
          feedback: "Add a rollout section",
        });
      }
    }, runner);

    await session.start({ prompt: "plan something" });
    expect(results[0]).toEqual({ behavior: "deny", message: "Add a rollout section" });
  });

  test("plan injected into ExitPlanMode input is surfaced before the review", async () => {
    const sent: SessionEvent[] = [];
    const runner = fakeRunner(async function* (args) {
      await args.canUseTool(
        "ExitPlanMode",
        { plan: "# Injected Plan", filePath: "/root/.claude/plans/witty-name.md" },
        toolOptions("tu_6"),
      );
      yield* [] as SDKMessage[];
    });

    const session: PlanSession = new PlanSession((msg) => {
      sent.push(msg);
      if (msg.type === "plan_review") {
        session.handleClientMessage({
          type: "plan_decision",
          sessionId: "s1",
          id: msg.id,
          approved: false,
          feedback: "no",
        });
      }
    }, runner);

    await session.start({ prompt: "p" });

    const planIdx = sent.findIndex((m) => m.type === "plan_update");
    const reviewIdx = sent.findIndex((m) => m.type === "plan_review");
    expect(sent[planIdx]).toEqual({
      type: "plan_update",
      filename: "witty-name.md",
      content: "# Injected Plan",
    });
    expect(planIdx).toBeLessThan(reviewIdx);
    expect(sent[reviewIdx]).toEqual({
      type: "plan_review",
      id: "tu_6",
      allowedPrompts: [],
      plan: "# Injected Plan",
    });
  });

  test("other tools are allowed without a browser round-trip", async () => {
    const results: PermissionResult[] = [];
    const runner = fakeRunner(async function* (args) {
      results.push(await args.canUseTool("Read", { file_path: "/x" }, toolOptions("tu_4")));
      yield* [] as SDKMessage[];
    });
    const session = new PlanSession(() => {}, runner);
    await session.start({ prompt: "p" });
    expect(results[0]).toEqual({ behavior: "allow", updatedInput: { file_path: "/x" } });
  });

  test("forwards SDK and VFS events to the browser", async () => {
    const sent: SessionEvent[] = [];
    const runner = fakeRunner(async function* (args) {
      args.onPlan("# The Plan", "plan.md");
      args.onVfsMessage({ type: "hydrate_fetch", rel: "src/a.ts", size: 10 });
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Exploring." },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/src/a.ts" } },
            { type: "tool_use", id: "t2", name: "AskUserQuestion", input: { questions: [] } },
          ],
        },
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        result: "Planned.",
        total_cost_usd: 0.12,
        duration_ms: 4200,
      } as unknown as SDKMessage;
    });

    const session = new PlanSession((msg) => sent.push(msg), runner);
    await session.start({ prompt: "p" });

    expect(sent).toContainEqual({
      type: "plan_update",
      filename: "plan.md",
      content: "# The Plan",
    });
    expect(sent).toContainEqual({ type: "hydrate_fetch", rel: "src/a.ts", size: 10 });
    expect(sent).toContainEqual({ type: "assistant_text", text: "Exploring." });
    expect(sent).toContainEqual({ type: "tool_activity", name: "Read", detail: "/src/a.ts" });
    // Interactive tools get dedicated events, not activity lines.
    expect(sent.some((m) => m.type === "tool_activity" && m.name === "AskUserQuestion")).toBe(
      false,
    );
    expect(sent).toContainEqual({
      type: "result",
      subtype: "success",
      result: "Planned.",
      costUsd: 0.12,
      durationMs: 4200,
    });
  });

  test("dispose unblocks a pending question and ends cleanly", async () => {
    const sent: SessionEvent[] = [];
    const errors: unknown[] = [];
    const runner = fakeRunner(async function* (args) {
      try {
        await args.canUseTool("AskUserQuestion", { questions: QUESTIONS }, toolOptions("tu_5"));
      } catch (err) {
        errors.push(err);
        throw err;
      }
      yield* [] as SDKMessage[];
    });

    const session: PlanSession = new PlanSession((msg) => {
      sent.push(msg);
      if (msg.type === "ask_user_question") {
        session.dispose();
      }
    }, runner);

    await session.start({ prompt: "p" });
    expect(errors).toHaveLength(1);
    expect(sent.at(-1)?.type).toBe("session_done");
  });

  test("streams live and final session stats", async () => {
    const sent: SessionEvent[] = [];
    const usage = {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    };
    const runner = fakeRunner(async function* (args) {
      args.onVfsMessage({ type: "hydrate_fetch", rel: "src/a.ts", size: 2048 });
      yield {
        type: "assistant",
        message: { model: "claude-sonnet-4-5", usage, content: [] },
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 5000,
        duration_api_ms: 4000,
        num_turns: 3,
        total_cost_usd: 0.5,
        usage,
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 40,
            costUSD: 0.5,
            webSearchRequests: 0,
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage;
    });

    const session = new PlanSession((msg) => sent.push(msg), runner);
    await session.start({ prompt: "p" });

    const statsEvents = sent.filter(
      (m): m is Extract<SessionEvent, { type: "session_stats" }> => m.type === "session_stats",
    );
    // One from the hydrate fetch, one from the assistant turn, one final.
    expect(statsEvents).toHaveLength(3);

    const expectedTotals = {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
    };

    const live = statsEvents[1].stats;
    expect(live.final).toBe(false);
    expect(live.totals).toEqual(expectedTotals);
    expect(live.byModel["claude-sonnet-4-5"]).toEqual(expectedTotals);
    expect(live.filesHydrated).toBe(1);
    expect(live.bytesFetched).toBe(2048);

    const final = statsEvents[2].stats;
    expect(final).toEqual({
      durationMs: 5000,
      apiDurationMs: 4000,
      numTurns: 3,
      costUsd: 0.5,
      totals: expectedTotals,
      byModel: { "claude-sonnet-4-5": { ...expectedTotals, costUsd: 0.5 } },
      filesHydrated: 1,
      bytesFetched: 2048,
      final: true,
    });
  });

  test("gateway auth is passed to the runner env", async () => {
    let seenEnv: Record<string, string> | undefined;
    const runner = fakeRunner(async function* (args) {
      seenEnv = args.extraEnv;
      yield* [];
    });
    const session = new PlanSession(() => {}, runner);
    await session.start({
      prompt: "p",
      auth: { baseUrl: "https://gw.example.com", authToken: "tok" },
    });
    expect(seenEnv).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      ANTHROPIC_AUTH_TOKEN: "tok",
    });
  });
});
