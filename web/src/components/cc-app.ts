/**
 * <cc-app> — root component. Owns the WebSocket connection (one socket,
 * multiplexing many sessions), the session records (persisted to
 * localStorage), and the per-session live feed elements.
 */

import type { ClientMessage, ConfigMessage, ServerMessage } from "../../lib/protocol";
import {
  deleteSession,
  loadSessions,
  loadSettings,
  newId,
  saveSession,
  type SessionRecord,
} from "../store";
import "./cc-composer";
import "./cc-feed";
import "./cc-plan-panel";
import "./cc-question-card";
import "./cc-session-list";
import "./cc-settings-panel";
import "./cc-start-form";
import "./cc-stats-panel";
import type { AnswerQuestionDetail } from "./cc-question-card";
import type { CcFeed, PermissionDecisionDetail } from "./cc-feed";
import type { PlanDecisionDetail } from "./cc-plan-panel";
import type { StartSessionDetail } from "./cc-start-form";

const FINISHED = ["approved", "done", "stopped", "error"];

export class CcApp extends HTMLElement {
  private badge!: HTMLElement;
  private statusEl!: HTMLElement;
  private sessionList!: HTMLElementTagNameMap["cc-session-list"];
  private startForm!: HTMLElementTagNameMap["cc-start-form"];
  private composer!: HTMLElementTagNameMap["cc-composer"];
  private feeds!: HTMLElement;
  private planPanel!: HTMLElementTagNameMap["cc-plan-panel"];
  private statsPanel!: HTMLElementTagNameMap["cc-stats-panel"];

  private ws?: WebSocket;
  private config: ConfigMessage = { type: "config", mode: "lazy" };
  private records = new Map<string, SessionRecord>();
  private liveFeeds = new Map<string, CcFeed>();
  private activeId: string | null = null;

  connectedCallback(): void {
    this.innerHTML = `
      <header>
        <h1>claude · web tty</h1>
        <span class="badge mode-badge">connecting…</span>
        <span class="status"></span>
      </header>
      <div class="layout">
        <aside>
          <button class="new-session">＋ New session</button>
          <cc-session-list></cc-session-list>
          <cc-settings-panel></cc-settings-panel>
        </aside>
        <main>
          <section class="left">
            <cc-start-form></cc-start-form>
            <div class="feeds"></div>
            <cc-composer hidden></cc-composer>
          </section>
          <section class="right">
            <cc-plan-panel></cc-plan-panel>
            <cc-stats-panel></cc-stats-panel>
          </section>
        </main>
      </div>`;

    this.badge = this.querySelector(".mode-badge")!;
    this.statusEl = this.querySelector(".status")!;
    this.sessionList = this.querySelector("cc-session-list")!;
    this.startForm = this.querySelector("cc-start-form")!;
    this.composer = this.querySelector("cc-composer")!;
    this.feeds = this.querySelector(".feeds")!;
    this.planPanel = this.querySelector("cc-plan-panel")!;
    this.statsPanel = this.querySelector("cc-stats-panel")!;

    this.records = new Map(loadSessions().map((s) => [s.id, s]));

    this.querySelector<HTMLButtonElement>(".new-session")!.onclick = () => this.newDraft();
    this.addEventListener("select-session", ((ev: CustomEvent<{ id: string }>) =>
      this.setActive(ev.detail.id)) as EventListener);
    this.addEventListener("delete-session", ((ev: CustomEvent<{ id: string }>) =>
      this.deleteSession(ev.detail.id)) as EventListener);
    this.addEventListener("start-session", ((ev: CustomEvent<StartSessionDetail>) =>
      this.startSession(ev.detail)) as EventListener);
    this.addEventListener("send-message", ((ev: CustomEvent<{ text: string }>) =>
      this.sendUserMessage(ev.detail.text)) as EventListener);
    this.addEventListener("stop-turn", (() => {
      if (this.activeId) this.sendMsg({ type: "interrupt", sessionId: this.activeId });
    }) as EventListener);
    this.addEventListener("end-session", (() => {
      if (this.activeId) this.sendMsg({ type: "end_session", sessionId: this.activeId });
    }) as EventListener);
    this.addEventListener("answer-question", ((ev: CustomEvent<AnswerQuestionDetail>) => {
      const sessionId = (ev.target as HTMLElement).closest("cc-feed")?.dataset.sessionId;
      if (!sessionId) return;
      this.sendMsg({ type: "answer_question", sessionId, ...ev.detail });
      this.updateStatus(sessionId, "running");
    }) as EventListener);
    this.addEventListener("permission-decision", ((ev: CustomEvent<PermissionDecisionDetail>) => {
      const sessionId = (ev.target as HTMLElement).closest("cc-feed")?.dataset.sessionId;
      if (!sessionId) return;
      this.sendMsg({ type: "permission_decision", sessionId, ...ev.detail });
      this.updateStatus(sessionId, "running");
    }) as EventListener);
    this.addEventListener("plan-decision", ((ev: CustomEvent<PlanDecisionDetail>) => {
      const sessionId = this.planPanel.dataset.sessionId;
      const record = sessionId ? this.records.get(sessionId) : undefined;
      if (!sessionId || !record) return;
      record.pendingReview = null;
      this.sendMsg({ type: "plan_decision", sessionId, ...ev.detail });
    }) as EventListener);

    this.newDraft();
    this.connect();
  }

  // -- WebSocket ------------------------------------------------------------

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onmessage = (ev) => this.handleServerMessage(JSON.parse(String(ev.data)));
    this.ws.onclose = () => {
      // Server-side sessions die with the socket.
      for (const id of this.liveFeeds.keys()) {
        const record = this.records.get(id);
        if (record && record.status !== "draft" && !FINISHED.includes(record.status)) {
          this.updateStatus(id, "stopped");
        }
      }
      this.badge.textContent = "reconnecting…";
      setTimeout(() => this.connect(), 2000);
    };
  }

  private sendMsg(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // -- session lifecycle ------------------------------------------------------

  private newDraft(): void {
    const record: SessionRecord = {
      id: newId(),
      status: "draft",
      prompt: "",
      repo: "",
      branch: "",
      mode: "plan",
      stopOnPlanApproval: true,
      plan: "",
      planFilename: "",
      createdAt: Date.now(),
    };
    this.records.set(record.id, record);
    this.setActive(record.id);
  }

  private startSession(detail: StartSessionDetail): void {
    const record = this.activeId ? this.records.get(this.activeId) : undefined;
    if (!record || record.status !== "draft") return;
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.statusEl.textContent = "not connected — try again";
      return;
    }

    Object.assign(record, {
      repo: this.config.mode === "baked" ? (this.config.repo ?? "") : detail.repo,
      branch: detail.branch,
      prompt: detail.prompt,
      mode: detail.mode,
      stopOnPlanApproval: detail.stopOnPlanApproval,
      status: "starting" as const,
      createdAt: Date.now(),
      startedAt: Date.now(),
    });

    const feed = document.createElement("cc-feed");
    feed.dataset.sessionId = record.id;
    this.feeds.append(feed);
    this.liveFeeds.set(record.id, feed);
    feed.addUserMessage(detail.prompt);

    const settings = loadSettings();
    this.sendMsg({
      type: "start",
      sessionId: record.id,
      prompt: detail.prompt,
      repo: detail.repo || undefined,
      branch: detail.branch || undefined,
      mode: detail.mode,
      stopOnPlanApproval: detail.stopOnPlanApproval,
      auth:
        settings.baseUrl || settings.authToken
          ? { baseUrl: settings.baseUrl, authToken: settings.authToken }
          : undefined,
    });

    this.persist(record);
    this.setActive(record.id);
  }

  private sendUserMessage(text: string): void {
    const record = this.activeId ? this.records.get(this.activeId) : undefined;
    if (!record || !this.liveFeeds.has(record.id)) return;
    this.sendMsg({ type: "user_message", sessionId: record.id, text });
    this.liveFeeds.get(record.id)?.addUserMessage(text);
    this.updateStatus(record.id, "running");
  }

  private deleteSession(id: string): void {
    if (this.liveFeeds.has(id)) {
      this.sendMsg({ type: "interrupt", sessionId: id });
      this.sendMsg({ type: "end_session", sessionId: id });
      this.liveFeeds.get(id)?.remove();
      this.liveFeeds.delete(id);
    }
    this.records.delete(id);
    deleteSession(id);
    if (this.activeId === id) {
      const next = this.orderedRecords()[0];
      if (next) this.setActive(next.id);
      else this.newDraft();
    } else {
      this.renderList();
    }
  }

  // -- server events ----------------------------------------------------------

  private handleServerMessage(msg: ServerMessage): void {
    if (msg.type === "config") {
      this.config = msg;
      this.badge.textContent =
        msg.mode === "baked"
          ? `baked: ${msg.repo}${msg.ref ? " @ " + msg.ref.slice(0, 8) : ""}`
          : "lazy hydration";
      this.startForm.setWorkspaceMode(msg.mode);
      this.startForm.showSession(this.activeId ? this.records.get(this.activeId) : undefined);
      return;
    }

    const record = this.records.get(msg.sessionId);
    const feed = this.liveFeeds.get(msg.sessionId);
    if (!record || !feed) return;
    const isActive = msg.sessionId === this.activeId;

    switch (msg.type) {
      case "session_started":
        record.repo = msg.repo;
        record.ref = msg.ref;
        this.updateStatus(msg.sessionId, "running");
        feed.addInfo(`Workspace ready: ${msg.repo} @ ${msg.ref.slice(0, 12)}`);
        break;
      case "session_init":
        record.model = msg.model;
        feed.addInfo(`Session initialized (${msg.model})`);
        break;
      case "assistant_text":
        feed.addAssistant(msg.text);
        break;
      case "tool_activity":
        feed.addTool(msg.name, msg.detail, msg.diff);
        break;
      case "hydrate_init":
        feed.addInfo(`Repo manifest ready: ${msg.files} files (contents fetched on demand)`);
        break;
      case "hydrate_fetch":
        feed.hydrateProgress(msg.rel);
        break;
      case "plan_update":
        record.plan = msg.content;
        record.planFilename = msg.filename;
        this.persist(record);
        if (isActive) this.planPanel.updatePlan(record);
        break;
      case "ask_user_question":
        this.updateStatus(msg.sessionId, "awaiting-input");
        feed.addQuestion(msg.id, msg.questions);
        break;
      case "permission_request":
        this.updateStatus(msg.sessionId, "awaiting-input");
        feed.addPermission(msg.id, msg.toolName, msg.detail, msg.diff);
        break;
      case "plan_review":
        record.pendingReview = { id: msg.id, allowedPrompts: msg.allowedPrompts };
        this.updateStatus(msg.sessionId, "reviewing");
        if (isActive) this.planPanel.showReview(record.pendingReview);
        break;
      case "plan_decided":
        record.pendingReview = null;
        feed.addInfo(
          msg.approved ? "Plan approved ✔" : "Changes requested — Claude is revising the plan",
        );
        this.updateStatus(
          msg.sessionId,
          msg.approved && record.stopOnPlanApproval ? "approved" : "running",
        );
        break;
      case "session_stats":
        record.stats = msg.stats;
        if (msg.stats.final) this.persist(record);
        if (isActive) this.statsPanel.showSession(record);
        break;
      case "result": {
        if (msg.result) feed.addAssistant(msg.result);
        const costNote = msg.costUsd != null ? `, ~$${msg.costUsd.toFixed(4)} est.` : "";
        feed.addInfo(`Turn finished (${((msg.durationMs ?? 0) / 1000).toFixed(1)}s${costNote})`);
        record.costUsd = msg.costUsd;
        if (!FINISHED.includes(record.status)) this.updateStatus(msg.sessionId, "idle");
        break;
      }
      case "session_done":
        if (!FINISHED.includes(record.status)) this.updateStatus(msg.sessionId, "done");
        this.persist(record);
        if (isActive) this.refreshActiveChrome(record);
        break;
      case "error":
        feed.addError(msg.message);
        this.updateStatus(msg.sessionId, "error");
        break;
    }
  }

  // -- rendering helpers --------------------------------------------------------

  private orderedRecords(): SessionRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private persist(record: SessionRecord): void {
    if (record.status !== "draft") saveSession(record);
  }

  private updateStatus(id: string, status: SessionRecord["status"]): void {
    const record = this.records.get(id);
    if (!record) return;
    if (FINISHED.includes(record.status) && !FINISHED.includes(status)) return;
    record.status = status;
    this.persist(record);
    this.renderList();
    if (id === this.activeId) this.refreshActiveChrome(record);
  }

  private refreshActiveChrome(record: SessionRecord): void {
    this.statusEl.textContent = record.status === "draft" ? "" : record.status;
    this.startForm.showSession(record);
    this.composer.hidden = !this.liveFeeds.has(record.id) || FINISHED.includes(record.status);
  }

  private renderList(): void {
    this.sessionList.update(this.orderedRecords(), this.activeId);
  }

  private setActive(id: string): void {
    this.activeId = id;
    const record = this.records.get(id);

    for (const [feedId, feed] of this.liveFeeds) {
      feed.style.display = feedId === id ? "" : "none";
    }
    let note = this.feeds.querySelector<HTMLElement>(".restored-note");
    if (!this.liveFeeds.has(id) && record?.status !== "draft") {
      if (!note) {
        note = document.createElement("div");
        note.className = "restored-note muted";
        note.textContent = "Transcript not available — session restored from local storage.";
        this.feeds.append(note);
      }
      note.style.display = "";
    } else if (note) {
      note.style.display = "none";
    }

    this.planPanel.dataset.sessionId = id;
    this.planPanel.showSession(record);
    this.statsPanel.showSession(record);
    if (record) this.refreshActiveChrome(record);
    this.renderList();
  }
}

customElements.define("cc-app", CcApp);

declare global {
  interface HTMLElementTagNameMap {
    "cc-app": CcApp;
  }
}
