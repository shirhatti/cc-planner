/**
 * <cc-settings-panel> — app settings, persisted in localStorage and applied
 * to every newly started session. Covers what used to require server env
 * vars (important for the desktop app, where there's no shell to set them):
 * Anthropic auth (API key, or gateway base URL + bearer token) and the
 * hydration strategy for lazy sessions.
 */

import { loadSettings, saveSettings, type AppSettings } from "../store";

const STRATEGY_OPTIONS: { value: NonNullable<AppSettings["strategy"]>; label: string }[] = [
  { value: "auto", label: "Auto (gh when available, else git)" },
  { value: "gh", label: "gh — GitHub contents API" },
  { value: "git", label: "git — promisor lazy fetch" },
];

export class CcSettingsPanel extends HTMLElement {
  connectedCallback(): void {
    const settings = loadSettings();
    this.innerHTML = `
      <details class="settings">
        <summary>Settings</summary>
        <label>
          <span>Anthropic API key</span>
          <input class="api-key" type="password" placeholder="sk-ant-..." spellcheck="false" />
        </label>
        <label>
          <span>Anthropic base URL (gateway)</span>
          <input class="base-url" type="text" placeholder="https://gateway.example.com" spellcheck="false" />
        </label>
        <label>
          <span>Bearer token (gateway)</span>
          <input class="auth-token" type="password" placeholder="sk-..." spellcheck="false" />
        </label>
        <label>
          <span>Hydration strategy (lazy sessions)</span>
          <select class="strategy">
            ${STRATEGY_OPTIONS.map((s) => `<option value="${s.value}">${s.label}</option>`).join("")}
          </select>
        </label>
        <div class="muted">Stored in this browser; sent with each new session. Leave auth empty to use the server's environment (e.g. an existing claude login).</div>
      </details>`;

    const apiKey = this.querySelector<HTMLInputElement>(".api-key")!;
    const baseUrl = this.querySelector<HTMLInputElement>(".base-url")!;
    const authToken = this.querySelector<HTMLInputElement>(".auth-token")!;
    const strategy = this.querySelector<HTMLSelectElement>(".strategy")!;
    apiKey.value = settings.apiKey ?? "";
    baseUrl.value = settings.baseUrl ?? "";
    authToken.value = settings.authToken ?? "";
    strategy.value = settings.strategy ?? "auto";

    const persist = (): void =>
      saveSettings({
        apiKey: apiKey.value.trim(),
        baseUrl: baseUrl.value.trim(),
        authToken: authToken.value.trim(),
        strategy: strategy.value as AppSettings["strategy"],
      });
    apiKey.onchange = persist;
    baseUrl.onchange = persist;
    authToken.onchange = persist;
    strategy.onchange = persist;
  }
}

customElements.define("cc-settings-panel", CcSettingsPanel);

declare global {
  interface HTMLElementTagNameMap {
    "cc-settings-panel": CcSettingsPanel;
  }
}
