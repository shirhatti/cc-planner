/**
 * Tests for the lazily-hydrated-workspace Bash command policy.
 */

import { describe, expect, test } from "bun:test";
import { evaluateBashCommand } from "./lib/bash-policy";

function verdict(command: string): string {
  return evaluateBashCommand(command, { hydrating: true }).verdict;
}

function bakedVerdict(command: string): string {
  return evaluateBashCommand(command, { hydrating: false }).verdict;
}

describe("evaluateBashCommand (hydrating workspace)", () => {
  test("denies tree walkers", () => {
    expect(verdict("tree")).toBe("deny");
    expect(verdict("tree -L 2 src")).toBe("deny");
    expect(verdict("find . -name '*.ts'")).toBe("deny");
    expect(verdict("ls -R src")).toBe("deny");
    expect(verdict("ls --recursive")).toBe("deny");
    expect(verdict("du -sh .")).toBe("deny");
  });

  test("denies recursive and direct-file content search", () => {
    expect(verdict("grep -r TODO src")).toBe("deny");
    expect(verdict("grep -rn pattern .")).toBe("deny");
    expect(verdict("rg pattern")).toBe("deny");
    expect(verdict("ag pattern src/")).toBe("deny");
    expect(verdict("grep pattern src/main.ts")).toBe("deny");
  });

  test("denies git grep with a promisor-fetch explanation", () => {
    const result = evaluateBashCommand("git grep planRemoteRepo", { hydrating: true });
    expect(result.verdict).toBe("deny");
    expect(result.reason).toContain("blob");
  });

  test("denies subprocess file readers", () => {
    expect(verdict("cat src/main.ts")).toBe("deny");
    expect(verdict("head -n 20 README.md")).toBe("deny");
    expect(verdict("tail -50 server.log")).toBe("deny");
    expect(verdict("wc -l src/main.ts")).toBe("deny");
  });

  test("allows pipeline filters that read stdin", () => {
    expect(verdict("git log --oneline | head -20")).toBe("allow");
    expect(verdict("git ls-files | grep test")).toBe("allow");
    expect(verdict("git log | wc -l")).toBe("allow");
  });

  test("denies history-wide content sweeps but allows targeted commit inspection", () => {
    expect(verdict("git log -p")).toBe("deny");
    expect(verdict("git log --stat")).toBe("deny");
    expect(verdict("git log --all -S planRemoteRepo")).toBe("deny");
    expect(verdict("git log --oneline --all")).toBe("allow");
    expect(verdict("git log --name-only --no-renames")).toBe("allow");
    // One commit's worth of blobs is targeted hydration — allowed.
    expect(verdict("git show abc123 --stat")).toBe("allow");
    expect(verdict("git diff HEAD~1")).toBe("allow");
  });

  test("allows read-only git metadata commands", () => {
    expect(verdict("git status")).toBe("allow");
    expect(verdict("git log --oneline -10")).toBe("allow");
    expect(verdict("git show HEAD:package.json")).toBe("allow");
    expect(verdict("git ls-tree -r --name-only HEAD")).toBe("allow");
    expect(verdict("git diff HEAD~1")).toBe("allow");
  });

  test("allows plain safe commands", () => {
    expect(verdict("pwd")).toBe("allow");
    expect(verdict("ls -la src")).toBe("allow");
    expect(verdict("echo hello")).toBe("allow");
  });

  test("strictest segment wins in compound commands", () => {
    expect(verdict("pwd && find . -name '*.ts'")).toBe("deny");
    expect(verdict("git log; cat README.md")).toBe("deny");
    expect(verdict("echo a && git push")).toBe("ask");
  });

  test("unknown or mutating commands fall through to ask", () => {
    expect(verdict("bun test")).toBe("ask");
    expect(verdict("git push origin main")).toBe("ask");
    expect(verdict("rm -rf node_modules")).toBe("ask");
  });

  test("skips env-var prefixes when identifying the command", () => {
    expect(verdict("FOO=bar tree")).toBe("deny");
    expect(verdict("CI=1 git status")).toBe("allow");
  });
});

describe("evaluateBashCommand (full checkout)", () => {
  test("read-only shell commands are auto-allowed", () => {
    expect(bakedVerdict("find . -name '*.ts'")).toBe("allow");
    expect(bakedVerdict("tree -L 2 src")).toBe("allow");
    expect(bakedVerdict("cat src/main.ts")).toBe("allow");
    expect(bakedVerdict("grep -rn pattern src")).toBe("allow");
    expect(bakedVerdict("rg pattern")).toBe("allow");
    expect(bakedVerdict("head -n 20 README.md")).toBe("allow");
  });

  test("git metadata commands are auto-allowed (the reported case)", () => {
    expect(bakedVerdict("git ls-files")).toBe("allow");
    expect(bakedVerdict("git ls-tree -r --name-only HEAD")).toBe("allow");
    expect(bakedVerdict("git log -p")).toBe("allow");
    expect(bakedVerdict("git grep pattern")).toBe("allow");
    expect(bakedVerdict("git ls-files | grep test | wc -l")).toBe("allow");
  });

  test("mutating commands still ask", () => {
    expect(bakedVerdict("git push origin main")).toBe("ask");
    expect(bakedVerdict("rm -rf node_modules")).toBe("ask");
    expect(bakedVerdict("bun test")).toBe("ask");
    expect(bakedVerdict("git ls-files | xargs rm")).toBe("ask");
  });

  test("write redirects and mutating find flags are never auto-allowed", () => {
    expect(bakedVerdict("echo secret > .env")).toBe("ask");
    expect(bakedVerdict("git ls-files > files.txt")).toBe("ask");
    expect(bakedVerdict("cat a.txt >> b.txt")).toBe("ask");
    expect(bakedVerdict("find . -name '*.tmp' -delete")).toBe("ask");
    expect(bakedVerdict("find . -exec rm {} \\;")).toBe("ask");
    // Harmless stderr plumbing doesn't trip the redirect guard.
    expect(bakedVerdict("find . -name x 2>/dev/null")).toBe("allow");
    expect(bakedVerdict("git status 2>&1")).toBe("allow");
  });
});
