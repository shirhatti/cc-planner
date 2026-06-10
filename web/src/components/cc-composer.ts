/**
 * <cc-composer> — the TTY input line for a live session: a message box plus
 * turn/session controls. Emits "send-message" { text }, "stop-turn", and
 * "end-session" (no detail).
 */

export class CcComposer extends HTMLElement {
  private textarea!: HTMLTextAreaElement;

  connectedCallback(): void {
    this.innerHTML = `
      <div class="composer">
        <textarea rows="2" placeholder="Message Claude… (Enter to send, Shift+Enter for newline)"></textarea>
        <div class="composer-buttons">
          <button class="send">Send</button>
          <button class="stop-turn" title="Interrupt the current turn">Stop turn</button>
          <button class="end-session" title="Close input; Claude finishes and exits">End session</button>
        </div>
      </div>`;

    this.textarea = this.querySelector("textarea")!;
    this.textarea.onkeydown = (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        this.send();
      }
    };
    this.querySelector<HTMLButtonElement>(".send")!.onclick = () => this.send();
    this.querySelector<HTMLButtonElement>(".stop-turn")!.onclick = () =>
      this.dispatchEvent(new CustomEvent("stop-turn", { bubbles: true }));
    this.querySelector<HTMLButtonElement>(".end-session")!.onclick = () =>
      this.dispatchEvent(new CustomEvent("end-session", { bubbles: true }));
  }

  private send(): void {
    const text = this.textarea.value.trim();
    if (!text) return;
    this.textarea.value = "";
    this.dispatchEvent(new CustomEvent("send-message", { bubbles: true, detail: { text } }));
  }
}

customElements.define("cc-composer", CcComposer);

declare global {
  interface HTMLElementTagNameMap {
    "cc-composer": CcComposer;
  }
}
