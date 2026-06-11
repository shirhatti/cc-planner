/**
 * localStorage persistence for sessions and gateway settings.
 *
 * Live transcript feeds are not persisted — after a reload a session shows
 * its saved plan and metadata only.
 */

import type { AuthConfig, HydrateStrategy, SessionMode, SessionStats } from "../lib/protocol";

/** App-wide settings persisted in localStorage (auth + workspace knobs). */
export interface AppSettings extends AuthConfig {
  /** Hydration strategy for lazy sessions; "auto" lets the server decide. */
  strategy?: HydrateStrategy | "auto";
}

export type SessionStatus =
  | "draft"
  | "starting"
  | "running"
  | "idle"
  | "awaiting-input"
  | "reviewing"
  | "approved"
  | "done"
  | "stopped"
  | "error";

/** Statuses with a live claude process behind them. */
export const LIVE_STATUSES: SessionStatus[] = [
  "starting",
  "running",
  "idle",
  "awaiting-input",
  "reviewing",
];

export interface PendingReview {
  id: string;
  allowedPrompts: { tool: string; prompt: string }[];
}

export interface SessionRecord {
  id: string;
  status: SessionStatus;
  prompt: string;
  repo: string;
  branch: string;
  mode: SessionMode;
  stopOnPlanApproval: boolean;
  plan: string;
  planFilename: string;
  createdAt: number;
  startedAt?: number;
  ref?: string;
  model?: string;
  stats?: SessionStats;
  costUsd?: number;
  pendingReview?: PendingReview | null;
}

const SESSIONS_KEY = "claude-web-tty.sessions.v1";
const SETTINGS_KEY = "claude-web-tty.settings.v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled — persistence is best-effort.
  }
}

export function newId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random()}`;
}

/** @returns session records, newest first */
export function loadSessions(): SessionRecord[] {
  const sessions = read<SessionRecord[]>(SESSIONS_KEY, []);
  // Sessions can't survive a reload; anything still "live" was cut off.
  for (const s of sessions) {
    if (LIVE_STATUSES.includes(s.status)) {
      s.status = "stopped";
    }
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

export function saveSession(record: SessionRecord): void {
  const sessions = read<SessionRecord[]>(SESSIONS_KEY, []);
  const idx = sessions.findIndex((s) => s.id === record.id);
  if (idx >= 0) sessions[idx] = record;
  else sessions.push(record);
  write(SESSIONS_KEY, sessions);
}

export function deleteSession(id: string): void {
  write(
    SESSIONS_KEY,
    read<SessionRecord[]>(SESSIONS_KEY, []).filter((s) => s.id !== id),
  );
}

export function loadSettings(): AppSettings {
  return read<AppSettings>(SETTINGS_KEY, {});
}

export function saveSettings(settings: AppSettings): void {
  write(SETTINGS_KEY, settings);
}
