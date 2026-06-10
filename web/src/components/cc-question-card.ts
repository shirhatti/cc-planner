/**
 * <cc-question-card> — renders one AskUserQuestion tool call (1-4 questions,
 * each with 2-4 options, optional multi-select, plus an "Other" free-text
 * input). Emits "answer-question" with { id, answers } where answers is
 * keyed by question text, matching the tool's expected input.
 */

import type { UserQuestion } from "../../lib/protocol";

export interface AnswerQuestionDetail {
  id: string;
  answers: Record<string, string>;
}

export class CcQuestionCard extends HTMLElement {
  private toolUseId = "";
  private questions: UserQuestion[] = [];
  private selections: Set<string>[] = [];
  private others: string[] = [];
  private submitBtn?: HTMLButtonElement;

  setData({ id, questions }: { id: string; questions: UserQuestion[] }): void {
    this.toolUseId = id;
    this.questions = questions;
    this.selections = questions.map(() => new Set());
    this.others = questions.map(() => "");
    this.render();
  }

  private render(): void {
    this.innerHTML = "";
    this.classList.add("question-card");

    this.questions.forEach((q, qi) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = q.header || "Question";

      const text = document.createElement("div");
      text.className = "q-text";
      text.textContent = q.question;
      this.append(chip, text);

      for (const opt of q.options) {
        const div = document.createElement("div");
        div.className = "option";
        div.dataset.q = String(qi);
        const label = document.createElement("span");
        label.textContent = opt.label;
        const desc = document.createElement("span");
        desc.className = "opt-desc";
        desc.textContent = opt.description || "";
        div.append(label, desc);
        div.onclick = () => this.toggle(qi, opt.label, div, q.multiSelect);
        this.append(div);
      }

      const other = document.createElement("input");
      other.className = "other";
      other.placeholder = "Other (free text)";
      other.oninput = () => (this.others[qi] = other.value);
      this.append(other);
    });

    const row = document.createElement("div");
    row.className = "row submit-row";
    this.submitBtn = document.createElement("button");
    this.submitBtn.textContent = "Submit answers";
    this.submitBtn.onclick = () => this.submit();
    row.append(this.submitBtn);
    this.append(row);
  }

  private toggle(qi: number, label: string, div: HTMLElement, multiSelect?: boolean): void {
    if (this.classList.contains("answered")) return;
    if (multiSelect) {
      if (this.selections[qi].has(label)) this.selections[qi].delete(label);
      else this.selections[qi].add(label);
      div.classList.toggle("selected");
    } else {
      this.selections[qi] = new Set([label]);
      for (const el of this.querySelectorAll(`.option[data-q="${qi}"]`)) {
        el.classList.remove("selected");
      }
      div.classList.add("selected");
    }
  }

  private submit(): void {
    const answers: Record<string, string> = {};
    this.questions.forEach((q, qi) => {
      const picked = [...this.selections[qi]];
      if (this.others[qi].trim()) picked.push(this.others[qi].trim());
      if (picked.length) answers[q.question] = picked.join(", ");
    });
    if (Object.keys(answers).length < this.questions.length) {
      if (this.submitBtn) {
        this.submitBtn.textContent = "Answer every question first";
        setTimeout(() => {
          if (this.submitBtn) this.submitBtn.textContent = "Submit answers";
        }, 1500);
      }
      return;
    }
    this.classList.add("answered");
    this.querySelector(".submit-row")?.remove();
    this.dispatchEvent(
      new CustomEvent<AnswerQuestionDetail>("answer-question", {
        bubbles: true,
        detail: { id: this.toolUseId, answers },
      }),
    );
  }
}

customElements.define("cc-question-card", CcQuestionCard);

declare global {
  interface HTMLElementTagNameMap {
    "cc-question-card": CcQuestionCard;
  }
}
