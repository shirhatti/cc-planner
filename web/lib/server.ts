/**
 * Claude Code Web TTY — embeddable server.
 *
 * A general browser client for Claude Code: multi-turn sessions, browser-side
 * tool permissions (AskUserQuestion cards, plan review, allow/deny prompts
 * with diffs), live plan streaming, and per-session stats. Built on the
 * cc-planner VFS infra for its workspaces:
 *
 * - Lazy hydration (default): the repo is blob-less-cloned at session start
 *   and file contents are hydrated on demand (scripts/lib/plan-remote.ts).
 * - Baked mode: the repo was fully cloned into the image at container build
 *   time (see Dockerfile); set CC_BAKED_REPO_PATH to enable.
 *
 * A single WebSocket connection multiplexes any number of concurrent
 * sessions. The UI is a Vite build (`bun run build`) served from `distDir`.
 *
 * Hosts: `bun run web/server.ts` for the standalone CLI, desktop/index.ts
 * for the packaged macOS app (which embeds this on an ephemeral port).
 */

import { existsSync } from "fs";
import path from "path";
import type { ServerWebSocket } from "bun";
import type { ClientMessage, ServerMessage } from "./protocol";
import { ClaudeSession, makeRunner, resolveRepoMode } from "./session";

export interface StartServerOptions {
  /** Port to listen on; 0 picks an ephemeral port. */
  port: number;
  /** Directory containing the built UI (Vite build output). */
  distDir: string;
}

export interface WebTtyServer {
  /** The port actually bound (resolves ephemeral port requests). */
  port: number;
  url: string;
  stop(): void;
}

interface SocketData {
  sessions: Map<string, ClaudeSession>;
}

export function startServer(options: StartServerOptions): WebTtyServer {
  const distDir = options.distDir;
  const repoMode = resolveRepoMode();
  const runner = makeRunner(repoMode);

  async function serveStatic(pathname: string): Promise<Response> {
    if (!existsSync(distDir)) {
      return new Response("UI build not found — run `bun run build` first.", { status: 503 });
    }
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = path.join(distDir, rel);
    if (!path.normalize(filePath).startsWith(distDir + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    if (filePath.endsWith(".webmanifest")) {
      return new Response(file, { headers: { "content-type": "application/manifest+json" } });
    }
    return new Response(file);
  }

  const server = Bun.serve<SocketData, never>({
    port: options.port,
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
          const localPath = typeof msg.localPath === "string" ? msg.localPath.trim() : "";
          const session = new ClaudeSession(
            (event) => sendTo(ws, { ...event, sessionId }),
            runner,
            {
              // Local-path sessions are full checkouts — no hydration.
              hydratingWorkspace: repoMode.mode === "lazy" && !localPath,
            },
          );
          ws.data.sessions.set(sessionId, session);
          void session
            .start({
              prompt: msg.prompt,
              repo: msg.repo,
              branch: msg.branch,
              localPath: localPath || undefined,
              strategy: msg.strategy === "gh" || msg.strategy === "git" ? msg.strategy : undefined,
              mode: msg.mode,
              stopOnPlanApproval: msg.stopOnPlanApproval,
              appendSystemPrompt: msg.appendSystemPrompt,
              allowedTools: msg.allowedTools,
              disallowedTools: msg.disallowedTools,
              auth: msg.auth,
            })
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

  const port = server.port;
  if (port === undefined) {
    throw new Error("[claude-web-tty] server did not bind a TCP port");
  }

  console.log(`[claude-web-tty] listening on http://localhost:${port}`);
  if (repoMode.mode === "baked") {
    console.log(
      `[claude-web-tty] baked mode: workspace ${repoMode.repo ?? repoMode.root} @ ${repoMode.ref?.slice(0, 12)}`,
    );
  } else {
    console.log("[claude-web-tty] lazy hydration mode: repos are blob-less-cloned per session");
  }
  if (!existsSync(distDir)) {
    console.warn(`[claude-web-tty] ${distDir} missing — run \`bun run build\``);
  }

  return {
    port,
    url: `http://localhost:${port}`,
    stop: () => server.stop(true),
  };
}

function sendTo(ws: ServerWebSocket<SocketData>, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
