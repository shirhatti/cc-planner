/**
 * <cc-plan-panel> — live-rendered plan markdown plus the plan-review bar
 * shown when Claude calls ExitPlanMode. Emits "plan-decision" with
 * { id, approved, feedback }.
 */

import { renderMarkdown } from "../markdown.js";

export class CcPlanPanel extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="plan-header">
        <h2>Plan</h2>
        <span class="plan-filename muted"></span>
      </div>
      <div class="plan-empty muted">The plan will stream here as Claude writes it.</div>
      <article class="plan-body"></article>
      <div class="plan-review" hidden>
        <div class="review-title">Claude is ready to finalize this plan.</div>
        <div class="allowed-prompts muted"></div>
        <textarea class="review-feedback" rows="2"
          placeholder="Optional: what should change? (used when requesting changes)"></textarea>
        <div class="row">
          <button class="approve">Approve plan</button>
          <button class="reject">Request changes</button>
        </div>
      </div>`;

    this.body = this.querySelector(".plan-body");
    this.empty = this.querySelector(".plan-empty");
    this.filename = this.querySelector(".plan-filename");
    this.review = this.querySelector(".plan-review");
    this.reviewId = null;

    this.querySelector(".approve").onclick = () => this.decide(true);
    this.querySelector(".reject").onclick = () => this.decide(false);
  }

  /** Render plan + review state for the given session record. */
  showSession(record) {
    const hasPlan = Boolean(record?.plan);
    this.empty.hidden = hasPlan;
    this.filename.textContent = hasPlan ? (record.planFilename ?? "") : "";
    this.body.innerHTML = hasPlan ? renderMarkdown(record.plan) : "";
    if (record?.pendingReview) {
      this.showReview(record.pendingReview);
    } else {
      this.review.hidden = true;
      this.reviewId = null;
    }
  }

  updatePlan(record) {
    this.empty.hidden = true;
    this.filename.textContent = record.planFilename ?? "";
    this.body.innerHTML = renderMarkdown(record.plan);
  }

  showReview({ id, allowedPrompts }) {
    this.reviewId = id;
    this.querySelector(".allowed-prompts").textContent = allowedPrompts?.length
      ? `Implementation would need permission to: ${allowedPrompts.map((p) => p.prompt).join("; ")}`
      : "";
    this.querySelector(".review-feedback").value = "";
    this.review.hidden = false;
  }

  decide(approved) {
    if (!this.reviewId) return;
    const detail = {
      id: this.reviewId,
      approved,
      feedback: this.querySelector(".review-feedback").value,
    };
    this.review.hidden = true;
    this.reviewId = null;
    this.dispatchEvent(new CustomEvent("plan-decision", { bubbles: true, detail }));
  }
}

customElements.define("cc-plan-panel", CcPlanPanel);
