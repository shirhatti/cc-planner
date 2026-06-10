/**
 * PlanSession — bridges one Claude Code plan-mode session to one browser
 * WebSocket connection.
 *
 * - SDK/VFS events (assistant text, tool activity, hydration, live plan
 *   content) are forwarded to the browser as ServerMessages.
 * - canUseTool intercepts AskUserQuestion and ExitPlanMode, forwards them to
 *   the browser, and blocks until the user responds in the UI.
 * - On plan approval the session is interrupted: the approved plan is the
 *   deliverable, so Claude never proceeds to implementation.
 */

import { existsSync } from "fs";
import path from "path";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { planBakedRepo, resolveBakedRef } from "../../scripts/lib/plan-baked";
import { planRemoteRepo } from "../../scripts/lib/plan-remote";
import type { VfsMessage } from "../../scripts/lib/spawn-vfs";
import type {
  AuthConfig,
  ClientMessage,
  SessionEvent,
  SessionStats,
  TokenUsage,
  UserQuestion,
} from "./protocol";

// ---------------------------------------------------------------------------
// Repo mode: baked (full repo in the image) vs lazy (blob-less clone + hydration)
// ---------------------------------------------------------------------------

export interface RepoMode {
  mode: "baked" | "lazy";
  /** Baked mode only: path of the checked-out repo. */
  root?: string;
  /** Baked mode only: "owner/repo" label, if known. */
  repo?: string;
  /** Baked mode only: HEAD sha of the baked checkout. */
  ref?: string;
}

export function resolveRepoMode(env: Record<string, string | undefined> = process.env): RepoMode {
  const root = env.CC_BAKED_REPO_PATH;
  if (root && existsSync(root)) {
    return {
      mode: "baked",
      root,
      repo: env.CC_BAKED_REPO || undefined,
      ref: resolveBakedRef(root),
    };
  }
  return { mode: "lazy" };
}

// ---------------------------------------------------------------------------
// Session runner — injectable so tests don't spawn a real claude process
// ---------------------------------------------------------------------------

export interface RunnerArgs {
  prompt: string;
  repo?: string;
  branch?: string;
  canUseTool: CanUseTool;
  abortController: AbortController;
  onPlan: (content: string, filename: string) => void;
  onVfsMessage: (msg: VfsMessage) => void;
  extraEnv?: Record<string, string>;
}

export interface RunnerResult {
  session: AsyncIterable<SDKMessage> & { interrupt?: () => Promise<void> };
  repo: string;
  ref: string;
}

export type SessionRunner = (args: RunnerArgs) => RunnerResult;

export function makeRunner(mode: RepoMode): SessionRunner {
  if (mode.mode === "baked") {
    const root = mode.root;
    if (!root) throw new Error("baked mode requires a repo root");
    return (args) => {
      const { session, ref } = planBakedRepo({ ...args, root });
      return { session, repo: mode.repo ?? root, ref };
    };
  }
  return (args) => {
    const repo = args.repo;
    if (!repo) throw new Error('A repository ("owner/repo") is required in lazy hydration mode');
    const { session, ref } = planRemoteRepo({ ...args, repo });
    return { session, repo, ref };
  };
}

/**
 * Env overrides for routing the child claude process through an LLM gateway
 * with a custom base URL and/or bearer token.
 */
export function gatewayEnv(auth?: AuthConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (auth?.baseUrl?.trim()) env.ANTHROPIC_BASE_URL = auth.baseUrl.trim();
  if (auth?.authToken?.trim()) env.ANTHROPIC_AUTH_TOKEN = auth.authToken.trim();
  return env;
}

// ---------------------------------------------------------------------------
// PlanSession
// ---------------------------------------------------------------------------

const REJECTION_FALLBACK =
  "The user wants you to revise the plan. Stay in plan mode and update the plan file.";

/** Tools the UI renders with dedicated cards rather than the activity feed. */
const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function summarizeToolInput(input: Record<string, unknown>): string {
  for (const key of ["file_path", "pattern", "command", "path", "query", "description", "url"]) {
    const value = input[key];
    if (typeof value === "string" && value) {
      return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Session statistics
// ---------------------------------------------------------------------------

/** Raw per-API-call usage as reported on SDK messages (snake_case). */
interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export function usageFromRaw(raw: RawUsage | undefined): TokenUsage {
  return {
    inputTokens: raw?.input_tokens ?? 0,
    outputTokens: raw?.output_tokens ?? 0,
    cacheReadTokens: raw?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: raw?.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(target: TokenUsage, delta: TokenUsage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheCreationTokens += delta.cacheCreationTokens;
}

interface PendingRequest {
  resolve: (msg: ClientMessage) => void;
  reject: (err: Error) => void;
}

export class PlanSession {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly abort = new AbortController();
  private session?: RunnerResult["session"];
  private started = false;
  private planApproved = false;
  private startedAt = 0;
  private readonly liveTotals = emptyUsage();
  private readonly liveByModel = new Map<string, TokenUsage>();
  private filesHydrated = 0;
  private bytesFetched = 0;

  constructor(
    private readonly send: (msg: SessionEvent) => void,
    private readonly runner: SessionRunner,
  ) {}

  async start(req: {
    prompt: string;
    repo?: string;
    branch?: string;
    auth?: AuthConfig;
  }): Promise<void> {
    if (this.started) {
      this.send({ type: "error", message: "A session is already running on this connection" });
      return;
    }
    this.started = true;
    this.startedAt = Date.now();

    try {
      const { session, repo, ref } = this.runner({
        prompt: req.prompt,
        repo: req.repo,
        branch: req.branch,
        extraEnv: gatewayEnv(req.auth),
        canUseTool: this.canUseTool,
        abortController: this.abort,
        onPlan: (content, filename) => this.send({ type: "plan_update", filename, content }),
        onVfsMessage: (msg) => this.handleVfsMessage(msg),
      });
      this.session = session;
      this.send({ type: "session_started", repo, ref });

      for await (const msg of session) {
        this.handleSdkMessage(msg);
      }
      this.send({ type: "session_done" });
    } catch (err) {
      // An abort after plan approval (or a user interrupt) is a clean stop.
      if (this.planApproved || this.abort.signal.aborted) {
        this.send({ type: "session_done" });
      } else {
        this.send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.failPending(new Error("Session ended"));
    }
  }

  handleClientMessage(msg: ClientMessage): void {
    switch (msg.type) {
      case "answer_question":
      case "plan_decision": {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          pending.resolve(msg);
        }
        break;
      }
      case "interrupt":
        this.dispose();
        break;
    }
  }

  /** Abort the session and unblock any pending browser round-trips. */
  dispose(): void {
    this.failPending(new Error("Session aborted"));
    this.abort.abort();
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, { toolUseID, signal }) => {
    if (toolName === "AskUserQuestion") {
      const questions = (input.questions ?? []) as UserQuestion[];
      const reply = await this.waitForClient(
        { type: "ask_user_question", id: toolUseID, questions },
        toolUseID,
        signal,
      );
      const answers = reply.type === "answer_question" ? reply.answers : {};
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }

    if (toolName === "ExitPlanMode") {
      const allowedPrompts = (input.allowedPrompts ?? []) as { tool: string; prompt: string }[];
      // The CLI injects the plan-file content into the tool input. Re-emit it
      // as a plan_update so the review always has a preview — the plan file
      // itself may have been written through an API the plan-file VFS doesn't
      // intercept (e.g. fs.promises), or never written at all.
      const plan = typeof input.plan === "string" ? input.plan : "";
      if (plan.trim()) {
        const filename =
          typeof input.filePath === "string" && input.filePath
            ? path.basename(input.filePath)
            : "plan.md";
        this.send({ type: "plan_update", filename, content: plan });
      }
      const reply = await this.waitForClient(
        { type: "plan_review", id: toolUseID, allowedPrompts, plan: plan || undefined },
        toolUseID,
        signal,
      );
      const decision = reply.type === "plan_decision" ? reply : undefined;
      const approved = decision?.approved ?? false;
      this.send({ type: "plan_decided", approved });

      if (approved) {
        this.planApproved = true;
        // Allow the tool call to resolve, then stop before implementation.
        setTimeout(() => this.stopSession(), 0);
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: decision?.feedback?.trim() || REJECTION_FALLBACK };
    }

    return { behavior: "allow", updatedInput: input };
  };

  private stopSession(): void {
    const session = this.session;
    if (session?.interrupt) {
      session.interrupt().catch(() => this.abort.abort());
    } else {
      this.abort.abort();
    }
  }

  private waitForClient(
    event: SessionEvent,
    id: string,
    signal: AbortSignal,
  ): Promise<ClientMessage> {
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id);
        reject(new Error("Tool call aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (msg) => {
          signal.removeEventListener("abort", onAbort);
          resolve(msg);
        },
        reject: (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      this.send(event);
    });
  }

  private failPending(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  private handleVfsMessage(msg: VfsMessage): void {
    if (msg.type === "hydrate_init") {
      this.send({ type: "hydrate_init", files: Number(msg.files) });
    } else if (msg.type === "hydrate_fetch") {
      this.filesHydrated += 1;
      this.bytesFetched += Number(msg.size) || 0;
      this.send({ type: "hydrate_fetch", rel: String(msg.rel), size: Number(msg.size) });
      this.sendLiveStats();
    }
  }

  private sendLiveStats(): void {
    this.send({
      type: "session_stats",
      stats: {
        durationMs: Date.now() - this.startedAt,
        totals: { ...this.liveTotals },
        byModel: Object.fromEntries(
          [...this.liveByModel].map(([model, usage]) => [model, { ...usage }]),
        ),
        filesHydrated: this.filesHydrated,
        bytesFetched: this.bytesFetched,
        final: false,
      },
    });
  }

  private handleSdkMessage(msg: SDKMessage): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.send({ type: "session_init", model: msg.model });
        }
        break;
      case "assistant": {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            this.send({ type: "assistant_text", text: block.text });
          } else if (block.type === "tool_use" && !INTERACTIVE_TOOLS.has(block.name)) {
            this.send({
              type: "tool_activity",
              name: block.name,
              detail: summarizeToolInput(block.input as Record<string, unknown>),
            });
          }
        }
        const usage = msg.message.usage as RawUsage | undefined;
        if (usage) {
          const delta = usageFromRaw(usage);
          addUsage(this.liveTotals, delta);
          const model = msg.message.model ?? "unknown";
          const modelUsage = this.liveByModel.get(model) ?? emptyUsage();
          addUsage(modelUsage, delta);
          this.liveByModel.set(model, modelUsage);
          this.sendLiveStats();
        }
        break;
      }
      case "result": {
        const byModel: SessionStats["byModel"] = {};
        for (const [model, usage] of Object.entries(msg.modelUsage ?? {})) {
          byModel[model] = {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadInputTokens,
            cacheCreationTokens: usage.cacheCreationInputTokens,
            costUsd: usage.costUSD,
          };
        }
        this.send({
          type: "session_stats",
          stats: {
            durationMs: msg.duration_ms,
            apiDurationMs: msg.duration_api_ms,
            numTurns: msg.num_turns,
            costUsd: msg.total_cost_usd,
            totals: usageFromRaw(msg.usage as RawUsage | undefined),
            byModel,
            filesHydrated: this.filesHydrated,
            bytesFetched: this.bytesFetched,
            final: true,
          },
        });
        this.send({
          type: "result",
          subtype: msg.subtype,
          result: msg.subtype === "success" ? msg.result : undefined,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
        });
        break;
      }
    }
  }
}
