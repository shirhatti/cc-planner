/**
 * <cc-feed> — append-only transcript for one session: user/assistant
 * messages, tool activity (with diffs for Edit/Write), hydration progress,
 * info/error lines, inline <cc-question-card>s, and permission cards. One
 * instance exists per live session; cc-app shows/hides them when switching.
 */

import type { DiffPayload, UserQuestion } from "../../lib/protocol";
import { renderMarkdown } from "../markdown";
import "./cc-diff";
import "./cc-question-card";

export interface PermissionDecisionDetail {
  id: string;
  allow: boolean;
  always?: boolean;
}

export class CcFeed extends HTMLElement {
  private hydrateLine: HTMLElement | null = null;
  private hydrateCount = 0;

  connectedCallback(): void {
    this.classList.add("feed");
  }

  private addItem(className: string): HTMLDivElement {
    const div = document.createElement("div");
    div.className = `feed-item ${className}`;
    this.append(div);
    this.scrollTop = this.scrollHeight;
    return div;
  }

  addInfo(text: string): void {
    this.addItem("info").textContent = text;
  }

  addError(text: string): void {
    this.addItem("error-item").textContent = text;
  }

  addUserMessage(text: string): void {
    this.addItem("user-message").textContent = text;
  }

  addAssistant(md: string): void {
    this.addItem("assistant").innerHTML = renderMarkdown(md);
  }

  addTool(name: string, detail: string, diff?: DiffPayload): void {
    const div = this.addItem("tool");
    const nameEl = document.createElement("span");
    nameEl.className = "tool-name";
    nameEl.textContent = name;
    const detailEl = document.createElement("span");
    detailEl.className = "tool-detail";
    detailEl.textContent = detail ? ` ${detail}` : "";
    div.append(nameEl, detailEl);
    if (diff) {
      const diffEl = document.createElement("cc-diff");
      this.append(diffEl);
      diffEl.show(diff);
      this.scrollTop = this.scrollHeight;
    }
  }

  addQuestion(id: string, questions: UserQuestion[]): void {
    const card = document.createElement("cc-question-card");
    this.append(card);
    card.setData({ id, questions });
    this.scrollTop = this.scrollHeight;
  }

  addPermission(id: string, toolName: string, detail: string, diff?: DiffPayload): void {
    const card = this.addItem("permission-card");

    const title = document.createElement("div");
    title.className = "permission-title";
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = "Permission";
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = toolName;
    const detailEl = document.createElement("span");
    detailEl.className = "tool-detail";
    detailEl.textContent = detail ? ` ${detail}` : "";
    title.append(chip, name, detailEl);
    card.append(title);

    if (diff) {
      const diffEl = document.createElement("cc-diff");
      card.append(diffEl);
      diffEl.show(diff);
    }

    const row = document.createElement("div");
    row.className = "row submit-row";
    const decide = (allow: boolean, always?: boolean): void => {
      card.classList.add("answered");
      row.remove();
      const verdict = document.createElement("div");
      verdict.className = "muted";
      verdict.textContent = allow ? (always ? "Always allowed" : "Allowed") : "Denied";
      card.append(verdict);
      this.dispatchEvent(
        new CustomEvent<PermissionDecisionDetail>("permission-decision", {
          bubbles: true,
          detail: { id, allow, always },
        }),
      );
    };
    const allowBtn = document.createElement("button");
    allowBtn.className = "approve";
    allowBtn.textContent = "Allow";
    allowBtn.onclick = () => decide(true);
    const alwaysBtn = document.createElement("button");
    alwaysBtn.textContent = "Always allow";
    alwaysBtn.onclick = () => decide(true, true);
    const denyBtn = document.createElement("button");
    denyBtn.className = "reject";
    denyBtn.textContent = "Deny";
    denyBtn.onclick = () => decide(false);
    row.append(allowBtn, alwaysBtn, denyBtn);
    card.append(row);
    this.scrollTop = this.scrollHeight;
  }

  hydrateProgress(rel: string): void {
    this.hydrateCount += 1;
    if (!this.hydrateLine) this.hydrateLine = this.addItem("info");
    const plural = this.hydrateCount === 1 ? "" : "s";
    this.hydrateLine.textContent = `Hydrated ${this.hydrateCount} file${plural} (latest: ${rel})`;
  }
}

customElements.define("cc-feed", CcFeed);

declare global {
  interface HTMLElementTagNameMap {
    "cc-feed": CcFeed;
  }
}
