import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Claude Code TTY",
    identifier: "com.shirhatti.cc-planner",
    version: "1.0.0",
  },
  runtime: {
    // Closing the window exits the process, taking the embedded server
    // (and any in-flight claude child processes) with it.
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "desktop/index.ts",
    },
    // Everything the embedded server needs on disk at runtime, landing in
    // Resources/app/ next to the bundled bun entrypoint (see desktop/index.ts).
    copy: {
      "web/dist": "web-dist",
      preload: "preload",
      "node_modules/@anthropic-ai/claude-agent-sdk": "claude-agent-sdk",
    },
    // The preload scripts and claude-agent-sdk/cli.js are spawned as real
    // files by child processes — they can't live inside an asar archive.
    useAsar: false,
    // Local app bundle only; flip on (with codesign/notarize) to distribute.
    mac: {
      createDmg: false,
    },
  },
} satisfies ElectrobunConfig;
