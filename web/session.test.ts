/**
 * Tests for the web session bridge (web/lib/session.ts) using a fake
 * session runner — no claude process, no network.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { estimateModelCostUsd, priceForModel } from "./lib/pricing";
import type { SessionEvent } from "./lib/protocol";
import {
  expandHome,
  gatewayEnv,
  ClaudeSession,
  makeRunner,
  resolveRepoMode,
  summarizeToolInput,
  type RunnerArgs,
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

  test("maps an API key to ANTHROPIC_API_KEY", () => {
    expect(gatewayEnv({ apiKey: " sk-ant-key " })).toEqual({ ANTHROPIC_API_KEY: "sk-ant-key" });
    expect(gatewayEnv({ apiKey: "  " })).toEqual({});
  });
});

describe("expandHome", () => {
  test("expands a leading ~", () => {
    expect(expandHome("~")).toBe(process.env.HOME!);
    expect(expandHome("~/code/repo")).toBe(path.join(process.env.HOME!, "code", "repo"));
  });

  test("leaves absolute and relative paths alone", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("not~/expanded")).toBe("not~/expanded");
  });
});

describe("makeRunner", () => {
  const runnerArgs = (overrides: Partial<RunnerArgs>): RunnerArgs => ({
    prompt: "go",
    canUseTool: async () => ({ behavior: "deny", message: "n/a" }),
    abortController: new AbortController(),
    onPlan: () => {},
    onVfsMessage: () => {},
    ...overrides,
  });

  test("lazy mode requires a repo or local path", () => {
    const runner = makeRunner({ mode: "lazy" });
    expect(() => runner(runnerArgs({}))).toThrow(/repository .* or a local folder/);
  });

  test("a missing local path fails the session up front", () => {
    const runner = makeRunner({ mode: "lazy" });
    expect(() => runner(runnerArgs({ localPath: "/does/not/exist" }))).toThrow(/not found/);
  });

  test("local path wins over the baked default and ~ expands", () => {
    // Point the baked default somewhere else; a bogus ~ path must be the
    // error (proving precedence + expansion), not a baked session.
    const dir = mkdtempSync(path.join(tmpdir(), "cc-baked-"));
    try {
      const runner = makeRunner({ mode: "baked", root: dir, repo: "owner/repo" });
      expect(() => runner(runnerArgs({ localPath: "~/cc-does-not-exist-xyz" }))).toThrow(
        new RegExp(`${process.env.HOME!}/cc-does-not-exist-xyz`),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("pricing", () => {
  test("matches date-suffixed model IDs by longest prefix", () => {
    // claude-opus-4-8 must not fall through to the claude-opus-4 (4.0) rates
    expect(priceForModel("claude-opus-4-8")?.inputPerMTok).toBe(5);
    expect(priceForModel("claude-opus-4-20250514")?.inputPerMTok).toBe(15);
    expect(priceForModel("claude-sonnet-4-5-20250929")?.outputPerMTok).toBe(15);
    expect(priceForModel("claude-haiku-4-5-20251001")?.cacheReadPerMTok).toBeCloseTo(0.1);
    expect(priceForModel("some-gateway-model")).toBeUndefined();
  });

  test("estimates cost across token types", () => {
    // Sonnet 4.5: $3 in, $15 out, $0.30 cache read, $3.75 cache write per MTok
    const cost = estimateModelCostUsd("claude-sonnet-4-5-20250929", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75);
    expect(
      estimateModelCostUsd("some-gateway-model", {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBeUndefined();
  });
});

describe("ClaudeSession", () => {
  test("AskUserQuestion round-trips answers from the browser", async () => {
    const results: PermissionResult[] = [];
    const sent: SessionEvent[] = [];
    const runner = fakeRunner(async function* (args) {
      results.push(
        await args.canUseTool("AskUserQuestion", { questions: QUESTIONS }, toolOptions("tu_1")),
      );
      yield* [] as SDKMessage[];
    });

    const session: ClaudeSession = new ClaudeSession((msg) => {
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

    const session: ClaudeSession = new ClaudeSession((msg) => {
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

    const session: ClaudeSession = new ClaudeSession((msg) => {
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

    const session: ClaudeSession = new ClaudeSession((msg) => {
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

  test("plan approval without stopOnPlanApproval lets the session continue", async () => {
    const results: PermissionResult[] = [];
    const sent: SessionEvent[] = [];
    let interrupted = false;

    const runner: SessionRunner = (args) => {
      const gen = (async function* () {
        results.push(
          await args.canUseTool("ExitPlanMode", { allowedPrompts: [] }, toolOptions("tu_c")),
        );
        yield* [] as SDKMessage[];
      })() as RunnerResult["session"];
      gen.interrupt = async () => {
        interrupted = true;
      };
      return { session: gen, repo: "owner/repo", ref: "abc123def456" };
    };

    const session: ClaudeSession = new ClaudeSession((msg) => {
      sent.push(msg);
      if (msg.type === "plan_review") {
        session.handleClientMessage({
          type: "plan_decision",
          sessionId: "s1",
          id: msg.id,
          approved: true,
        });
        session.handleClientMessage({ type: "end_session", sessionId: "s1" });
      }
    }, runner);

    await session.start({ prompt: "p", mode: "plan", stopOnPlanApproval: false });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(results[0]?.behavior).toBe("allow");
    expect(interrupted).toBe(false);
    expect(sent.some((m) => m.type === "plan_decided" && m.approved)).toBe(true);
  });

  test("gated tools become browser permission requests", async () => {
    const results: PermissionResult[] = [];
    const sent: SessionEvent[] = [];
    const runner = fakeRunner(async function* (args) {
      results.push(await args.canUseTool("Bash", { command: "bun test" }, toolOptions("tu_a")));
      results.push(
        await args.canUseTool(
          "Edit",
          { file_path: "/src/a.ts", old_string: "foo", new_string: "bar" },
          toolOptions("tu_b"),
        ),
      );
      results.push(await args.canUseTool("Bash", { command: "rm -rf /" }, toolOptions("tu_d")));
      yield* [] as SDKMessage[];
    });

    const session: ClaudeSession = new ClaudeSession((msg) => {
      sent.push(msg);
      if (msg.type !== "permission_request") return;
      if (msg.id === "tu_a") {
        session.handleClientMessage({
          type: "permission_decision",
          sessionId: "s1",
          id: msg.id,
          allow: true,
        });
      } else if (msg.id === "tu_b") {
        // Edit permission requests carry a reviewable diff.
        expect(msg.diff).toEqual({ filePath: "/src/a.ts", oldText: "foo", newText: "bar" });
        session.handleClientMessage({
          type: "permission_decision",
          sessionId: "s1",
          id: msg.id,
          allow: true,
          always: true,
        });
      } else {
        session.handleClientMessage({
          type: "permission_decision",
          sessionId: "s1",
          id: msg.id,
          allow: false,
        });
      }
    }, runner);

    await session.start({ prompt: "p", mode: "default" });

    expect(results[0]).toEqual({
      behavior: "allow",
      updatedInput: { command: "bun test" },
      updatedPermissions: undefined,
    });
    expect(results[1]).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/src/a.ts", old_string: "foo", new_string: "bar" },
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Edit" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });
    expect(results[2]).toEqual({ behavior: "deny", message: "The user denied this tool call." });
  });

  test("hydrating workspaces enforce the Bash policy and append guidance", async () => {
    const sent: SessionEvent[] = [];
    const results: PermissionResult[] = [];
    let appendedPrompt: string | undefined;

    const runner: SessionRunner = (args) => {
      appendedPrompt = args.appendSystemPrompt;
      const gen = (async function* () {
        // Tree walker: auto-denied with guidance, no browser round-trip.
        results.push(
          await args.canUseTool("Bash", { command: "find . -name x" }, toolOptions("b1")),
        );
        // Safe metadata command: auto-allowed, no browser round-trip.
        results.push(
          await args.canUseTool("Bash", { command: "git log --oneline" }, toolOptions("b2")),
        );
        // Anything else: normal permission card.
        results.push(await args.canUseTool("Bash", { command: "bun test" }, toolOptions("b3")));
        yield* [] as SDKMessage[];
      })() as RunnerResult["session"];
      return { session: gen, repo: "owner/repo", ref: "abc123def456" };
    };

    const session: ClaudeSession = new ClaudeSession(
      (msg) => {
        sent.push(msg);
        if (msg.type === "permission_request") {
          expect(msg.id).toBe("b3");
          session.handleClientMessage({
            type: "permission_decision",
            sessionId: "s1",
            id: msg.id,
            allow: true,
          });
        }
      },
      runner,
      { hydratingWorkspace: true },
    );

    await session.start({ prompt: "p" });

    expect(appendedPrompt).toContain("blob-less git clone");
    expect(results[0].behavior).toBe("deny");
    expect(results[0]).toMatchObject({ behavior: "deny" });
    expect(sent.some((m) => m.type === "notice" && m.text.includes("find"))).toBe(true);
    expect(results[1]).toEqual({
      behavior: "allow",
      updatedInput: { command: "git log --oneline" },
    });
    expect(results[2].behavior).toBe("allow");
    // Only the "ask" command produced a permission card.
    expect(sent.filter((m) => m.type === "permission_request")).toHaveLength(1);
  });

  test("PreToolUse hook gates Bash even when the permission system would auto-allow", async () => {
    // Plan mode auto-allows read-only Bash without consulting canUseTool, so
    // the policy must also be enforced through a PreToolUse hook.
    const sent: SessionEvent[] = [];
    const hookOutputs: unknown[] = [];

    const runner: SessionRunner = (args) => {
      const gen = (async function* () {
        const hook = args.hooks?.PreToolUse?.[0]?.hooks[0];
        expect(args.hooks?.PreToolUse?.[0]?.matcher).toBe("Bash");
        expect(hook).toBeDefined();
        const signal = new AbortController().signal;
        const base = {
          hook_event_name: "PreToolUse" as const,
          session_id: "x",
          transcript_path: "/t",
          cwd: "/w",
          tool_name: "Bash",
        };
        hookOutputs.push(
          await hook!(
            { ...base, tool_input: { command: "find . -name x" }, tool_use_id: "h1" },
            "h1",
            { signal },
          ),
        );
        hookOutputs.push(
          await hook!({ ...base, tool_input: { command: "git log" }, tool_use_id: "h2" }, "h2", {
            signal,
          }),
        );
        hookOutputs.push(
          await hook!({ ...base, tool_input: { command: "bun test" }, tool_use_id: "h3" }, "h3", {
            signal,
          }),
        );
        yield* [] as SDKMessage[];
      })() as RunnerResult["session"];
      return { session: gen, repo: "owner/repo", ref: "abc123def456" };
    };

    const session = new ClaudeSession((msg) => sent.push(msg), runner, {
      hydratingWorkspace: true,
    });
    await session.start({ prompt: "p" });

    expect(hookOutputs[0]).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(hookOutputs[1]).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
    expect(hookOutputs[2]).toEqual({});
    expect(sent.some((m) => m.type === "notice" && m.text.includes("find"))).toBe(true);
  });

  test("subagent prompts get the hydration guidance injected via the Task hook", async () => {
    const hookOutputs: unknown[] = [];
    const runner: SessionRunner = (args) => {
      const gen = (async function* () {
        const matchers = args.hooks?.PreToolUse ?? [];
        const taskHook = matchers.find((m) => m.matcher === "Task")?.hooks[0];
        expect(taskHook).toBeDefined();
        const signal = new AbortController().signal;
        hookOutputs.push(
          await taskHook!(
            {
              hook_event_name: "PreToolUse",
              session_id: "x",
              transcript_path: "/t",
              cwd: "/w",
              tool_name: "Task",
              tool_input: { description: "explore", prompt: "Find OTel usage." },
              tool_use_id: "t1",
            },
            "t1",
            { signal },
          ),
        );
        yield* [] as SDKMessage[];
      })() as RunnerResult["session"];
      return { session: gen, repo: "owner/repo", ref: "abc123def456" };
    };

    const session = new ClaudeSession(() => {}, runner, { hydratingWorkspace: true });
    await session.start({ prompt: "p" });

    const output = hookOutputs[0] as {
      hookSpecificOutput?: { updatedInput?: { prompt?: string } };
    };
    const prompt = output.hookSpecificOutput?.updatedInput?.prompt ?? "";
    expect(prompt.startsWith("Find OTel usage.")).toBe(true);
    expect(prompt).toContain("blob-less git clone");
  });

  test("baked workspaces auto-allow read-only Bash with no card or denial", async () => {
    const sent: SessionEvent[] = [];
    const results: PermissionResult[] = [];
    const runner = fakeRunner(async function* (args) {
      // The hook is installed on every workspace and auto-allows read-only
      // commands the CLI doesn't recognize (the reported git ls-tree case).
      const hook = args.hooks?.PreToolUse?.find((m) => m.matcher === "Bash")?.hooks[0];
      expect(hook).toBeDefined();
      const signal = new AbortController().signal;
      const hookOut = await hook!(
        {
          hook_event_name: "PreToolUse",
          session_id: "x",
          transcript_path: "/t",
          cwd: "/w",
          tool_name: "Bash",
          tool_input: { command: "git ls-tree -r --name-only HEAD" },
          tool_use_id: "b0",
        },
        "b0",
        { signal },
      );
      expect(hookOut).toMatchObject({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      });
      // canUseTool fallback: find is read-only on a full checkout — allowed.
      results.push(await args.canUseTool("Bash", { command: "find . -name x" }, toolOptions("b4")));
      // Mutating commands still produce a card.
      results.push(await args.canUseTool("Bash", { command: "rm -rf x" }, toolOptions("b5")));
      yield* [] as SDKMessage[];
    });
    const session: ClaudeSession = new ClaudeSession((msg) => {
      sent.push(msg);
      if (msg.type === "permission_request") {
        expect(msg.id).toBe("b5");
        session.handleClientMessage({
          type: "permission_decision",
          sessionId: "s1",
          id: msg.id,
          allow: true,
        });
      }
    }, runner);
    await session.start({ prompt: "p" });
    expect(results[0].behavior).toBe("allow");
    expect(results[1].behavior).toBe("allow");
    expect(sent.filter((m) => m.type === "permission_request")).toHaveLength(1);
    expect(sent.some((m) => m.type === "notice")).toBe(false);
  });

  test("read-only VFS tools are always allowed without a prompt", async () => {
    const sent: SessionEvent[] = [];
    const results: PermissionResult[] = [];
    let runnerArgs: Parameters<SessionRunner>[0] | undefined;
    const runner = fakeRunner(async function* (args) {
      runnerArgs = args;
      for (const tool of ["Read", "Glob", "Grep", "LS"]) {
        results.push(await args.canUseTool(tool, { file_path: "/x" }, toolOptions(`r_${tool}`)));
      }
      yield* [] as SDKMessage[];
    });

    const session = new ClaudeSession((msg) => sent.push(msg), runner);
    await session.start({ prompt: "p", mode: "default" });

    // Passed to the CLI as allowedTools (no prompt at all)...
    expect(runnerArgs?.allowedTools).toEqual(
      expect.arrayContaining(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite"]),
    );
    // ...and short-circuited in canUseTool as a fallback.
    expect(results.every((r) => r.behavior === "allow")).toBe(true);
    expect(sent.filter((m) => m.type === "permission_request")).toHaveLength(0);
  });

  test("session options merge user tool lists and system prompt append", async () => {
    let runnerArgs: Parameters<SessionRunner>[0] | undefined;
    const runner = fakeRunner(async function* (args) {
      runnerArgs = args;
      yield* [] as SDKMessage[];
    });

    const session = new ClaudeSession(() => {}, runner, { hydratingWorkspace: true });
    await session.start({
      prompt: "p",
      appendSystemPrompt: "Answer in French.",
      allowedTools: ["Bash(bun test:*)", "Read"],
      disallowedTools: ["WebSearch"],
    });

    // User allowlist merges with (and dedupes against) the read-only set.
    expect(runnerArgs?.allowedTools).toContain("Bash(bun test:*)");
    expect(runnerArgs?.allowedTools?.filter((t) => t === "Read")).toHaveLength(1);
    expect(runnerArgs?.disallowedTools).toEqual(["WebSearch"]);
    // Hydration guidance and user instructions compose in the append.
    expect(runnerArgs?.appendSystemPrompt).toContain("blob-less git clone");
    expect(runnerArgs?.appendSystemPrompt).toContain("Answer in French.");
  });

  test("user messages stream into the session until end_session", async () => {
    const received: string[] = [];
    const runner: SessionRunner = (args) => {
      const gen = (async function* () {
        const prompt = args.prompt as AsyncIterable<{ message: { content: unknown } }>;
        for await (const userMsg of prompt) {
          const content = userMsg.message.content as { type: string; text: string }[];
          received.push(content[0].text);
        }
        yield* [] as SDKMessage[];
      })() as RunnerResult["session"];
      return { session: gen, repo: "owner/repo", ref: "abc123def456" };
    };

    const session = new ClaudeSession(() => {}, runner);
    const done = session.start({ prompt: "first" });
    session.handleClientMessage({ type: "user_message", sessionId: "s1", text: "second" });
    session.handleClientMessage({ type: "end_session", sessionId: "s1" });
    await done;

    expect(received).toEqual(["first", "second"]);
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

    const session = new ClaudeSession((msg) => sent.push(msg), runner);
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
    // No modelUsage in this result → no estimate; the SDK's total_cost_usd
    // (0.12) must NOT leak through.
    expect(sent).toContainEqual({
      type: "result",
      subtype: "success",
      result: "Planned.",
      costUsd: undefined,
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

    const session: ClaudeSession = new ClaudeSession((msg) => {
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

    const session = new ClaudeSession((msg) => sent.push(msg), runner);
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
    expect(live.estimated).toBe(true);
    expect(live.totals).toEqual(expectedTotals);
    // Sonnet 4.5 estimate: (10*$3 + 20*$15 + 30*$0.30 + 40*$3.75) / 1M
    const expectedEstimate = (10 * 3 + 20 * 15 + 30 * 0.3 + 40 * 3.75) / 1e6;
    expect(live.costUsd).toBeCloseTo(expectedEstimate, 9);
    expect(live.byModel["claude-sonnet-4-5"]).toEqual({
      ...expectedTotals,
      costUsd: live.byModel["claude-sonnet-4-5"].costUsd,
    });
    expect(live.byModel["claude-sonnet-4-5"].costUsd).toBeCloseTo(expectedEstimate, 9);
    expect(live.filesHydrated).toBe(1);
    expect(live.bytesFetched).toBe(2048);

    // Final stats keep the SDK's token counts but the cost stays estimated
    // from public pricing — the SDK's total_cost_usd / costUSD (0.5) must
    // never appear.
    const final = statsEvents[2].stats;
    expect(final.estimated).toBe(true);
    expect(final.costUsd).toBeCloseTo(expectedEstimate, 9);
    expect(final.byModel["claude-sonnet-4-5"].costUsd).toBeCloseTo(expectedEstimate, 9);
    expect(final).toEqual({
      durationMs: 5000,
      apiDurationMs: 4000,
      numTurns: 3,
      costUsd: final.costUsd,
      estimated: true,
      totals: expectedTotals,
      byModel: {
        "claude-sonnet-4-5": {
          ...expectedTotals,
          costUsd: final.byModel["claude-sonnet-4-5"].costUsd,
        },
      },
      filesHydrated: 1,
      bytesFetched: 2048,
      final: true,
    });
  });

  test("repeated usage from the same API call is not double counted", async () => {
    const sent: SessionEvent[] = [];
    const usage = {
      input_tokens: 5,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    // The SDK emits one assistant message per content block, all sharing the
    // API call's message id and usage — msg_1 must be counted once.
    const runner = fakeRunner(async function* () {
      for (const id of ["msg_1", "msg_1", "msg_2"]) {
        yield {
          type: "assistant",
          message: { id, model: "claude-haiku-4-5-20251001", usage, content: [] },
        } as unknown as SDKMessage;
      }
    });
    const session = new ClaudeSession((msg) => sent.push(msg), runner);
    await session.start({ prompt: "p" });

    const last = sent
      .filter(
        (m): m is Extract<SessionEvent, { type: "session_stats" }> => m.type === "session_stats",
      )
      .at(-1);
    expect(last?.stats.totals).toEqual({
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // Haiku 4.5: (10*$1 + 10*$5) / 1M
    expect(last?.stats.costUsd).toBeCloseTo(60 / 1e6, 9);
  });

  test("gateway auth is passed to the runner env", async () => {
    let seenEnv: Record<string, string> | undefined;
    const runner = fakeRunner(async function* (args) {
      seenEnv = args.extraEnv;
      yield* [];
    });
    const session = new ClaudeSession(() => {}, runner);
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
