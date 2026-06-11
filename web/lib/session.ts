/**
 * ClaudeSession — bridges one interactive, multi-turn Claude Code session to
 * one browser client. This is the server half of the web TTY: the browser
 * sends user messages and permission decisions; the session streams back
 * assistant output, tool activity, plan content, and stats.
 *
 * - Input is a stream: the first prompt starts the session and follow-up
 *   user_message events queue further turns, exactly like typing into the
 *   CLI.
 * - canUseTool routes every gated tool call to the browser: AskUserQuestion
 *   renders as question cards, ExitPlanMode as a plan review, and everything
 *   else (Bash, Edit, Write, ...) as allow/deny permission cards.
 * - In the classic planner workflow (stopOnPlanApproval), approving the plan
 *   ends the session — the plan is the deliverable. Otherwise approval lets
 *   Claude continue into implementation under browser-prompted permissions.
 */

import { existsSync, readFileSync } from "fs";
import path from "path";
import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { planBakedRepo, resolveBakedRef } from "../../scripts/lib/plan-baked";
import { planRemoteRepo } from "../../scripts/lib/plan-remote";
import type { VfsMessage } from "../../scripts/lib/spawn-vfs";
import { evaluateBashCommand, HYDRATION_GUIDANCE } from "./bash-policy";
import { estimateModelCostUsd } from "./pricing";
import type {
  AuthConfig,
  ClientMessage,
  DiffPayload,
  SessionEvent,
  SessionMode,
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
// Streaming input
// ---------------------------------------------------------------------------

export function makeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "",
  };
}

/** Unbounded push queue exposed as the SDK's streaming-input iterable. */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private readonly waiters: ((result: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(text: string): void {
    if (this.closed) return;
    const msg = makeUserMessage(text);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: msg });
    else this.queue.push(msg);
  }

  /** Signal end of input — the CLI finishes the current turn and exits. */
  done(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Session runner — injectable so tests don't spawn a real claude process
// ---------------------------------------------------------------------------

export interface RunnerArgs {
  prompt: string | AsyncIterable<SDKUserMessage>;
  permissionMode?: PermissionMode;
  appendSystemPrompt?: string;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  allowedTools?: string[];
  disallowedTools?: string[];
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
// ClaudeSession
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

/** Largest file content (bytes) included in a diff payload. */
const DIFF_MAX_BYTES = 200_000;

/**
 * Extract a renderable file diff from an Edit/Write tool input. For Write,
 * the old text is read from disk (in the session workspace) when the file
 * already exists, so overwrites render as a change rather than an addition.
 */
export function extractDiff(
  toolName: string,
  input: Record<string, unknown>,
): DiffPayload | undefined {
  const filePath = input.file_path;
  if (typeof filePath !== "string" || !filePath) return undefined;

  if (toolName === "Edit") {
    return {
      filePath,
      oldText: typeof input.old_string === "string" ? input.old_string : "",
      newText: typeof input.new_string === "string" ? input.new_string : "",
    };
  }
  if (toolName === "Write") {
    let oldText = "";
    try {
      const existing = readFileSync(filePath, "utf-8");
      if (existing.length <= DIFF_MAX_BYTES) oldText = existing;
    } catch {
      // New file — render as a pure addition.
    }
    return {
      filePath,
      oldText,
      newText: typeof input.content === "string" ? input.content : "",
    };
  }
  return undefined;
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

export interface StartRequest {
  prompt: string;
  repo?: string;
  branch?: string;
  mode?: SessionMode;
  stopOnPlanApproval?: boolean;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  auth?: AuthConfig;
}

/**
 * Tools answered entirely by the VFS layer (manifest-backed listings and
 * on-demand reads) plus side-effect-free bookkeeping. These never require a
 * permission prompt, in any permission mode: they are passed to the CLI as
 * allowedTools and short-circuited in canUseTool as a fallback.
 */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite"];

export interface ClaudeSessionOptions {
  /**
   * The workspace is a lazily-hydrated (blob-less) clone: apply the Bash
   * command policy and append the hydration guidance to the system prompt.
   */
  hydratingWorkspace?: boolean;
}

export class ClaudeSession {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly abort = new AbortController();
  private readonly input = new InputQueue();
  private session?: RunnerResult["session"];
  private started = false;
  private planApproved = false;
  private stopOnPlanApproval = true;
  private startedAt = 0;
  /**
   * Usage per API call, keyed by message id. The SDK can emit several
   * assistant messages for one API call (one per content block), each
   * repeating the same usage — keeping the latest snapshot per id avoids
   * double counting.
   */
  private readonly liveUsageByMessage = new Map<string, { model: string; usage: TokenUsage }>();
  private filesHydrated = 0;
  private bytesFetched = 0;

  constructor(
    private readonly send: (msg: SessionEvent) => void,
    private readonly runner: SessionRunner,
    private readonly options: ClaudeSessionOptions = {},
  ) {}

  async start(req: StartRequest): Promise<void> {
    if (this.started) {
      this.send({ type: "error", message: "Session already started" });
      return;
    }
    this.started = true;
    this.startedAt = Date.now();

    const mode: SessionMode = req.mode ?? "plan";
    this.stopOnPlanApproval = mode === "plan" && (req.stopOnPlanApproval ?? true);
    this.input.push(req.prompt);

    // Compose the system-prompt append: hydration guidance (when the
    // workspace is lazy) plus any user-provided instructions.
    const appendParts = [
      this.options.hydratingWorkspace ? HYDRATION_GUIDANCE : undefined,
      req.appendSystemPrompt?.trim() || undefined,
    ].filter((part): part is string => Boolean(part));

    try {
      const { session, repo, ref } = this.runner({
        prompt: this.input,
        permissionMode: mode,
        appendSystemPrompt: appendParts.length ? appendParts.join("\n\n") : undefined,
        hooks: this.options.hydratingWorkspace
          ? { PreToolUse: [{ matcher: "Bash", hooks: [this.bashPolicyHook] }] }
          : undefined,
        allowedTools: [...new Set([...READ_ONLY_TOOLS, ...(req.allowedTools ?? [])])],
        disallowedTools: req.disallowedTools?.length ? req.disallowedTools : undefined,
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
      // An abort after plan approval (or disposing the session) is a clean stop.
      if (this.planApproved || this.abort.signal.aborted) {
        this.send({ type: "session_done" });
      } else {
        this.send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.input.done();
      this.failPending(new Error("Session ended"));
    }
  }

  handleClientMessage(msg: ClientMessage): void {
    switch (msg.type) {
      case "user_message":
        this.input.push(msg.text);
        break;
      case "answer_question":
      case "permission_decision":
      case "plan_decision": {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          pending.resolve(msg);
        }
        break;
      }
      case "interrupt":
        // Stop the turn in progress; the session stays open for more input.
        this.failPending(new Error("Turn interrupted"));
        this.session?.interrupt?.().catch(() => {});
        break;
      case "end_session":
        this.input.done();
        break;
    }
  }

  /** Abort the session entirely and unblock any pending browser round-trips. */
  dispose(): void {
    this.failPending(new Error("Session aborted"));
    this.input.done();
    this.abort.abort();
  }

  /**
   * PreToolUse hook gating Bash on hydrating workspaces. This runs before
   * the permission system, so it also catches commands plan mode would
   * auto-allow without consulting canUseTool (read-only find/cat/grep).
   */
  private readonly bashPolicyHook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") {
      return {};
    }
    const command = String(
      (input.tool_input as Record<string, unknown> | undefined)?.command ?? "",
    );
    const policy = evaluateBashCommand(command);
    if (policy.verdict === "deny") {
      this.send({ type: "notice", text: `Blocked \`${command}\` — ${policy.reason}` });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: policy.reason,
        },
      };
    }
    if (policy.verdict === "allow") {
      return {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      };
    }
    // "ask": let the normal permission flow (canUseTool → browser card) decide.
    return {};
  };

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
        if (this.stopOnPlanApproval) {
          // Planner workflow: the approved plan is the deliverable. Allow the
          // tool call to resolve, then stop before implementation.
          this.planApproved = true;
          setTimeout(() => this.stopSession(), 0);
        }
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: decision?.feedback?.trim() || REJECTION_FALLBACK };
    }

    // Read-only VFS tools never need a prompt; allowedTools already covers
    // them, but short-circuit here too in case the CLI still asks (e.g. for
    // a path outside the workspace).
    if (READ_ONLY_TOOLS.includes(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    // On lazily-hydrated workspaces, gate Bash commands that walk the tree
    // or read files outside the VFS — deny them with guidance toward the
    // VFS-optimal tools, and auto-allow known-safe metadata commands.
    if (toolName === "Bash" && this.options.hydratingWorkspace) {
      const command = typeof input.command === "string" ? input.command : "";
      const policy = evaluateBashCommand(command);
      if (policy.verdict === "deny") {
        this.send({ type: "notice", text: `Blocked \`${command}\` — ${policy.reason}` });
        return { behavior: "deny", message: policy.reason ?? "Command blocked by VFS policy." };
      }
      if (policy.verdict === "allow") {
        return { behavior: "allow", updatedInput: input };
      }
      // "ask" falls through to the normal permission card.
    }

    // Every other gated tool (Bash, Edit, Write, ...) becomes an allow/deny
    // card in the browser. Edit/Write carry a diff so the change can be
    // reviewed before allowing it.
    const reply = await this.waitForClient(
      {
        type: "permission_request",
        id: toolUseID,
        toolName,
        detail: summarizeToolInput(input),
        diff: extractDiff(toolName, input),
      },
      toolUseID,
      signal,
    );
    const decision = reply.type === "permission_decision" ? reply : undefined;
    if (decision?.allow) {
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: decision.always
          ? [
              {
                type: "addRules",
                rules: [{ toolName }],
                behavior: "allow",
                destination: "session",
              },
            ]
          : undefined,
      };
    }
    return { behavior: "deny", message: "The user denied this tool call." };
  };

  private stopSession(): void {
    this.input.done();
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
    const usageByModel = new Map<string, TokenUsage>();
    const totals = emptyUsage();
    for (const { model, usage } of this.liveUsageByMessage.values()) {
      const modelUsage = usageByModel.get(model) ?? emptyUsage();
      addUsage(modelUsage, usage);
      usageByModel.set(model, modelUsage);
      addUsage(totals, usage);
    }

    const byModel: SessionStats["byModel"] = {};
    let estimatedTotal: number | undefined;
    for (const [model, usage] of usageByModel) {
      const costUsd = estimateModelCostUsd(model, usage);
      byModel[model] = { ...usage, costUsd };
      if (costUsd !== undefined) {
        estimatedTotal = (estimatedTotal ?? 0) + costUsd;
      }
    }
    this.send({
      type: "session_stats",
      stats: {
        durationMs: Date.now() - this.startedAt,
        costUsd: estimatedTotal,
        estimated: true,
        totals,
        byModel,
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
            const input = block.input as Record<string, unknown>;
            this.send({
              type: "tool_activity",
              name: block.name,
              detail: summarizeToolInput(input),
              diff: extractDiff(block.name, input),
            });
          }
        }
        const usage = msg.message.usage as RawUsage | undefined;
        if (usage) {
          this.liveUsageByMessage.set(msg.message.id ?? `turn-${this.liveUsageByMessage.size}`, {
            model: msg.message.model ?? "unknown",
            usage: usageFromRaw(usage),
          });
          this.sendLiveStats();
        }
        break;
      }
      case "result": {
        // Per-turn stats use the SDK's authoritative (session-cumulative)
        // token counts, but cost is always estimated from public pricing —
        // the SDK's own cost figure is never shown.
        const byModel: SessionStats["byModel"] = {};
        let estimatedTotal: number | undefined;
        for (const [model, usage] of Object.entries(msg.modelUsage ?? {})) {
          const tokens: TokenUsage = {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadInputTokens,
            cacheCreationTokens: usage.cacheCreationInputTokens,
          };
          const costUsd = estimateModelCostUsd(model, tokens);
          byModel[model] = { ...tokens, costUsd };
          if (costUsd !== undefined) {
            estimatedTotal = (estimatedTotal ?? 0) + costUsd;
          }
        }
        this.send({
          type: "session_stats",
          stats: {
            durationMs: msg.duration_ms,
            apiDurationMs: msg.duration_api_ms,
            numTurns: msg.num_turns,
            costUsd: estimatedTotal,
            estimated: true,
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
          costUsd: estimatedTotal,
          durationMs: msg.duration_ms,
        });
        break;
      }
    }
  }
}
