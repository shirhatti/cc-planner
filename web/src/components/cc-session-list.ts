/**
 * <cc-session-list> — sidebar list of sessions (live and restored from
 * localStorage). Emits "select-session" and "delete-session" with { id }.
 */

import type { SessionRecord, SessionStatus } from "../store";

const STATUS_LABELS: Record<SessionStatus, string> = {
  draft: "draft",
  starting: "starting",
  running: "running",
  idle: "awaiting message",
  "awaiting-input": "needs input",
  reviewing: "review plan",
  approved: "approved",
  done: "done",
  stopped: "stopped",
  error: "error",
};

export class CcSessionList extends HTMLElement {
  update(sessions: SessionRecord[], activeId: string | null): void {
    this.innerHTML = "";
    for (const s of sessions) {
      const item = document.createElement("div");
      item.className = `session-item${s.id === activeId ? " active" : ""}`;
      item.onclick = () =>
        this.dispatchEvent(
          new CustomEvent("select-session", { bubbles: true, detail: { id: s.id } }),
        );

      const top = document.createElement("div");
      top.className = "session-top";
      const status = document.createElement("span");
      status.className = `status-dot ${s.status}`;
      status.title = STATUS_LABELS[s.status] ?? s.status;
      const repo = document.createElement("span");
      repo.className = "session-repo";
      repo.textContent = s.repo || "(no repo)";
      const del = document.createElement("button");
      del.className = "session-delete";
      del.textContent = "×";
      del.title = "Delete session";
      del.onclick = (ev) => {
        ev.stopPropagation();
        this.dispatchEvent(
          new CustomEvent("delete-session", { bubbles: true, detail: { id: s.id } }),
        );
      };
      top.append(status, repo, del);

      const prompt = document.createElement("div");
      prompt.className = "session-prompt";
      prompt.textContent = s.prompt || "New session";

      const meta = document.createElement("div");
      meta.className = "session-meta muted";
      meta.textContent = `${s.mode ?? "plan"} · ${STATUS_LABELS[s.status] ?? s.status} · ${new Date(s.createdAt).toLocaleString()}`;

      item.append(top, prompt, meta);
      this.append(item);
    }
  }
}

customElements.define("cc-session-list", CcSessionList);

declare global {
  interface HTMLElementTagNameMap {
    "cc-session-list": CcSessionList;
  }
}
