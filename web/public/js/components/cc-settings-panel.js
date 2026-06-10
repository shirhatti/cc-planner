/**
 * <cc-settings-panel> — gateway settings (Anthropic base URL + bearer
 * token), persisted in localStorage and applied to every newly started
 * session. Supports routing through an LLM gateway (e.g. LiteLLM, portkey)
 * instead of api.anthropic.com.
 */

import { loadSettings, saveSettings } from "../store.js";

export class CcSettingsPanel extends HTMLElement {
  connectedCallback() {
    const settings = loadSettings();
    this.innerHTML = `
      <details class="settings">
        <summary>Gateway settings</summary>
        <label>
          <span>Anthropic base URL</span>
          <input class="base-url" type="text" placeholder="https://gateway.example.com" spellcheck="false" />
        </label>
        <label>
          <span>Bearer token</span>
          <input class="auth-token" type="password" placeholder="sk-..." spellcheck="false" />
        </label>
        <div class="muted">Stored in this browser; sent with each new session. Leave empty to use the server's environment.</div>
      </details>`;

    const baseUrl = this.querySelector(".base-url");
    const authToken = this.querySelector(".auth-token");
    baseUrl.value = settings.baseUrl ?? "";
    authToken.value = settings.authToken ?? "";

    const persist = () =>
      saveSettings({ baseUrl: baseUrl.value.trim(), authToken: authToken.value.trim() });
    baseUrl.onchange = persist;
    authToken.onchange = persist;
  }
}

customElements.define("cc-settings-panel", CcSettingsPanel);
