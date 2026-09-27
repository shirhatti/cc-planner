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

/** Within this many px of the bottom counts as "following" the feed. */
const STICK_THRESHOLD_PX = 40;

export class CcFeed extends HTMLElement {
  private hydrateLine: HTMLElement | null = null;
  private hydrateCount = 0;
  /**
   * Whether the user is following the feed (scrolled to within
   * STICK_THRESHOLD_PX of the bottom). Tracked from scroll events rather
   * than measured at append time, so content that grows after it lands
   * (async diff rendering) doesn't unstick the feed. Hidden feeds get no
   * scroll events and keep their state for when they're shown again.
   */
  private following = true;

  connectedCallback(): void {
    this.classList.add("feed");
    this.addEventListener("scroll", this.onScroll, { passive: true });
  }

  disconnectedCallback(): void {
    this.removeEventListener("scroll", this.onScroll);
  }

  private readonly onScroll = (): void => {
    this.following = this.scrollHeight - this.scrollTop - this.clientHeight <= STICK_THRESHOLD_PX;
  };

  /**
   * Run a DOM mutation, then keep the feed pinned to the bottom only if the
   * user was following it — scrolling up to read history isn't yanked back
   * by new output. Every feed mutation goes through here.
   */
  private appendAndFollow<T>(mutate: () => T): T {
    const result = mutate();
    if (this.following) this.scrollTop = this.scrollHeight;
    return result;
  }

  /** Build a feed item with `fill`, then append it (following if stuck). */
  private addItem(className: string, fill: (div: HTMLDivElement) => void): HTMLDivElement {
    const div = document.createElement("div");
    div.className = `feed-item ${className}`;
    fill(div);
    this.appendAndFollow(() => this.append(div));
    return div;
  }

  addInfo(text: string): void {
    this.addItem("info", (div) => (div.textContent = text));
  }

  addError(text: string): void {
    this.addItem("error-item", (div) => (div.textContent = text));
  }

  addUserMessage(text: string): void {
    this.addItem("user-message", (div) => (div.textContent = text));
  }

  addAssistant(md: string): void {
    this.addItem("assistant", (div) => (div.innerHTML = renderMarkdown(md)));
  }

  addTool(name: string, detail: string, diff?: DiffPayload): void {
    this.addItem("tool", (div) => {
      const nameEl = document.createElement("span");
      nameEl.className = "tool-name";
      nameEl.textContent = name;
      const detailEl = document.createElement("span");
      detailEl.className = "tool-detail";
      detailEl.textContent = detail ? ` ${detail}` : "";
      div.append(nameEl, detailEl);
    });
    if (diff) {
      this.appendAndFollow(() => {
        const diffEl = document.createElement("cc-diff");
        this.append(diffEl);
        diffEl.show(diff);
      });
    }
  }

  addQuestion(id: string, questions: UserQuestion[]): void {
    this.appendAndFollow(() => {
      const card = document.createElement("cc-question-card");
      this.append(card);
      card.setData({ id, questions });
    });
  }

  addPermission(id: string, toolName: string, detail: string, diff?: DiffPayload): void {
    // Built after connecting: cc-diff renders into a live container.
    this.appendAndFollow(() => {
      const card = document.createElement("div");
      card.className = "feed-item permission-card";
      this.append(card);
      this.fillPermission(card, id, toolName, detail, diff);
    });
  }

  private fillPermission(
    card: HTMLDivElement,
    id: string,
    toolName: string,
    detail: string,
    diff?: DiffPayload,
  ): void {
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
  }

  hydrateProgress(rel: string): void {
    this.hydrateCount += 1;
    const plural = this.hydrateCount === 1 ? "" : "s";
    const text = `Hydrated ${this.hydrateCount} file${plural} (latest: ${rel})`;
    if (this.hydrateLine) {
      const line = this.hydrateLine;
      this.appendAndFollow(() => (line.textContent = text));
    } else {
      this.hydrateLine = this.addItem("info", (div) => (div.textContent = text));
    }
  }
}

customElements.define("cc-feed", CcFeed);

declare global {
  interface HTMLElementTagNameMap {
    "cc-feed": CcFeed;
  }
}
