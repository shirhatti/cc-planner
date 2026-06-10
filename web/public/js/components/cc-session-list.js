/**
 * <cc-session-list> — sidebar list of planning sessions (live and restored
 * from localStorage). Emits "select-session" and "delete-session" with
 * { id }.
 */

const STATUS_LABELS = {
  draft: "draft",
  starting: "starting",
  running: "running",
  "awaiting-input": "needs input",
  reviewing: "review plan",
  approved: "approved",
  done: "done",
  stopped: "stopped",
  error: "error",
};

export class CcSessionList extends HTMLElement {
  /** @param {Array} sessions newest-first records; @param {string} activeId */
  update(sessions, activeId) {
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
      prompt.textContent = s.prompt || "New plan";

      const meta = document.createElement("div");
      meta.className = "session-meta muted";
      meta.textContent = `${STATUS_LABELS[s.status] ?? s.status} · ${new Date(s.createdAt).toLocaleString()}`;

      item.append(top, prompt, meta);
      this.append(item);
    }
  }
}

customElements.define("cc-session-list", CcSessionList);
