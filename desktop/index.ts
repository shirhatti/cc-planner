/**
 * Desktop entrypoint — packages the web TTY as a macOS app via Electrobun.
 *
 * The Electrobun main process is a Bun process, so the same server that
 * `bun run web/server.ts` starts is embedded here on an ephemeral port and
 * a native window is pointed at it. Server lifetime is tied to the app:
 * closing the window exits the process (runtime.exitOnLastWindowClosed).
 *
 * This file is bundled to Resources/app/bun/index.js inside the .app, with
 * its runtime resources copied next to it by electrobun.config.ts:
 *
 *   Resources/app/web-dist/          the Vite UI build
 *   Resources/app/preload/           VFS preload scripts (spawned via
 *                                    `bun --preload`, so they must be
 *                                    real files — keep ASAR off)
 *   Resources/app/claude-agent-sdk/  SDK package incl. cli.js + ripgrep
 *   Contents/MacOS/bun               the bundled Bun runtime
 */

import { BrowserWindow } from "electrobun/bun";
import path from "path";
import { fileURLToPath } from "url";
import { startServer } from "../web/lib/server";

// import.meta resolves to Resources/app/bun/index.js in the bundle.
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Point the session runners at the bundled preload scripts and Claude CLI
// (must happen before any session starts; see scripts/lib/runtime-paths.ts).
process.env.CC_RESOURCES_ROOT = appRoot;

// GUI apps launch with a minimal PATH (/usr/bin:/bin:...). Prepend the
// bundled bun so spawned claude sessions don't need a system bun install,
// plus the Homebrew dirs so lazy hydration can find git and gh.
const bundledBinDir = path.resolve(appRoot, "..", "..", "MacOS");
process.env.PATH = [bundledBinDir, "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH]
  .filter(Boolean)
  .join(":");

const server = startServer({
  port: 0,
  distDir: path.join(appRoot, "web-dist"),
});

new BrowserWindow({
  title: "Claude Code TTY",
  url: server.url,
  frame: { x: 100, y: 100, width: 1280, height: 850 },
});
