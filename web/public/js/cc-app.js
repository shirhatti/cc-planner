/**
 * <cc-app> — root component. Owns the WebSocket connection (one socket,
 * multiplexing many sessions), the session records (persisted to
 * localStorage via store.js), and the per-session live feed elements.
 */

import { deleteSession, loadSessions, loadSettings, newId, saveSession } from "./store.js";
import "./components/cc-session-list.js";
import "./components/cc-start-form.js";
import "./components/cc-feed.js";
import "./components/cc-plan-panel.js";
import "./components/cc-settings-panel.js";
import "./components/cc-stats-panel.js";

export class CcApp extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <header>
        <h1>cc-planner</h1>
        <span class="badge mode-badge">connecting…</span>
        <span class="status"></span>
      </header>
      <div class="layout">
        <aside>
          <button class="new-session">＋ New plan</button>
          <cc-session-list></cc-session-list>
          <cc-settings-panel></cc-settings-panel>
        </aside>
        <main>
          <section class="left">
            <cc-start-form></cc-start-form>
            <div class="feeds"></div>
          </section>
          <section class="right">
            <cc-plan-panel></cc-plan-panel>
            <cc-stats-panel></cc-stats-panel>
          </section>
        </main>
      </div>`;

    this.badge = this.querySelector(".mode-badge");
    this.statusEl = this.querySelector(".status");
    this.sessionList = this.querySelector("cc-session-list");
    this.startForm = this.querySelector("cc-start-form");
    this.feeds = this.querySelector(".feeds");
    this.planPanel = this.querySelector("cc-plan-panel");
    this.statsPanel = this.querySelector("cc-stats-panel");

    this.config = { mode: "lazy" };
    /** @type {Map<string, object>} session id -> record */
    this.records = new Map(loadSessions().map((s) => [s.id, s]));
    /** @type {Map<string, HTMLElement>} session id -> live <cc-feed> */
    this.liveFeeds = new Map();
    this.activeId = null;

    this.querySelector(".new-session").onclick = () => this.newDraft();
    this.addEventListener("select-session", (ev) => this.setActive(ev.detail.id));
    this.addEventListener("delete-session", (ev) => this.deleteSession(ev.detail.id));
    this.addEventListener("start-session", (ev) => this.startSession(ev.detail));
    this.addEventListener("interrupt-session", () => this.interruptActive());
    this.addEventListener("answer-question", (ev) => {
      const sessionId = ev.target.closest("cc-feed")?.dataset.sessionId;
      if (!sessionId) return;
      this.sendMsg({ type: "answer_question", sessionId, ...ev.detail });
      this.updateStatus(sessionId, "running");
    });
    this.addEventListener("plan-decision", (ev) => {
      const sessionId = this.planPanel.dataset.sessionId;
      const record = this.records.get(sessionId);
      if (!sessionId || !record) return;
      record.pendingReview = null;
      this.sendMsg({ type: "plan_decision", sessionId, ...ev.detail });
    });

    this.newDraft();
    this.connect();
  }

  // -- WebSocket ------------------------------------------------------------

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onmessage = (ev) => this.handleServerMessage(JSON.parse(ev.data));
    this.ws.onclose = () => {
      // Server-side sessions die with the socket.
      for (const id of this.liveFeeds.keys()) {
        const record = this.records.get(id);
        if (record && record.status !== "draft" && !this.isFinished(record)) {
          this.updateStatus(id, "stopped");
        }
      }
      this.badge.textContent = "reconnecting…";
      setTimeout(() => this.connect(), 2000);
    };
  }

  sendMsg(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // -- session lifecycle ------------------------------------------------------

  newDraft() {
    const record = {
      id: newId(),
      status: "draft",
      prompt: "",
      repo: "",
      branch: "",
      plan: "",
      planFilename: "",
      createdAt: Date.now(),
    };
    this.records.set(record.id, record);
    this.setActive(record.id);
  }

  startSession({ repo, branch, prompt }) {
    const record = this.records.get(this.activeId);
    if (!record || record.status !== "draft") return;
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.statusEl.textContent = "not connected — try again";
      return;
    }

    Object.assign(record, {
      repo: this.config.mode === "baked" ? this.config.repo : repo,
      branch,
      prompt,
      status: "starting",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });

    const feed = document.createElement("cc-feed");
    feed.dataset.sessionId = record.id;
    this.feeds.append(feed);
    this.liveFeeds.set(record.id, feed);

    const settings = loadSettings();
    this.sendMsg({
      type: "start",
      sessionId: record.id,
      prompt,
      repo: repo || undefined,
      branch: branch || undefined,
      auth:
        settings.baseUrl || settings.authToken
          ? { baseUrl: settings.baseUrl, authToken: settings.authToken }
          : undefined,
    });

    this.persist(record);
    this.setActive(record.id);
  }

  interruptActive() {
    const record = this.records.get(this.activeId);
    if (!record) return;
    this.sendMsg({ type: "interrupt", sessionId: record.id });
    this.updateStatus(record.id, "stopped");
  }

  deleteSession(id) {
    if (this.liveFeeds.has(id)) {
      this.sendMsg({ type: "interrupt", sessionId: id });
      this.liveFeeds.get(id).remove();
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

  handleServerMessage(msg) {
    if (msg.type === "config") {
      this.config = msg;
      this.badge.textContent =
        msg.mode === "baked"
          ? `baked: ${msg.repo}${msg.ref ? " @ " + msg.ref.slice(0, 8) : ""}`
          : "lazy hydration";
      this.startForm.setMode(msg.mode);
      this.startForm.showSession(this.records.get(this.activeId));
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
        feed.addInfo(`Planning against ${msg.repo} @ ${msg.ref.slice(0, 12)}`);
        break;
      case "session_init":
        record.model = msg.model;
        feed.addInfo(`Session initialized (${msg.model})`);
        break;
      case "assistant_text":
        feed.addAssistant(msg.text);
        break;
      case "tool_activity":
        feed.addTool(msg.name, msg.detail);
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
        this.updateStatus(msg.sessionId, msg.approved ? "approved" : "running");
        break;
      case "session_stats":
        record.stats = msg.stats;
        if (msg.stats.final) this.persist(record);
        if (isActive) this.statsPanel.showSession(record);
        break;
      case "result": {
        if (msg.result) feed.addAssistant(msg.result);
        const costNote = msg.costUsd != null ? `, ~$${msg.costUsd.toFixed(4)} est.` : "";
        feed.addInfo(`Session finished (${(msg.durationMs / 1000).toFixed(1)}s${costNote})`);
        record.costUsd = msg.costUsd;
        break;
      }
      case "session_done":
        if (!this.isFinished(record)) this.updateStatus(msg.sessionId, "done");
        this.persist(record);
        if (isActive) this.startForm.showSession(record);
        break;
      case "error":
        feed.addError(msg.message);
        this.updateStatus(msg.sessionId, "error");
        break;
    }
  }

  // -- rendering helpers --------------------------------------------------------

  isFinished(record) {
    return ["approved", "done", "stopped", "error"].includes(record.status);
  }

  orderedRecords() {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  persist(record) {
    if (record.status !== "draft") saveSession(record);
  }

  updateStatus(id, status) {
    const record = this.records.get(id);
    if (!record || (record.status === "approved" && status === "done")) return;
    if (this.isFinished(record) && status === "done") return;
    record.status = status;
    this.persist(record);
    this.renderList();
    if (id === this.activeId) {
      this.statusEl.textContent = status;
      this.startForm.showSession(record);
    }
  }

  renderList() {
    this.sessionList.update(this.orderedRecords(), this.activeId);
  }

  setActive(id) {
    this.activeId = id;
    const record = this.records.get(id);

    for (const [feedId, feed] of this.liveFeeds) {
      feed.style.display = feedId === id ? "" : "none";
    }
    let note = this.feeds.querySelector(".restored-note");
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
    this.startForm.showSession(record);
    this.statusEl.textContent = record?.status === "draft" ? "" : (record?.status ?? "");
    this.renderList();
  }
}

customElements.define("cc-app", CcApp);
