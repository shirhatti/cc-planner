/**
 * <cc-start-form> — for a draft session: workspace source (GitHub repo,
 * local folder on the server's machine, or the server's baked default),
 * prompt input, the permission-mode picker, and the planner
 * stop-on-approval toggle. For a started session: a read-only summary.
 *
 * Emits "start-session" with { repo, branch, localPath, prompt, mode, ... }.
 */

import type { SessionMode } from "../../lib/protocol";
import type { SessionRecord } from "../store";

export interface StartSessionDetail {
  repo: string;
  branch: string;
  /** Absolute path (~ ok) of a checkout on the server's filesystem. */
  localPath: string;
  prompt: string;
  mode: SessionMode;
  stopOnPlanApproval: boolean;
  appendSystemPrompt: string;
  allowedTools: string[];
  disallowedTools: string[];
}

const MODE_OPTIONS: { value: SessionMode; label: string }[] = [
  { value: "plan", label: "Plan mode" },
  { value: "default", label: "Default (ask permissions)" },
  { value: "acceptEdits", label: "Accept edits" },
];

export class CcStartForm extends HTMLElement {
  private workspaceMode: "baked" | "lazy" = "lazy";
  private record: SessionRecord | null = null;

  setWorkspaceMode(mode: "baked" | "lazy"): void {
    this.workspaceMode = mode;
    this.render();
  }

  showSession(record: SessionRecord | undefined): void {
    this.record = record ?? null;
    this.render();
  }

  private render(): void {
    const record = this.record;
    this.innerHTML = "";
    if (!record) return;

    if (record.status === "draft") {
      const baked = this.workspaceMode === "baked";
      const form = document.createElement("form");
      form.className = "start-form";
      form.innerHTML = `
        <div class="row">
          <select class="source">
            ${baked ? `<option value="baked">Server repo (baked)</option>` : ""}
            <option value="repo">GitHub repo</option>
            <option value="local">Local folder</option>
          </select>
        </div>
        <div class="row repo-row" ${baked ? "hidden" : ""}>
          <input class="repo" type="text" placeholder="owner/repo" spellcheck="false" />
          <input class="branch" type="text" placeholder="branch (optional)" spellcheck="false" />
        </div>
        <div class="row local-row" hidden>
          <input class="local-path" type="text"
            placeholder="/absolute/path/to/checkout or ~/code/repo" spellcheck="false" />
        </div>
        <div class="row">
          <select class="mode">
            ${MODE_OPTIONS.map((m) => `<option value="${m.value}">${m.label}</option>`).join("")}
          </select>
          <label class="stop-on-approval">
            <input type="checkbox" class="stop" checked />
            <span>End session when plan is approved</span>
          </label>
        </div>
        <textarea class="prompt" rows="3"
          placeholder="What should Claude do? This starts the session — you can keep chatting after."></textarea>
        <details class="advanced">
          <summary class="muted">Advanced</summary>
          <label>
            <span class="muted">Extra system prompt (appended to Claude Code's)</span>
            <textarea class="append-prompt" rows="2"
              placeholder="e.g. Always answer in French. Keep plans under 10 bullets."></textarea>
          </label>
          <label>
            <span class="muted">Always-allowed tools (comma-separated; Bash(...) patterns work)</span>
            <input class="allowed-tools" type="text"
              placeholder="e.g. Bash(bun test:*), WebFetch" spellcheck="false" />
          </label>
          <label>
            <span class="muted">Disallowed tools (removed from the session)</span>
            <input class="disallowed-tools" type="text"
              placeholder="e.g. WebSearch, NotebookEdit" spellcheck="false" />
          </label>
        </details>
        <div class="row">
          <button type="submit">Start session</button>
          <span class="form-error muted"></span>
        </div>`;

      const sourceSelect = form.querySelector<HTMLSelectElement>(".source")!;
      const repoRow = form.querySelector<HTMLElement>(".repo-row")!;
      const localRow = form.querySelector<HTMLElement>(".local-row")!;
      const repoInput = form.querySelector<HTMLInputElement>(".repo")!;
      const localInput = form.querySelector<HTMLInputElement>(".local-path")!;
      const promptInput = form.querySelector<HTMLTextAreaElement>(".prompt")!;
      const modeSelect = form.querySelector<HTMLSelectElement>(".mode")!;
      const stopLabel = form.querySelector<HTMLElement>(".stop-on-approval")!;
      const stopCheckbox = form.querySelector<HTMLInputElement>(".stop")!;
      repoInput.value = record.repo ?? "";
      promptInput.value = record.prompt ?? "";
      modeSelect.value = record.mode ?? "plan";
      modeSelect.onchange = () => {
        stopLabel.hidden = modeSelect.value !== "plan";
      };
      sourceSelect.value = baked ? "baked" : "repo";
      sourceSelect.onchange = () => {
        repoRow.hidden = sourceSelect.value !== "repo";
        localRow.hidden = sourceSelect.value !== "local";
      };

      form.onsubmit = (ev) => {
        ev.preventDefault();
        const source = sourceSelect.value;
        const repo = source === "repo" ? repoInput.value.trim() : "";
        const localPath = source === "local" ? localInput.value.trim() : "";
        const prompt = promptInput.value.trim();
        const errorEl = form.querySelector(".form-error")!;
        if (!prompt) {
          errorEl.textContent = "Enter a first message";
          return;
        }
        if (source === "repo" && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          errorEl.textContent = "Enter a repo as owner/repo";
          return;
        }
        if (source === "local" && !/^[~/]/.test(localPath)) {
          errorEl.textContent = "Enter an absolute folder path (or ~/...)";
          return;
        }
        const csv = (selector: string): string[] =>
          form
            .querySelector<HTMLInputElement>(selector)!
            .value.split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        this.dispatchEvent(
          new CustomEvent<StartSessionDetail>("start-session", {
            bubbles: true,
            detail: {
              repo,
              branch:
                source === "repo"
                  ? form.querySelector<HTMLInputElement>(".branch")!.value.trim()
                  : "",
              localPath,
              prompt,
              mode: modeSelect.value as SessionMode,
              stopOnPlanApproval: stopCheckbox.checked,
              appendSystemPrompt: form
                .querySelector<HTMLTextAreaElement>(".append-prompt")!
                .value.trim(),
              allowedTools: csv(".allowed-tools"),
              disallowedTools: csv(".disallowed-tools"),
            },
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
    meta.className = "summary-meta muted";
    meta.textContent =
      record.repo +
      (record.ref ? ` @ ${record.ref.slice(0, 8)}` : "") +
      ` · ${record.mode ?? "plan"} mode`;
    summary.append(prompt, meta);
    this.append(summary);
  }
}

customElements.define("cc-start-form", CcStartForm);

declare global {
  interface HTMLElementTagNameMap {
    "cc-start-form": CcStartForm;
  }
}
