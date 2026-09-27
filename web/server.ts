/**
 * Claude Code Web TTY — standalone CLI entrypoint.
 *
 * Serves the Vite build from web/dist; during development run
 * `bun run dev:ui` for the Vite dev server, which proxies /ws here.
 * The server itself lives in web/lib/server.ts so the desktop app
 * (desktop/index.ts) can embed it.
 *
 * Usage: bun run web/server.ts   (PORT defaults to 3000)
 *
 * Binds 127.0.0.1 unless CC_WEB_HOST says otherwise (the Dockerfile sets
 * 0.0.0.0). CC_WEB_ALLOWED_ORIGINS adds comma-separated browser origins
 * allowed to open the WebSocket beyond same-origin pages.
 */

import path from "path";
import { fileURLToPath } from "url";
import { startServer } from "./lib/server";
import { parseOriginList } from "./lib/validate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

startServer({
  port: Number(process.env.PORT ?? 3000),
  distDir: path.join(__dirname, "dist"),
  hostname: process.env.CC_WEB_HOST?.trim() || undefined,
  allowedOrigins: parseOriginList(process.env.CC_WEB_ALLOWED_ORIGINS),
});
