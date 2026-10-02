/**
 * App settings, persisted in localStorage and applied to every newly
 * started session. Covers what used to require server env vars (important
 * for the desktop app, where there's no shell to set them): Anthropic auth
 * (API key, or gateway base URL + bearer token) and the hydration strategy
 * for lazy sessions.
 */

import { Settings } from "lucide-react";
import { useState } from "react";
import { loadSettings, saveSettings, type AppSettings } from "../store";

const STRATEGY_OPTIONS: { value: NonNullable<AppSettings["strategy"]>; label: string }[] = [
  { value: "auto", label: "Auto (gh when available, else git)" },
  { value: "gh", label: "gh — GitHub contents API" },
  { value: "git", label: "git — promisor lazy fetch" },
];

export function SettingsPanel() {
  const [settings, setSettings] = useState<AppSettings>(() => ({
    strategy: "auto",
    ...loadSettings(),
  }));

  const update = (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings({
      apiKey: next.apiKey?.trim(),
      baseUrl: next.baseUrl?.trim(),
      authToken: next.authToken?.trim(),
      strategy: next.strategy,
    });
  };

  const text = (key: "apiKey" | "baseUrl" | "authToken", label: string, placeholder: string) => (
    <label className="block space-y-1">
      <span className="text-muted text-xs">{label}</span>
      <input
        className="w-full"
        type={key === "baseUrl" ? "text" : "password"}
        placeholder={placeholder}
        spellCheck={false}
        value={settings[key] ?? ""}
        onChange={(e) => update({ [key]: e.target.value })}
      />
    </label>
  );

  return (
    <details className="border-border border-t">
      <summary className="text-muted hover:text-fg flex cursor-pointer items-center gap-2 px-3 py-2.5">
        <Settings className="size-4" /> Settings
      </summary>
      <div className="space-y-3 px-3 pb-3">
        {text("apiKey", "Anthropic API key", "sk-ant-...")}
        {text("baseUrl", "Anthropic base URL (gateway)", "https://gateway.example.com")}
        {text("authToken", "Bearer token (gateway)", "sk-...")}
        <label className="block space-y-1">
          <span className="text-muted text-xs">Hydration strategy (lazy sessions)</span>
          <select
            className="w-full"
            value={settings.strategy ?? "auto"}
            onChange={(e) => update({ strategy: e.target.value as AppSettings["strategy"] })}
          >
            {STRATEGY_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-muted text-xs">
          Stored in this browser; sent with each new session. Leave auth empty to use the server's
          environment (e.g. an existing claude login).
        </p>
      </div>
    </details>
  );
}
