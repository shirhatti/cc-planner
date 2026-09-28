import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { buildChildEnv } from "./lib/child-env";

test("child env - outside a sandbox only CLAUDECODE is removed", () => {
  const env = buildChildEnv({ CLAUDECODE: "1", CLAUDE_CODE_FOO: "x", PATH: "/bin" });
  expect(env).toEqual({ CLAUDE_CODE_FOO: "x", PATH: "/bin" });
});

test("child env - remote sandbox strips parent harness vars and uses the ingress token", () => {
  const tokenPath = path.join(mkdtempSync(path.join(tmpdir(), "child-env-")), "token");
  writeFileSync(tokenPath, "sk-ant-si-test\n");
  const env = buildChildEnv(
    {
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDECODE: "1",
      CLAUDE_CODE_REMOTE: "true",
      CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES: "true",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_PID: "166",
      CLAUDE_SESSION_INGRESS_TOKEN_FILE: tokenPath,
    },
    tokenPath,
  );
  expect(env).toEqual({
    PATH: "/bin",
    ANTHROPIC_BASE_URL: "https://proxy.example",
    ANTHROPIC_AUTH_TOKEN: "sk-ant-si-test",
    CLAUDE_CODE_USE_BEDROCK: "1",
  });
});

test("child env - remote sandbox without a token file fails loudly", () => {
  expect(() =>
    buildChildEnv({ CLAUDE_CODE_REMOTE: "true" }, path.join(tmpdir(), "no-such-token-file")),
  ).toThrow(/session ingress token was not found/);
});
