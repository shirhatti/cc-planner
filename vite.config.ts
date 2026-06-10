import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // The Bun server (bun run web/server.ts) owns the WebSocket endpoint.
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
