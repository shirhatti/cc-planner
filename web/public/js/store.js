/**
 * localStorage persistence for planning sessions and gateway settings.
 *
 * A persisted session record:
 *   { id, prompt, repo, branch, ref, status, plan, planFilename,
 *     createdAt, costUsd, model }
 *
 * Live transcript feeds are not persisted — after a reload a session shows
 * its saved plan and metadata only.
 */

const SESSIONS_KEY = "cc-planner.sessions.v1";
const SETTINGS_KEY = "cc-planner.settings.v1";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled — persistence is best-effort.
  }
}

export function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random()}`;
}

/** @returns {Array} session records, newest first */
export function loadSessions() {
  const sessions = read(SESSIONS_KEY, []);
  // Sessions can't survive a reload; anything still "live" was cut off.
  for (const s of sessions) {
    if (["running", "awaiting-input", "reviewing", "starting"].includes(s.status)) {
      s.status = "stopped";
    }
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

export function saveSession(record) {
  const sessions = read(SESSIONS_KEY, []);
  const idx = sessions.findIndex((s) => s.id === record.id);
  if (idx >= 0) sessions[idx] = record;
  else sessions.push(record);
  write(SESSIONS_KEY, sessions);
}

export function deleteSession(id) {
  write(
    SESSIONS_KEY,
    read(SESSIONS_KEY, []).filter((s) => s.id !== id),
  );
}

/** @returns {{baseUrl?: string, authToken?: string}} */
export function loadSettings() {
  return read(SETTINGS_KEY, {});
}

export function saveSettings(settings) {
  write(SETTINGS_KEY, settings);
}
