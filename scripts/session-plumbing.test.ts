import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { describeCloneFailure } from "./lib/blobless-clone";
import {
  PLANS_SUBDIR,
  planCaptureHooks,
  plansDirectoryPath,
  plansDirectorySetting,
} from "./lib/plan-capture";
import { ORIGINAL_BUN_OPTIONS_VAR, preloadEnv } from "./lib/spawn-vfs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HYDRATE_SCRIPT = path.join(__dirname, "..", "preload", "vfs-hydrate.ts");

test("preloadEnv - passes preloads in BUN_OPTIONS and remembers the caller's value", () => {
  expect(preloadEnv(["/a/p.ts", "/b/q.ts"], {})).toEqual({
    BUN_OPTIONS: "--preload /a/p.ts --preload /b/q.ts",
    [ORIGINAL_BUN_OPTIONS_VAR]: "",
  });
  expect(preloadEnv(["/a/p.ts"], { BUN_OPTIONS: "--smol" })).toEqual({
    BUN_OPTIONS: "--preload /a/p.ts --smol",
    [ORIGINAL_BUN_OPTIONS_VAR]: "--smol",
  });
});

test("preloadEnv - reaches whitespace paths through a symlink", () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "spawn-vfs-")), "My App");
  mkdirSync(dir);
  const script = path.join(dir, "vfs hydrate.ts");
  writeFileSync(script, "");
  const flags = preloadEnv([script], {}).BUN_OPTIONS.split(" ");
  expect(flags).toHaveLength(2);
  expect(flags[1]).not.toMatch(/\s/);
  expect(readlinkSync(flags[1])).toBe(script);
});

test("preloads restore the caller's BUN_OPTIONS so subprocesses don't inherit them", () => {
  const probe = `console.log(JSON.stringify([process.env.BUN_OPTIONS ?? null, process.env.${ORIGINAL_BUN_OPTIONS_VAR} ?? null]))`;
  const run = (env: Record<string, string>) =>
    JSON.parse(
      spawnSync("bun", ["-e", probe], {
        env: { ...process.env, ...env },
        encoding: "utf-8",
      }).stdout,
    );
  expect(run(preloadEnv([HYDRATE_SCRIPT], {}))).toEqual([null, null]);
  expect(run(preloadEnv([HYDRATE_SCRIPT], { BUN_OPTIONS: "--smol" }))).toEqual(["--smol", null]);
});

test("plan capture - uses .git/cc-planner-plans only when the workspace has a .git dir", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "plan-capture-"));
  expect(plansDirectorySetting(ws)).toBeUndefined();
  mkdirSync(path.join(ws, ".git"));
  expect(plansDirectorySetting(ws)).toBe(PLANS_SUBDIR);
});

test("plan capture - hook reports Write/Edit of files in the plans dir only", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "plan-capture-"));
  mkdirSync(path.join(ws, ".git"));
  const dir = plansDirectoryPath(ws);
  expect(dir).toBe(path.join(ws, PLANS_SUBDIR));
  mkdirSync(dir, { recursive: true });

  const seen: [string, string][] = [];
  const [matcher] = planCaptureHooks(dir, (content, filename) => seen.push([filename, content]));
  expect(matcher.matcher).toBe("Write|Edit|MultiEdit");
  const fire = (tool: string, filePath: string) =>
    matcher.hooks[0](
      {
        hook_event_name: "PostToolUse",
        tool_name: tool,
        tool_input: { file_path: filePath },
      } as never,
      "tu",
      { signal: new AbortController().signal },
    );

  const plan = path.join(dir, "my-plan.md");
  writeFileSync(plan, "# v1\n");
  await fire("Write", plan);
  writeFileSync(plan, "# v2\n");
  // Claude Code may report the realpath'd spelling of the same file.
  await fire("Edit", path.join(realpathSync(dir), "my-plan.md"));
  // Not plans: a repo file, and a non-markdown file in the plans dir.
  writeFileSync(path.join(ws, "README.md"), "# repo\n");
  await fire("Write", path.join(ws, "README.md"));
  writeFileSync(path.join(dir, "notes.txt"), "x");
  await fire("Write", path.join(dir, "notes.txt"));

  expect(seen).toEqual([
    ["my-plan.md", "# v1\n"],
    ["my-plan.md", "# v2\n"],
  ]);
});

test("plan capture - workspaces without .git use the default plans dir", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "plan-capture-"));
  expect(plansDirectoryPath(ws, { CLAUDE_CONFIG_DIR: "/cfg" })).toBe(path.join("/cfg", "plans"));
});

test("describeCloneFailure - turns git clone stderr into an actionable message", () => {
  const notFound =
    "Cloning into '/var/folders/x/T/cc-planner-a'...\nremote: Repository not found.\n" +
    "fatal: repository 'https://github.com/dotnet/aspentcore.git/' not found\n";
  expect(describeCloneFailure("dotnet/aspentcore", undefined, notFound)).toBe(
    'GitHub repository "dotnet/aspentcore" not found — check the owner/repo spelling, ' +
      "or that your GitHub login (`gh auth status`) can access it",
  );
  expect(
    describeCloneFailure(
      "o/r",
      undefined,
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
    ),
  ).toMatch(/^GitHub repository "o\/r" not found/);
  expect(
    describeCloneFailure(
      "o/r",
      "nope",
      "Cloning into 'x'...\nwarning: Could not find remote branch nope to clone.\n" +
        "fatal: Remote branch nope not found in upstream origin\n",
    ),
  ).toBe('Branch "nope" not found in o/r');
  expect(
    describeCloneFailure("o/r", undefined, "Cloning into 'x'...\nfatal: unable to access\n"),
  ).toBe("Cloning o/r failed: fatal: unable to access");
});
