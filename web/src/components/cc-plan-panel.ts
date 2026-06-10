/**
 * <cc-plan-panel> — live-rendered plan markdown plus the plan-review bar
 * shown when Claude calls ExitPlanMode. Emits "plan-decision" with
 * { id, approved, feedback }.
 */

import { renderMarkdown } from "../markdown";
import type { PendingReview, SessionRecord } from "../store";

export interface PlanDecisionDetail {
  id: string;
  approved: boolean;
  feedback: string;
}

export class CcPlanPanel extends HTMLElement {
  private body!: HTMLElement;
  private empty!: HTMLElement;
  private filename!: HTMLElement;
  private review!: HTMLElement;
  private reviewId: string | null = null;

  connectedCallback(): void {
    this.innerHTML = `
      <div class="plan-header">
        <h2>Plan</h2>
        <span class="plan-filename muted"></span>
      </div>
      <div class="plan-empty muted">The plan will stream here when Claude writes one.</div>
      <article class="plan-body"></article>
      <div class="plan-review" hidden>
        <div class="review-title">Claude is ready to finalize this plan.</div>
        <div class="review-note muted" hidden>
          No plan content was provided for this review — Claude exited plan mode
          without writing a plan. Consider requesting changes and asking for a
          written plan.
        </div>
        <div class="allowed-prompts muted"></div>
        <textarea class="review-feedback" rows="2"
          placeholder="Optional: what should change? (used when requesting changes)"></textarea>
        <div class="row">
          <button class="approve">Approve plan</button>
          <button class="reject">Request changes</button>
        </div>
      </div>`;

    this.body = this.querySelector(".plan-body")!;
    this.empty = this.querySelector(".plan-empty")!;
    this.filename = this.querySelector(".plan-filename")!;
    this.review = this.querySelector(".plan-review")!;

    this.querySelector<HTMLButtonElement>(".approve")!.onclick = () => this.decide(true);
    this.querySelector<HTMLButtonElement>(".reject")!.onclick = () => this.decide(false);
  }

  /** Render plan + review state for the given session record. */
  showSession(record: SessionRecord | undefined): void {
    const hasPlan = Boolean(record?.plan);
    this.empty.hidden = hasPlan;
    this.filename.textContent = hasPlan ? (record?.planFilename ?? "") : "";
    this.body.innerHTML = hasPlan ? renderMarkdown(record!.plan) : "";
    if (record?.pendingReview) {
      this.showReview(record.pendingReview);
    } else {
      this.review.hidden = true;
      this.reviewId = null;
    }
  }

  updatePlan(record: SessionRecord): void {
    this.empty.hidden = true;
    this.filename.textContent = record.planFilename ?? "";
    this.body.innerHTML = renderMarkdown(record.plan);
  }

  showReview({ id, allowedPrompts }: PendingReview): void {
    this.reviewId = id;
    this.querySelector<HTMLElement>(".review-note")!.hidden = this.body.innerHTML.trim() !== "";
    this.querySelector(".allowed-prompts")!.textContent = allowedPrompts?.length
      ? `Implementation would need permission to: ${allowedPrompts.map((p) => p.prompt).join("; ")}`
      : "";
    this.querySelector<HTMLTextAreaElement>(".review-feedback")!.value = "";
    this.review.hidden = false;
  }

  private decide(approved: boolean): void {
    if (!this.reviewId) return;
    const detail: PlanDecisionDetail = {
      id: this.reviewId,
      approved,
      feedback: this.querySelector<HTMLTextAreaElement>(".review-feedback")!.value,
    };
    this.review.hidden = true;
    this.reviewId = null;
    this.dispatchEvent(
      new CustomEvent<PlanDecisionDetail>("plan-decision", { bubbles: true, detail }),
    );
  }
}

customElements.define("cc-plan-panel", CcPlanPanel);

declare global {
  interface HTMLElementTagNameMap {
    "cc-plan-panel": CcPlanPanel;
  }
}
