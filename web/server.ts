/**
 * cc-planner web app.
 *
 * Serves a browser UI for running Claude Code plan-mode sessions against a
 * GitHub repo, on top of the VFS infra in this repo:
 *
 * - Lazy hydration (default): the repo is blob-less-cloned at session start
 *   and file contents are hydrated on demand (scripts/lib/plan-remote.ts).
 * - Baked mode: the repo was fully cloned into the image at container build
 *   time (see Dockerfile); set CC_BAKED_REPO_PATH to enable.
 *
 * A single WebSocket connection multiplexes any number of concurrent
 * planning sessions. Plan content streams to the browser live via the
 * plan-file VFS, and Claude's AskUserQuestion / ExitPlanMode tool calls are
 * answered from the browser UI.
 *
 * Usage: bun run web/server.ts   (PORT defaults to 3000)
 */

import path from "path";
import { fileURLToPath } from "url";
import type { ServerWebSocket } from "bun";
import type { ClientMessage, ServerMessage } from "./lib/protocol";
import { makeRunner, PlanSession, resolveRepoMode } from "./lib/session";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT ?? 3000);

const repoMode = resolveRepoMode();
const runner = makeRunner(repoMode);

interface SocketData {
  sessions: Map<string, PlanSession>;
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!path.normalize(filePath).startsWith(PUBLIC_DIR + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(file);
}

const server = Bun.serve<SocketData, never>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return server.upgrade(req, { data: { sessions: new Map() } })
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 });
    }
    return serveStatic(url.pathname);
  },
  websocket: {
    open(ws: ServerWebSocket<SocketData>) {
      sendTo(ws, {
        type: "config",
        mode: repoMode.mode,
        repo: repoMode.repo ?? repoMode.root,
        ref: repoMode.ref,
      });
    },
    message(ws: ServerWebSocket<SocketData>, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (typeof msg.sessionId !== "string" || !msg.sessionId) {
        return;
      }
      const sessionId = msg.sessionId;

      if (msg.type === "start") {
        if (ws.data.sessions.has(sessionId)) {
          sendTo(ws, { type: "error", sessionId, message: "Session already started" });
          return;
        }
        const session = new PlanSession((event) => sendTo(ws, { ...event, sessionId }), runner);
        ws.data.sessions.set(sessionId, session);
        void session
          .start({ prompt: msg.prompt, repo: msg.repo, branch: msg.branch, auth: msg.auth })
          .finally(() => ws.data.sessions.delete(sessionId));
        return;
      }

      ws.data.sessions.get(sessionId)?.handleClientMessage(msg);
    },
    close(ws: ServerWebSocket<SocketData>) {
      for (const session of ws.data.sessions.values()) {
        session.dispose();
      }
      ws.data.sessions.clear();
    },
  },
});

function sendTo(ws: ServerWebSocket<SocketData>, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

console.log(`[cc-planner] listening on http://localhost:${server.port}`);
if (repoMode.mode === "baked") {
  console.log(
    `[cc-planner] baked mode: planning against ${repoMode.repo ?? repoMode.root} @ ${repoMode.ref?.slice(0, 12)}`,
  );
} else {
  console.log("[cc-planner] lazy hydration mode: repos are blob-less-cloned per session");
}
