import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

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
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Claude Code Web TTY",
        short_name: "claude-tty",
        description: "Run Claude Code sessions in the browser — a TTY with niceties.",
        theme_color: "#14161a",
        background_color: "#14161a",
        display: "standalone",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // The Shiki grammars from @pierre/diffs are hundreds of hashed JS
        // chunks — cache those on demand instead of precaching everything.
        globPatterns: ["**/*.{html,css,png,webmanifest}", "assets/main-*.js"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/assets\/.*\.js$/,
            handler: "CacheFirst",
            options: {
              cacheName: "hashed-assets",
              expiration: { maxEntries: 300 },
            },
          },
        ],
      },
    }),
  ],
});
