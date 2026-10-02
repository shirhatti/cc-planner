/**
 * App state: owns the WebSocket connection (one socket, multiplexing many
 * sessions), the session records (persisted to localStorage), and each live
 * session's transcript feed. React subscribes via useSyncExternalStore; all
 * state is replaced immutably so snapshots can be compared by reference.
 */

import { useSyncExternalStore } from "react";
import type { ClientMessage, ConfigMessage, ServerMessage } from "../lib/protocol";
import type { FeedItem, PermissionDecision } from "./feed";
import {
  deleteSession as deleteStoredSession,
  loadSessions,
  loadSettings,
  newId,
  saveSession,
  type SessionRecord,
  type SessionStatus,
} from "./store";

const FINISHED: SessionStatus[] = ["approved", "done", "stopped", "error"];

export function isFinished(status: SessionStatus): boolean {
  return FINISHED.includes(status);
}

export type WorkspaceSource = "baked" | "repo" | "local";

/** Workspace and advanced options a draft session starts with. */
export interface DraftOptions {
  source: WorkspaceSource;
  repo: string;
  branch: string;
  /** Absolute path (~ ok) of a checkout on the server's filesystem. */
  localPath: string;
  appendSystemPrompt: string;
  /** Comma-separated tool names / Bash(...) patterns. */
  allowedTools: string;
  disallowedTools: string;
}

export interface AppState {
  connected: boolean;
  config: ConfigMessage;
  /** Newest first. */
  records: SessionRecord[];
  activeId: string;
  /** Transcripts of sessions started in this page load. */
  feeds: Record<string, FeedItem[]>;
  drafts: Record<string, DraftOptions>;
}

/** @returns why the draft can't start yet, or null when it can */
export function draftError(options: DraftOptions): string | null {
  if (options.source === "repo" && !/^[\w.-]+\/[\w.-]+$/.test(options.repo.trim())) {
    return "Enter a repo as owner/repo";
  }
  if (options.source === "local" && !/^[~/]/.test(options.localPath.trim())) {
    return "Enter an absolute folder path (or ~/...)";
  }
  return null;
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function newRecord(): SessionRecord {
  return {
    id: newId(),
    status: "draft",
    prompt: "",
    repo: "",
    branch: "",
    mode: "plan",
    plan: "",
    planFilename: "",
    createdAt: Date.now(),
  };
}

export class SessionStore {
  private state: AppState;
  private listeners = new Set<() => void>();
  private ws?: WebSocket;

  constructor() {
    const draft = newRecord();
    this.state = {
      connected: false,
      config: { type: "config", mode: "lazy" },
      records: [draft, ...loadSessions()],
      activeId: draft.id,
      feeds: {},
      drafts: { [draft.id]: this.defaultDraft("lazy") },
    };
  }

  // -- subscription -----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppState => this.state;

  private set(next: Partial<AppState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  record(id: string): SessionRecord | undefined {
    return this.state.records.find((r) => r.id === id);
  }

  /** Apply `patch` to a record, persisting it unless it's a draft. */
  private patch(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    let updated: SessionRecord | undefined;
    const records = this.state.records.map((r) => {
      if (r.id !== id) return r;
      updated = { ...r, ...patch };
      return updated;
    });
    if (!updated) return undefined;
    if (updated.status !== "draft") saveSession(updated);
    this.set({ records: records.sort((a, b) => b.createdAt - a.createdAt) });
    return updated;
  }

  private setStatus(id: string, status: SessionStatus): void {
    const record = this.record(id);
    if (!record) return;
    // A finished session never comes back to life.
    if (isFinished(record.status) && !isFinished(status)) return;
    this.patch(id, { status });
  }

  private appendFeed(id: string, ...items: FeedItem[]): void {
    const feed = this.state.feeds[id];
    if (!feed) return;
    this.set({ feeds: { ...this.state.feeds, [id]: [...feed, ...items] } });
  }

  /** Replace the feed item with `itemId` (if present) via `update`. */
  private updateFeedItem(id: string, itemId: string, update: (item: FeedItem) => FeedItem): void {
    const feed = this.state.feeds[id];
    if (!feed) return;
    this.set({
      feeds: {
        ...this.state.feeds,
        [id]: feed.map((item) => (item.id === itemId ? update(item) : item)),
      },
    });
  }

  private info(id: string, text: string): void {
    this.appendFeed(id, { kind: "info", id: newId(), text });
  }

  // -- WebSocket ------------------------------------------------------------

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => this.set({ connected: true });
    ws.onmessage = (ev) => this.handleServerMessage(JSON.parse(String(ev.data)));
    ws.onclose = () => {
      // Server-side sessions die with the socket.
      for (const id of Object.keys(this.state.feeds)) {
        const record = this.record(id);
        if (record && record.status !== "draft" && !isFinished(record.status)) {
          this.setStatus(id, "stopped");
        }
      }
      this.set({ connected: false });
      setTimeout(() => this.connect(), 2000);
    };
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // -- session lifecycle ------------------------------------------------------

  private defaultDraft(mode: ConfigMessage["mode"]): DraftOptions {
    return {
      source: mode === "baked" ? "baked" : "repo",
      repo: "",
      branch: "",
      localPath: "",
      appendSystemPrompt: "",
      allowedTools: "",
      disallowedTools: "",
    };
  }

  newDraft(): void {
    // Reuse an untouched draft instead of piling up empty ones.
    const existing = this.state.records.find((r) => r.status === "draft");
    if (existing) {
      this.setActive(existing.id);
      return;
    }
    const record = newRecord();
    this.set({
      records: [record, ...this.state.records],
      drafts: { ...this.state.drafts, [record.id]: this.defaultDraft(this.state.config.mode) },
      activeId: record.id,
    });
  }

  updateDraft(id: string, patch: Partial<DraftOptions>): void {
    const draft = this.state.drafts[id];
    if (!draft) return;
    this.set({ drafts: { ...this.state.drafts, [id]: { ...draft, ...patch } } });
  }

  setActive(id: string): void {
    if (this.record(id)) this.set({ activeId: id });
  }

  /** Start the active draft with `prompt` as its first message. */
  start(prompt: string): void {
    const id = this.state.activeId;
    const record = this.record(id);
    const options = this.state.drafts[id];
    if (!record || record.status !== "draft" || !options || draftError(options)) return;

    const repo = options.source === "repo" ? options.repo.trim() : "";
    const branch = options.source === "repo" ? options.branch.trim() : "";
    const localPath = options.source === "local" ? options.localPath.trim() : "";
    const { config } = this.state;
    const settings = loadSettings();
    const allowedTools = csv(options.allowedTools);
    const disallowedTools = csv(options.disallowedTools);

    this.set({
      feeds: { ...this.state.feeds, [id]: [{ kind: "user", id: newId(), text: prompt }] },
    });
    this.patch(id, {
      repo: localPath || repo || (config.mode === "baked" ? (config.repo ?? "") : ""),
      branch,
      prompt,
      status: "starting",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });

    this.send({
      type: "start",
      sessionId: id,
      prompt,
      repo: repo || undefined,
      branch: branch || undefined,
      localPath: localPath || undefined,
      strategy:
        settings.strategy === "gh" || settings.strategy === "git" ? settings.strategy : undefined,
      mode: "plan",
      appendSystemPrompt: options.appendSystemPrompt.trim() || undefined,
      allowedTools: allowedTools.length ? allowedTools : undefined,
      disallowedTools: disallowedTools.length ? disallowedTools : undefined,
      auth:
        settings.baseUrl || settings.authToken || settings.apiKey
          ? { baseUrl: settings.baseUrl, authToken: settings.authToken, apiKey: settings.apiKey }
          : undefined,
    });
  }

  /** Send a follow-up message (or start the session if it's a draft). */
  sendUserMessage(text: string): void {
    const id = this.state.activeId;
    const record = this.record(id);
    if (!record) return;
    if (record.status === "draft") {
      this.start(text);
      return;
    }
    if (!this.state.feeds[id] || isFinished(record.status)) return;
    this.send({ type: "user_message", sessionId: id, text });
    this.appendFeed(id, { kind: "user", id: newId(), text });
    this.setStatus(id, "running");
  }

  interrupt(): void {
    this.send({ type: "interrupt", sessionId: this.state.activeId });
  }

  endSession(): void {
    this.send({ type: "end_session", sessionId: this.state.activeId });
  }

  answerQuestion(sessionId: string, id: string, answers: Record<string, string>): void {
    this.send({ type: "answer_question", sessionId, id, answers });
    this.updateFeedItem(sessionId, id, (item) =>
      item.kind === "question" ? { ...item, answers } : item,
    );
    this.setStatus(sessionId, "running");
  }

  decidePermission(sessionId: string, id: string, decision: PermissionDecision): void {
    this.send({ type: "permission_decision", sessionId, id, ...decision });
    this.updateFeedItem(sessionId, id, (item) =>
      item.kind === "permission" ? { ...item, decision } : item,
    );
    this.setStatus(sessionId, "running");
  }

  decidePlan(sessionId: string, approved: boolean, feedback: string): void {
    const review = this.record(sessionId)?.pendingReview;
    if (!review) return;
    this.patch(sessionId, { pendingReview: null });
    this.send({ type: "plan_decision", sessionId, id: review.id, approved, feedback });
  }

  deleteSession(id: string): void {
    if (this.state.feeds[id]) {
      this.send({ type: "interrupt", sessionId: id });
      this.send({ type: "end_session", sessionId: id });
    }
    deleteStoredSession(id);
    const feeds = { ...this.state.feeds };
    const drafts = { ...this.state.drafts };
    delete feeds[id];
    delete drafts[id];
    const records = this.state.records.filter((r) => r.id !== id);
    // There is always at least one session to show.
    if (!records.length) {
      const draft = newRecord();
      records.push(draft);
      drafts[draft.id] = this.defaultDraft(this.state.config.mode);
    }
    const activeId = this.state.activeId === id ? records[0].id : this.state.activeId;
    this.set({ records, feeds, drafts, activeId });
  }

  // -- server events ----------------------------------------------------------

  private handleServerMessage(msg: ServerMessage): void {
    if (msg.type === "config") {
      // The default workspace source depends on the server mode; re-seed
      // drafts the user hasn't pointed anywhere yet.
      const drafts = Object.fromEntries(
        Object.entries(this.state.drafts).map(([id, d]) => [
          id,
          d.repo || d.localPath ? d : { ...d, source: this.defaultDraft(msg.mode).source },
        ]),
      );
      this.set({ config: msg, drafts });
      return;
    }

    const id = msg.sessionId;
    if (!this.record(id) || !this.state.feeds[id]) return;

    // setStatus never moves a finished session back to a live status.
    switch (msg.type) {
      case "session_started":
        this.patch(id, { repo: msg.repo, ref: msg.ref });
        this.setStatus(id, "running");
        this.info(id, `Workspace ready: ${msg.repo} @ ${msg.ref.slice(0, 12)}`);
        break;
      case "session_init":
        this.patch(id, { model: msg.model });
        this.info(id, `Session initialized (${msg.model})`);
        break;
      case "assistant_text":
        this.appendFeed(id, { kind: "text", id: newId(), text: msg.text });
        break;
      case "tool_activity":
        this.appendFeed(id, {
          kind: "tool",
          id: newId(),
          name: msg.name,
          detail: msg.detail,
          diff: msg.diff,
        });
        break;
      case "hydrate_init":
        this.info(id, `Repo manifest ready: ${msg.files} files (contents fetched on demand)`);
        break;
      case "hydrate_fetch": {
        // One progress line per session, updated in place.
        const existing = this.state.feeds[id].find((item) => item.kind === "hydrate");
        if (existing) {
          this.updateFeedItem(id, existing.id, (item) =>
            item.kind === "hydrate" ? { ...item, count: item.count + 1, latest: msg.rel } : item,
          );
        } else {
          this.appendFeed(id, { kind: "hydrate", id: newId(), count: 1, latest: msg.rel });
        }
        break;
      }
      case "plan_update":
        this.patch(id, { plan: msg.content, planFilename: msg.filename });
        break;
      case "ask_user_question":
        this.setStatus(id, "awaiting-input");
        this.appendFeed(id, { kind: "question", id: msg.id, questions: msg.questions });
        break;
      case "permission_request":
        this.setStatus(id, "awaiting-input");
        this.appendFeed(id, {
          kind: "permission",
          id: msg.id,
          toolName: msg.toolName,
          detail: msg.detail,
          diff: msg.diff,
        });
        break;
      case "plan_review":
        this.patch(id, { pendingReview: { id: msg.id, allowedPrompts: msg.allowedPrompts } });
        this.setStatus(id, "reviewing");
        break;
      case "plan_decided":
        this.patch(id, { pendingReview: null });
        this.info(
          id,
          msg.approved ? "Plan approved ✔" : "Changes requested — Claude is revising the plan",
        );
        this.setStatus(id, msg.approved ? "approved" : "running");
        break;
      case "notice":
        this.info(id, msg.text);
        break;
      case "session_stats":
        // Live stats are frequent; persist only the per-turn final ones.
        if (msg.stats.final) {
          this.patch(id, { stats: msg.stats });
        } else {
          this.set({
            records: this.state.records.map((r) => (r.id === id ? { ...r, stats: msg.stats } : r)),
          });
        }
        break;
      case "result": {
        if (msg.result) this.appendFeed(id, { kind: "text", id: newId(), text: msg.result });
        const costNote = msg.costUsd != null ? `, ~$${msg.costUsd.toFixed(4)} est.` : "";
        this.info(id, `Turn finished (${((msg.durationMs ?? 0) / 1000).toFixed(1)}s${costNote})`);
        this.patch(id, { costUsd: msg.costUsd });
        this.setStatus(id, "idle");
        break;
      }
      case "session_done":
        // Keep a more specific final status (approved, stopped, error).
        if (!isFinished(this.record(id)!.status)) this.setStatus(id, "done");
        break;
      case "error":
        this.appendFeed(id, { kind: "error", id: newId(), text: msg.message });
        this.setStatus(id, "error");
        break;
    }
  }
}

export const sessionStore = new SessionStore();

export function useAppState(): AppState {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
}
