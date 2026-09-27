/**
 * Tests for client-message validation (web/lib/validate.ts) and the web
 * server's security/caching behavior (web/lib/server.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { cacheControlFor, startServer, type WebTtyServer } from "./lib/server";
import {
  isAllowedOrigin,
  parseOriginList,
  sanitizeSessionMessage,
  sanitizeStartMessage,
  sanitizeStringList,
} from "./lib/validate";

describe("sanitizeStartMessage", () => {
  test("accepts the supported permission modes", () => {
    for (const mode of ["plan", "default", "acceptEdits"] as const) {
      const result = sanitizeStartMessage({ prompt: "p", mode });
      expect(result.ok && result.value.mode).toBe(mode);
    }
  });

  test("defaults the mode to plan", () => {
    const result = sanitizeStartMessage({ prompt: "p" });
    expect(result.ok && result.value.mode).toBe("plan");
  });

  test("rejects bypassPermissions and other unknown modes", () => {
    for (const mode of ["bypassPermissions", "dontAsk", 42, {}]) {
      const result = sanitizeStartMessage({ prompt: "p", mode });
      expect(result.ok).toBe(false);
    }
  });

  test("requires a string prompt", () => {
    expect(sanitizeStartMessage({}).ok).toBe(false);
    expect(sanitizeStartMessage({ prompt: 5 }).ok).toBe(false);
    expect(sanitizeStartMessage({ prompt: "   " }).ok).toBe(false);
  });

  test("drops malformed optional fields", () => {
    const result = sanitizeStartMessage({
      prompt: "p",
      repo: 7,
      branch: " main ",
      localPath: ["/etc"],
      strategy: "rsync",
      stopOnPlanApproval: "yes",
      appendSystemPrompt: { x: 1 },
      allowedTools: "Bash",
      disallowedTools: ["Write", 3, "", null],
      auth: { baseUrl: "file:///etc/passwd", apiKey: " k " },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      prompt: "p",
      repo: undefined,
      branch: "main",
      localPath: undefined,
      strategy: undefined,
      mode: "plan",
      stopOnPlanApproval: undefined,
      appendSystemPrompt: undefined,
      allowedTools: undefined,
      disallowedTools: ["Write"],
      auth: { baseUrl: undefined, authToken: undefined, apiKey: "k" },
    });
  });

  test("passes well-formed fields through", () => {
    const result = sanitizeStartMessage({
      prompt: "p",
      repo: "owner/repo",
      localPath: "~/code/x",
      strategy: "git",
      mode: "acceptEdits",
      stopOnPlanApproval: false,
      allowedTools: ["Bash(bun test:*)"],
      auth: { baseUrl: "https://gw.example.com", authToken: "t" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      repo: "owner/repo",
      localPath: "~/code/x",
      strategy: "git",
      mode: "acceptEdits",
      stopOnPlanApproval: false,
      allowedTools: ["Bash(bun test:*)"],
      auth: { baseUrl: "https://gw.example.com", authToken: "t" },
    });
  });
});

describe("sanitizeStringList", () => {
  test("keeps only non-empty strings", () => {
    expect(sanitizeStringList(["a", " b ", 1, "", null])).toEqual(["a", "b"]);
    expect(sanitizeStringList("a")).toBeUndefined();
    expect(sanitizeStringList([1, 2])).toBeUndefined();
  });
});

describe("sanitizeSessionMessage", () => {
  test("validates message shapes", () => {
    expect(sanitizeSessionMessage({ type: "user_message", sessionId: "s", text: "hi" })).toEqual({
      type: "user_message",
      sessionId: "s",
      text: "hi",
    });
    expect(
      sanitizeSessionMessage({ type: "user_message", sessionId: "s", text: 1 }),
    ).toBeUndefined();
    expect(
      sanitizeSessionMessage({
        type: "permission_decision",
        sessionId: "s",
        id: "x",
        allow: "yes",
      }),
    ).toBeUndefined();
    expect(
      sanitizeSessionMessage({
        type: "answer_question",
        sessionId: "s",
        id: "q",
        answers: { a: "1", b: 2 },
      }),
    ).toEqual({ type: "answer_question", sessionId: "s", id: "q", answers: { a: "1" } });
    expect(sanitizeSessionMessage({ type: "interrupt", sessionId: "s" })).toEqual({
      type: "interrupt",
      sessionId: "s",
    });
    expect(sanitizeSessionMessage({ type: "bogus", sessionId: "s" })).toBeUndefined();
    expect(sanitizeSessionMessage({ type: "interrupt" })).toBeUndefined();
  });
});

describe("isAllowedOrigin", () => {
  test("allows same-origin and missing Origin", () => {
    expect(isAllowedOrigin(null, "localhost:3000")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", "localhost:3000")).toBe(true);
    expect(isAllowedOrigin("http://LOCALHOST:3000", "localhost:3000")).toBe(true);
  });

  test("rejects cross-origin and opaque origins", () => {
    expect(isAllowedOrigin("https://evil.example", "localhost:3000")).toBe(false);
    expect(isAllowedOrigin("http://localhost:4000", "localhost:3000")).toBe(false);
    expect(isAllowedOrigin("null", "localhost:3000")).toBe(false);
    expect(isAllowedOrigin("http://localhost:3000", null)).toBe(false);
  });

  test("honors the allowlist", () => {
    const allow = parseOriginList(" https://app.example.com/ , views://main ");
    expect(allow).toEqual(["https://app.example.com", "views://main"]);
    expect(isAllowedOrigin("https://app.example.com", "localhost:3000", allow)).toBe(true);
  });
});

describe("cacheControlFor", () => {
  test("hashed assets are immutable; entry points revalidate", () => {
    expect(cacheControlFor("assets/main-abc123.js")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("workbox-dcde9eb3.js")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("index.html")).toBe("no-cache");
    expect(cacheControlFor("sw.js")).toBe("no-cache");
    expect(cacheControlFor("manifest.webmanifest")).toBe("no-cache");
  });
});

describe("startServer", () => {
  let dir: string;
  let server: WebTtyServer;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cc-web-dist-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "assets", "main-abc.js"), "1");
    writeFileSync(path.join(tmpdir(), "cc-web-secret.txt"), "secret");
    // A relative distDir with a trailing segment exercises path.resolve.
    server = startServer({ port: 0, distDir: path.relative(process.cwd(), dir) });
  });

  afterAll(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(path.join(tmpdir(), "cc-web-secret.txt"), { force: true });
  });

  test("binds loopback by default", () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
  });

  test("serves static files with cache headers", async () => {
    const index = await fetch(`${server.url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(`${server.url}/assets/main-abc.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  test("blocks path traversal", async () => {
    const res = await fetch(`${server.url}/..%2Fcc-web-secret.txt`);
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toBe("secret");
  });

  test("rejects cross-origin WebSocket upgrades", async () => {
    const res = await fetch(`${server.url}/ws`, {
      headers: {
        origin: "https://evil.example",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(403);
  });

  test("rejects a start message with a disallowed mode", async () => {
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws`);
    const messages: { type: string; message?: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        messages.push(msg);
        if (msg.type === "config") {
          ws.send(
            JSON.stringify({
              type: "start",
              sessionId: "s1",
              prompt: "p",
              mode: "bypassPermissions",
            }),
          );
        } else if (msg.type === "session_done") {
          resolve();
        }
      };
      ws.onerror = () => reject(new Error("socket error"));
    });
    ws.close();
    expect(messages.find((m) => m.type === "error")?.message).toMatch(
      /Unsupported permission mode/,
    );
  });
});
