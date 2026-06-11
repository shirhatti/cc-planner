/**
 * Claude Code Web TTY — standalone CLI entrypoint.
 *
 * Serves the Vite build from web/dist; during development run
 * `bun run dev:ui` for the Vite dev server, which proxies /ws here.
 * The server itself lives in web/lib/server.ts so the desktop app
 * (desktop/index.ts) can embed it.
 *
 * Usage: bun run web/server.ts   (PORT defaults to 3000)
 */

import path from "path";
import { fileURLToPath } from "url";
import { startServer } from "./lib/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

startServer({
  port: Number(process.env.PORT ?? 3000),
  distDir: path.join(__dirname, "dist"),
});
