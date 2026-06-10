/**
 * <cc-start-form> — for a draft session: repo/branch/prompt inputs and a
 * Start button (repo inputs are hidden in baked mode). For a started
 * session: a read-only summary with a Stop button while it's live.
 *
 * Emits "start-session" with { repo, branch, prompt } and
 * "interrupt-session" (no detail).
 */

const LIVE_STATUSES = ["starting", "running", "awaiting-input", "reviewing"];

export class CcStartForm extends HTMLElement {
  constructor() {
    super();
    this.mode = "lazy";
    this.record = null;
  }

  setMode(mode) {
    this.mode = mode;
    this.render();
  }

  showSession(record) {
    this.record = record;
    this.render();
  }

  render() {
    const record = this.record;
    this.innerHTML = "";
    if (!record) return;

    if (record.status === "draft") {
      const form = document.createElement("form");
      form.className = "start-form";
      form.innerHTML = `
        <div class="row repo-row" ${this.mode === "baked" ? "hidden" : ""}>
          <input class="repo" type="text" placeholder="owner/repo" spellcheck="false" />
          <input class="branch" type="text" placeholder="branch (optional)" spellcheck="false" />
        </div>
        <textarea class="prompt" rows="3"
          placeholder="What should Claude plan? e.g. “Create a plan for adding rate limiting to the API”"></textarea>
        <div class="row">
          <button type="submit">Start planning</button>
          <span class="form-error muted"></span>
        </div>`;
      form.querySelector(".repo").value = record.repo ?? "";
      form.querySelector(".prompt").value = record.prompt ?? "";
      form.onsubmit = (ev) => {
        ev.preventDefault();
        const repo = form.querySelector(".repo").value.trim();
        const prompt = form.querySelector(".prompt").value.trim();
        if (!prompt) {
          form.querySelector(".form-error").textContent = "Enter a planning prompt";
          return;
        }
        if (this.mode === "lazy" && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          form.querySelector(".form-error").textContent = "Enter a repo as owner/repo";
          return;
        }
        this.dispatchEvent(
          new CustomEvent("start-session", {
            bubbles: true,
            detail: { repo, branch: form.querySelector(".branch").value.trim(), prompt },
          }),
        );
      };
      this.append(form);
      return;
    }

    const summary = document.createElement("div");
    summary.className = "session-summary";
    const prompt = document.createElement("div");
    prompt.className = "summary-prompt";
    prompt.textContent = record.prompt;
    const meta = document.createElement("div");
    meta.className = "row summary-meta";
    const repo = document.createElement("span");
    repo.className = "muted";
    repo.textContent = record.repo + (record.ref ? ` @ ${record.ref.slice(0, 8)}` : "");
    meta.append(repo);
    if (LIVE_STATUSES.includes(record.status)) {
      const stop = document.createElement("button");
      stop.className = "stop";
      stop.textContent = "Stop";
      stop.onclick = () =>
        this.dispatchEvent(new CustomEvent("interrupt-session", { bubbles: true }));
      meta.append(stop);
    }
    summary.append(prompt, meta);
    this.append(summary);
  }
}

customElements.define("cc-start-form", CcStartForm);
