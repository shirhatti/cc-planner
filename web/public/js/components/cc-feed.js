/**
 * <cc-feed> — append-only activity transcript for one planning session:
 * assistant text (markdown), tool activity, hydration progress, info/error
 * lines, and inline <cc-question-card>s. One instance exists per live
 * session; cc-app shows/hides them when switching sessions.
 */

import { renderMarkdown } from "../markdown.js";
import "./cc-question-card.js";

export class CcFeed extends HTMLElement {
  connectedCallback() {
    this.classList.add("feed");
    this.hydrateLine = null;
    this.hydrateCount = 0;
  }

  addItem(className) {
    const div = document.createElement("div");
    div.className = `feed-item ${className}`;
    this.append(div);
    this.scrollTop = this.scrollHeight;
    return div;
  }

  addInfo(text) {
    this.addItem("info").textContent = text;
  }

  addError(text) {
    this.addItem("error-item").textContent = text;
  }

  addAssistant(md) {
    this.addItem("assistant").innerHTML = renderMarkdown(md);
  }

  addTool(name, detail) {
    const div = this.addItem("tool");
    const nameEl = document.createElement("span");
    nameEl.className = "tool-name";
    nameEl.textContent = name;
    const detailEl = document.createElement("span");
    detailEl.className = "tool-detail";
    detailEl.textContent = detail ? ` ${detail}` : "";
    div.append(nameEl, detailEl);
  }

  addQuestion(id, questions) {
    const card = document.createElement("cc-question-card");
    this.append(card);
    card.setData({ id, questions });
    this.scrollTop = this.scrollHeight;
  }

  hydrateProgress(rel) {
    this.hydrateCount += 1;
    if (!this.hydrateLine) this.hydrateLine = this.addItem("info");
    const plural = this.hydrateCount === 1 ? "" : "s";
    this.hydrateLine.textContent = `Hydrated ${this.hydrateCount} file${plural} (latest: ${rel})`;
  }
}

customElements.define("cc-feed", CcFeed);
