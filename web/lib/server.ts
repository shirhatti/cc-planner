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
import type { ServerMessage } from "./protocol";
import { ClaudeSession, makeRunner, resolveRepoMode } from "./session";
import { isAllowedOrigin, sanitizeSessionMessage, sanitizeStartMessage } from "./validate";

export interface StartServerOptions {
  /** Port to listen on; 0 picks an ephemeral port. */
  port: number;
  /** Directory containing the built UI (Vite build output). */
  distDir: string;
  /**
   * Interface to bind. Defaults to loopback ("127.0.0.1") — the server runs
   * claude sessions with the host's credentials and filesystem, so exposing
   * it is an explicit opt-in (e.g. "0.0.0.0" inside a container).
   */
  hostname?: string;
  /**
   * Extra browser origins (scheme://host[:port]) allowed to open the
   * WebSocket, beyond same-origin pages served by this server.
   */
  allowedOrigins?: string[];
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
  const distDir = path.resolve(options.distDir);
  const hostname = options.hostname ?? "127.0.0.1";
  const allowedOrigins = options.allowedOrigins ?? [];
  const repoMode = resolveRepoMode();
  const runner = makeRunner(repoMode);

  async function serveStatic(pathname: string): Promise<Response> {
    if (!existsSync(distDir)) {
      return new Response("UI build not found — run `bun run build` first.", { status: 503 });
    }
    let rel: string;
    try {
      rel = decodeURIComponent(pathname === "/" ? "index.html" : pathname.slice(1));
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const filePath = path.resolve(distDir, rel);
    if (!filePath.startsWith(distDir + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    const headers: Record<string, string> = {
      "cache-control": cacheControlFor(path.relative(distDir, filePath)),
    };
    if (filePath.endsWith(".webmanifest")) {
      headers["content-type"] = "application/manifest+json";
    }
    return new Response(file, { headers });
  }

  const server = Bun.serve<SocketData, never>({
    port: options.port,
    hostname,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        // Cross-site WebSocket hijacking defense: any page the user visits
        // could otherwise drive sessions on this server.
        if (!isAllowedOrigin(req.headers.get("origin"), req.headers.get("host"), allowedOrigins)) {
          return new Response("Forbidden origin", { status: 403 });
        }
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
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return;
        }
        const msg = parsed as Record<string, unknown>;
        if (typeof msg.sessionId !== "string" || !msg.sessionId) {
          return;
        }
        const sessionId = msg.sessionId;

        if (msg.type === "start") {
          if (ws.data.sessions.has(sessionId)) {
            sendTo(ws, { type: "error", sessionId, message: "Session already started" });
            return;
          }
          const request = sanitizeStartMessage(msg);
          if (!request.ok) {
            sendTo(ws, { type: "error", sessionId, message: request.error });
            sendTo(ws, { type: "session_done", sessionId });
            return;
          }
          const session = new ClaudeSession(
            (event) => sendTo(ws, { ...event, sessionId }),
            runner,
            {
              // Local-path sessions are full checkouts — no hydration.
              hydratingWorkspace: repoMode.mode === "lazy" && !request.value.localPath,
            },
          );
          ws.data.sessions.set(sessionId, session);
          void session.start(request.value).finally(() => ws.data.sessions.delete(sessionId));
          return;
        }

        const sessionMsg = sanitizeSessionMessage(msg);
        if (sessionMsg) {
          ws.data.sessions.get(sessionId)?.handleClientMessage(sessionMsg);
        }
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

  const url = `http://${displayHost(hostname)}:${port}`;
  console.log(`[claude-web-tty] listening on ${url}`);
  if (!isLoopback(hostname)) {
    console.warn(
      `[claude-web-tty] bound to ${hostname}: anyone who can reach this port can run claude sessions with this server's credentials`,
    );
  }
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
    url,
    stop: () => server.stop(true),
  };
}

/**
 * Vite emits content-hashed files under assets/ (plus the hashed workbox
 * runtime at the root): those never change and can be cached forever.
 * Everything else — index.html, sw.js, the manifest, icons — must be
 * revalidated so deploys and service-worker updates are picked up.
 */
export function cacheControlFor(rel: string): string {
  const normalized = rel.split(path.sep).join("/");
  if (normalized.startsWith("assets/") || /^workbox-[\w-]+\.js$/.test(normalized)) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
}

/** Host to print/open for a bind address (wildcards are reachable via localhost). */
function displayHost(hostname: string): string {
  if (hostname === "0.0.0.0" || hostname === "::") return "localhost";
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function sendTo(ws: ServerWebSocket<SocketData>, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
