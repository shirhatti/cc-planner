/**
 * <cc-start-form> — for a draft session: repo/branch/prompt inputs, the
 * permission-mode picker, and the planner stop-on-approval toggle (repo
 * inputs are hidden in baked mode). For a started session: a read-only
 * summary.
 *
 * Emits "start-session" with { repo, branch, prompt, mode, stopOnPlanApproval }.
 */

import type { SessionMode } from "../../lib/protocol";
import type { SessionRecord } from "../store";

export interface StartSessionDetail {
  repo: string;
  branch: string;
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
      const form = document.createElement("form");
      form.className = "start-form";
      form.innerHTML = `
        <div class="row repo-row" ${this.workspaceMode === "baked" ? "hidden" : ""}>
          <input class="repo" type="text" placeholder="owner/repo" spellcheck="false" />
          <input class="branch" type="text" placeholder="branch (optional)" spellcheck="false" />
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

      const repoInput = form.querySelector<HTMLInputElement>(".repo")!;
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

      form.onsubmit = (ev) => {
        ev.preventDefault();
        const repo = repoInput.value.trim();
        const prompt = promptInput.value.trim();
        const errorEl = form.querySelector(".form-error")!;
        if (!prompt) {
          errorEl.textContent = "Enter a first message";
          return;
        }
        if (this.workspaceMode === "lazy" && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          errorEl.textContent = "Enter a repo as owner/repo";
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
              branch: form.querySelector<HTMLInputElement>(".branch")!.value.trim(),
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
