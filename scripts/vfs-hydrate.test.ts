import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { parseGitHubRepo, encodeApiPath } from "../preload/vfs-hydrate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");
const HYDRATE_SCRIPT = path.join(PROJECT_ROOT, "preload", "vfs-hydrate.ts");
const VIRTUAL_SCRIPT = path.join(PROJECT_ROOT, "preload", "vfs-virtual.ts");
const PLANS_DIR = path.join(process.env.HOME!, ".claude", "plans");

// ---------------------------------------------------------------------------
// Fixture: a local "upstream" repo, a fake `gh` that serves its files, and
// fresh blob-less clones per test.
// ---------------------------------------------------------------------------

// Serves `gh api repos/<owner>/<repo>/contents/<path>?ref=<sha>` from the
// upstream working tree (and `.../git/trees/<sha>?recursive=1` from a
// precomputed JSON file) and logs every invocation, so tests can run offline
// and assert exactly when fetches happen.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" != "api" ]; then
  echo "fake gh: unsupported command: $*" >&2
  exit 1
fi
endpoint="$2"
if [[ "$endpoint" == repos/*/git/trees/* ]]; then
  exec cat "$FAKE_GH_TREE_JSON"
fi
p="\${endpoint#repos/*/contents/}"
p="\${p%%\\?*}"
exec cat "$FAKE_GH_CONTENT_DIR/$p"
`;

let workDir: string;
let upstream: string;
let shimDir: string;
let headSha: string;
let treeJson: string;
let cloneCounter = 0;

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout;
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "vfs-hydrate-test-"));

  upstream = path.join(workDir, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-b", "main");
  git(upstream, "config", "user.email", "test@example.com");
  git(upstream, "config", "user.name", "Test");
  // Fixture commits must work even where a global config enforces signing
  git(upstream, "config", "commit.gpgsign", "false");
  // Allow partial clones and promisor blob fetches over the local transport
  git(upstream, "config", "uploadpack.allowFilter", "true");
  git(upstream, "config", "uploadpack.allowAnySHA1InWant", "true");

  writeFileSync(path.join(upstream, "README.md"), "# Widgets\n");
  mkdirSync(path.join(upstream, "src", "util"), { recursive: true });
  writeFileSync(path.join(upstream, "src", "index.ts"), "export const answer = 42;\n");
  writeFileSync(path.join(upstream, "src", "util", "helper.ts"), "export function help() {}\n");
  mkdirSync(path.join(upstream, "tools"));
  writeFileSync(path.join(upstream, "tools", "run.sh"), "#!/bin/sh\necho run\n");
  chmodSync(path.join(upstream, "tools", "run.sh"), 0o755);
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "initial");
  headSha = git(upstream, "rev-parse", "HEAD").trim();

  // GitHub trees API response (recursive) for HEAD, with blob sizes.
  const tree = git(upstream, "ls-tree", "-r", "-l", "-z", "HEAD")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, p] = line.split("\t");
      const [mode, type, sha, size] = meta.split(/\s+/);
      return { path: p, mode, type, sha, size: Number(size) };
    });
  treeJson = path.join(workDir, "tree.json");
  writeFileSync(treeJson, JSON.stringify({ sha: headSha, tree, truncated: false }));

  shimDir = path.join(workDir, "fake-bin");
  mkdirSync(shimDir);
  writeFileSync(path.join(shimDir, "gh"), FAKE_GH);
  chmodSync(path.join(shimDir, "gh"), 0o755);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  logFile: string;
  env: Record<string, string | undefined>;
}

/** Blob-less, checkout-less clone of the upstream repo + hydration env. */
function freshClone(): Fixture {
  cloneCounter += 1;
  const root = path.join(workDir, `clone-${cloneCounter}`);
  git(workDir, "clone", "--no-local", "--filter=blob:none", "--no-checkout", upstream, root);

  const logFile = path.join(workDir, `gh-log-${cloneCounter}.txt`);
  writeFileSync(logFile, "");

  return {
    root,
    logFile,
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      FAKE_GH_LOG: logFile,
      FAKE_GH_CONTENT_DIR: upstream,
      FAKE_GH_TREE_JSON: treeJson,
      CC_HYDRATE_ROOT: root,
      CC_HYDRATE_REPO: "acme/widgets",
      CC_HYDRATE_REF: headSha,
    },
  };
}

function ghCalls(fixture: Fixture): string[] {
  return readFileSync(fixture.logFile, "utf-8").split("\n").filter(Boolean);
}

/** gh calls that download file contents (excludes the one-off tree listing). */
function contentFetches(fixture: Fixture): string[] {
  return ghCalls(fixture).filter((c) => c.includes("/contents/"));
}

interface TestResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  events: Record<string, unknown>[];
}

function runHydrated(
  script: string,
  fixture: Fixture,
  preloads: string[] = [HYDRATE_SCRIPT],
): Promise<TestResult> {
  const events: Record<string, unknown>[] = [];
  let stdout = "";
  let stderr = "";

  const preloadArgs = preloads.flatMap((p) => ["--preload", p]);
  const proc = spawn("bun", [...preloadArgs, "-e", script], {
    stdio: ["inherit", "pipe", "pipe", "ipc"],
    env: fixture.env,
  });

  proc.stdout!.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  proc.stderr!.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  proc.on("message", (msg: Record<string, unknown>) => {
    events.push(msg);
  });

  return new Promise((resolve) => {
    proc.on("exit", (exitCode) => resolve({ exitCode, stdout, stderr, events }));
  });
}

// ---------------------------------------------------------------------------
// Unit tests for pure helpers
// ---------------------------------------------------------------------------

test("parseGitHubRepo handles common GitHub remote URL shapes", () => {
  expect(parseGitHubRepo("https://github.com/acme/widgets.git")).toBe("acme/widgets");
  expect(parseGitHubRepo("https://github.com/acme/widgets")).toBe("acme/widgets");
  expect(parseGitHubRepo("git@github.com:acme/widgets.git")).toBe("acme/widgets");
  expect(parseGitHubRepo("ssh://git@github.com/acme/widgets\n")).toBe("acme/widgets");
  expect(parseGitHubRepo("https://gitlab.com/acme/widgets.git")).toBeNull();
});

test("encodeApiPath escapes segments but keeps slashes", () => {
  expect(encodeApiPath("src/index.ts")).toBe("src/index.ts");
  expect(encodeApiPath("docs/my file#1.md")).toBe("docs/my%20file%231.md");
});

// ---------------------------------------------------------------------------
// Hydration behavior
// ---------------------------------------------------------------------------

test("hydrating VFS - readFileSync fetches via gh once and caches on disk", async () => {
  const fixture = freshClone();
  const target = path.join(fixture.root, "src", "index.ts");

  // Blob-less + no-checkout clone really has an empty working tree
  expect(existsSync(path.join(fixture.root, "src"))).toBe(false);

  const { exitCode, stdout, events } = await runHydrated(
    `
    const fs = require('fs');
    const p = ${JSON.stringify(target)};
    console.log("read1:" + fs.readFileSync(p, "utf-8").trim());
    console.log("read2:" + fs.readFileSync(p, "utf-8").trim());
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("read1:export const answer = 42;");
  expect(stdout).toContain("read2:export const answer = 42;");

  // Exactly one gh fetch — the second read came from the hydrated disk copy
  expect(ghCalls(fixture).length).toBe(1);
  expect(ghCalls(fixture)[0]).toContain(`repos/acme/widgets/contents/src/index.ts?ref=${headSha}`);

  // File is now on disk in the clone
  expect(readFileSync(target, "utf-8")).toBe("export const answer = 42;\n");

  const init = events.find((e) => e.type === "hydrate_init");
  expect(init).toBeDefined();
  expect(init?.repo).toBe("acme/widgets");
  expect(init?.files).toBe(4);

  const fetch = events.find((e) => e.type === "hydrate_fetch");
  expect(fetch).toBeDefined();
  expect(fetch?.rel).toBe("src/index.ts");
});

test("hydrating VFS - existsSync answers from the manifest without fetching", async () => {
  const fixture = freshClone();

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const path = require('path');
    const root = ${JSON.stringify(fixture.root)};
    console.log("file:" + fs.existsSync(path.join(root, "src", "util", "helper.ts")));
    console.log("dir:" + fs.existsSync(path.join(root, "src", "util")));
    console.log("missing:" + fs.existsSync(path.join(root, "nope.ts")));
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("file:true");
  expect(stdout).toContain("dir:true");
  expect(stdout).toContain("missing:false");
  expect(ghCalls(fixture).length).toBe(0);
  // existsSync alone must not hydrate anything
  expect(existsSync(path.join(fixture.root, "src"))).toBe(false);
});

test("hydrating VFS - statSync/lstatSync/accessSync answer from the manifest without fetching", async () => {
  const fixture = freshClone();
  const readme = path.join(fixture.root, "README.md");
  const script = path.join(fixture.root, "tools", "run.sh");
  const commitTime = Number(git(upstream, "show", "-s", "--format=%ct", headSha).trim()) * 1000;

  const { exitCode, stdout, events } = await runHydrated(
    `
    const fs = require('fs');
    const readme = ${JSON.stringify(readme)};
    const script = ${JSON.stringify(script)};
    const s = fs.statSync(readme);
    console.log("isFile:" + s.isFile() + ":" + s.isDirectory());
    console.log("size:" + s.size);
    console.log("instance:" + (s instanceof fs.Stats));
    console.log("mtime:" + s.mtimeMs + ":" + s.mtime.getTime());
    console.log("lstat:" + fs.lstatSync(readme).isFile());
    console.log("exec:" + ((fs.statSync(script).mode & 0o100) !== 0) + ":" + ((s.mode & 0o100) !== 0));
    fs.accessSync(readme, fs.constants.R_OK);
    console.log("access:ok");
    try { fs.accessSync(readme, fs.constants.X_OK); console.log("xok:yes"); }
    catch (e) { console.log("xok:" + e.code); }
    console.log("missing:" + fs.statSync(readme + ".nope", { throwIfNoEntry: false }));
    console.log("onDisk:" + require('fs').readdirSync(${JSON.stringify(fixture.root)}).length);
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("isFile:true:false");
  expect(stdout).toContain(`size:${statSync(path.join(upstream, "README.md")).size}`);
  expect(stdout).toContain("instance:true");
  expect(stdout).toContain(`mtime:${commitTime}:${commitTime}`);
  expect(stdout).toContain("lstat:true");
  expect(stdout).toContain("exec:true:false");
  expect(stdout).toContain("access:ok");
  expect(stdout).toContain("xok:EACCES");
  expect(stdout).toContain("missing:undefined");
  // Nothing was downloaded or written to disk — sizes came from one tree listing
  expect(contentFetches(fixture).length).toBe(0);
  expect(ghCalls(fixture).length).toBe(1);
  expect(ghCalls(fixture)[0]).toContain(`repos/acme/widgets/git/trees/${headSha}?recursive=1`);
  expect(events.filter((e) => e.type === "hydrate_fetch").length).toBe(0);
  expect(existsSync(readme)).toBe(false);
  expect(existsSync(script)).toBe(false);
});

test("hydrating VFS - async stat/lstat/access and realpath do not fetch", async () => {
  const fixture = freshClone();
  const target = path.join(fixture.root, "src", "util", "helper.ts");

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const p = ${JSON.stringify(target)};
    (async () => {
      console.log("pstat:" + (await fs.promises.stat(p)).isFile());
      console.log("plstat:" + (await fs.promises.lstat(p)).isFile());
      await fs.promises.access(p);
      console.log("paccess:ok");
      const cb = await new Promise((res) => fs.stat(p, (err, s) => res(err ? err.code : s.isFile())));
      console.log("cbstat:" + cb);
      const acc = await new Promise((res) => fs.access(p, (err) => res(err ? err.code : "ok")));
      console.log("cbaccess:" + acc);
      console.log("realpath:" + (fs.realpathSync(p) === fs.realpathSync.native(p)));
      console.log("prealpath:" + (await fs.promises.realpath(p)).endsWith("/src/util/helper.ts"));
    })();
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("pstat:true");
  expect(stdout).toContain("plstat:true");
  expect(stdout).toContain("paccess:ok");
  expect(stdout).toContain("cbstat:true");
  expect(stdout).toContain("cbaccess:ok");
  expect(stdout).toContain("realpath:true");
  expect(stdout).toContain("prealpath:true");
  expect(contentFetches(fixture).length).toBe(0);
  expect(existsSync(target)).toBe(false);
});

test("hydrating VFS - stat reports the same size and mtime before and after hydrating", async () => {
  const fixture = freshClone();
  const target = path.join(fixture.root, "README.md");

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const p = ${JSON.stringify(target)};
    const a = fs.statSync(p);
    console.log("before:" + a.size + ":" + a.mtimeMs);
    console.log("read:" + fs.readFileSync(p, "utf-8").trim());
    const b = fs.statSync(p);
    console.log("after:" + b.size + ":" + b.mtimeMs);
  `,
    fixture,
  );

  // Claude Code's Edit refuses when mtime grew since Read ("modified since
  // read"), and Read stats before it reads — so hydration must not bump mtime.
  const size = statSync(path.join(upstream, "README.md")).size;
  const commitTime = Number(git(upstream, "show", "-s", "--format=%ct", headSha).trim()) * 1000;
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`before:${size}:${commitTime}`);
  expect(stdout).toContain("read:# Widgets");
  expect(stdout).toContain(`after:${size}:${commitTime}`);
  expect(contentFetches(fixture).length).toBe(1);
});

test("hydrating VFS - stat hydrates when the size is unknown", async () => {
  const fixture = freshClone();
  // Tree listing fails (e.g. API unavailable): sizes are unknown.
  fixture.env.FAKE_GH_TREE_JSON = path.join(workDir, "no-such-tree.json");
  const target = path.join(fixture.root, "README.md");

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const p = ${JSON.stringify(target)};
    console.log("size:" + fs.statSync(p).size);
    fs.accessSync(p);
    console.log("access:ok");
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain(`size:${statSync(path.join(upstream, "README.md")).size}`);
  expect(stdout).toContain("access:ok");
  // stat hydrated rather than report a wrong size
  expect(contentFetches(fixture).length).toBe(1);
  expect(existsSync(target)).toBe(true);
});

test("hydrating VFS - concurrent async reads of one file fetch once", async () => {
  const fixture = freshClone();
  const target = path.join(fixture.root, "src", "index.ts");

  const { exitCode, stdout, events } = await runHydrated(
    `
    const fs = require('fs');
    const p = ${JSON.stringify(target)};
    const cb = new Promise((res) => fs.readFile(p, "utf-8", (err, d) => res(err ? err.code : d)));
    Promise.all([
      fs.promises.readFile(p, "utf-8"),
      fs.promises.readFile(p, "utf-8"),
      cb,
    ]).then((all) => {
      console.log("same:" + all.every((d) => d === "export const answer = 42;\\n"));
      console.log("tmp:" + fs.readdirSync(require('path').dirname(p)).filter((n) => n.includes("vfs-hydrate")).length);
    });
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("same:true");
  expect(stdout).toContain("tmp:0");
  expect(ghCalls(fixture).length).toBe(1);
  expect(events.filter((e) => e.type === "hydrate_fetch").length).toBe(1);
  expect(readFileSync(target, "utf-8")).toBe("export const answer = 42;\n");
});

test("hydrating VFS - recursive readdir lists just the subtree", async () => {
  const fixture = freshClone();

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const path = require('path');
    const src = path.join(${JSON.stringify(fixture.root)}, "src");
    console.log("src:" + fs.readdirSync(src, { recursive: true }).sort().join(","));
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("src:index.ts,util,util/helper.ts");
  expect(ghCalls(fixture).length).toBe(0);
});

test("hydrating VFS - unlinking a hydrated file makes it disappear", async () => {
  const fixture = freshClone();
  const target = path.join(fixture.root, "src", "index.ts");

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const p = ${JSON.stringify(target)};
    fs.readFileSync(p);
    fs.unlinkSync(p);
    console.log("exists:" + fs.existsSync(p));
    try { fs.readFileSync(p); console.log("read:yes"); } catch (e) { console.log("read:" + e.code); }
    try { fs.statSync(p); console.log("stat:yes"); } catch (e) { console.log("stat:" + e.code); }
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("exists:false");
  expect(stdout).toContain("read:ENOENT");
  expect(stdout).toContain("stat:ENOENT");
  expect(ghCalls(fixture).length).toBe(1);
});

test("hydrating VFS - readdirSync lists the manifest without fetching blobs", async () => {
  const fixture = freshClone();

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const path = require('path');
    const root = ${JSON.stringify(fixture.root)};
    console.log("root:" + fs.readdirSync(root).sort().join(","));
    console.log("src:" + fs.readdirSync(path.join(root, "src")).sort().join(","));
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  const rootListing = stdout.match(/root:(.*)/)?.[1]?.split(",") ?? [];
  expect(rootListing).toContain("README.md");
  expect(rootListing).toContain("src");
  expect(rootListing).toContain("tools");
  expect(stdout).toContain("src:index.ts,util");
  // Listing directories must never download file contents
  expect(ghCalls(fixture).length).toBe(0);
  expect(existsSync(path.join(fixture.root, "src", "index.ts"))).toBe(false);
});

test("hydrating VFS - readdirSync withFileTypes marks files and directories", async () => {
  const fixture = freshClone();

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const path = require('path');
    const entries = fs.readdirSync(path.join(${JSON.stringify(fixture.root)}, "src"), { withFileTypes: true });
    for (const e of entries) {
      console.log("entry:" + e.name + ":" + (e.isDirectory() ? "dir" : "file"));
    }
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("entry:index.ts:file");
  expect(stdout).toContain("entry:util:dir");
});

test("hydrating VFS - readdirSync merges hydrated and new files with manifest entries", async () => {
  const fixture = freshClone();

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const path = require('path');
    const src = path.join(${JSON.stringify(fixture.root)}, "src");
    fs.readFileSync(path.join(src, "index.ts"), "utf-8"); // hydrate one file
    fs.writeFileSync(path.join(src, "new-file.ts"), "// new"); // create another
    console.log("src:" + fs.readdirSync(src).sort().join(","));
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  // index.ts must appear exactly once (disk copy deduped against manifest)
  expect(stdout).toContain("src:index.ts,new-file.ts,util");
  expect(ghCalls(fixture).length).toBe(1);
});

test("hydrating VFS - ENOENT for files not in the manifest, with no gh call", async () => {
  const fixture = freshClone();

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const path = require('path');
    try {
      fs.readFileSync(path.join(${JSON.stringify(fixture.root)}, "does-not-exist.txt"), "utf-8");
      console.log("ERROR: should have thrown");
    } catch (err) {
      console.log("code:" + err.code);
    }
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("code:ENOENT");
  expect(ghCalls(fixture).length).toBe(0);
});

test("hydrating VFS - preserves the executable bit from the git tree", async () => {
  const fixture = freshClone();
  const target = path.join(fixture.root, "tools", "run.sh");

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    fs.readFileSync(${JSON.stringify(target)});
    const mode = fs.statSync(${JSON.stringify(target)}).mode;
    console.log("exec:" + ((mode & 0o100) !== 0));
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("exec:true");
});

test("hydrating VFS - async readFile and fs.promises hydrate too", async () => {
  const fixture = freshClone();

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const path = require('path');
    const root = ${JSON.stringify(fixture.root)};
    fs.readFile(path.join(root, "src", "index.ts"), "utf-8", (err, data) => {
      console.log("cb:" + (err ? err.code : data.trim()));
    });
    fs.promises.readFile(path.join(root, "src", "util", "helper.ts"), "utf-8").then((d) => {
      console.log("promise:" + d.trim());
    });
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("cb:export const answer = 42;");
  expect(stdout).toContain("promise:export function help() {}");
  expect(ghCalls(fixture).length).toBe(2);
});

test("hydrating VFS - writes pass through and manifest parent dirs are created", async () => {
  const fixture = freshClone();
  const target = path.join(fixture.root, "src", "util", "notes.txt");

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    fs.writeFileSync(${JSON.stringify(target)}, "hello");
    console.log("readback:" + fs.readFileSync(${JSON.stringify(target)}, "utf-8"));
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("readback:hello");
  expect(readFileSync(target, "utf-8")).toBe("hello");
  // Writing must not download anything
  expect(ghCalls(fixture).length).toBe(0);
});

test("hydrating VFS - unlink of an unhydrated manifest file is a tombstone", async () => {
  const fixture = freshClone();

  const { exitCode, stdout } = await runHydrated(
    `
    const fs = require('fs');
    const path = require('path');
    const p = path.join(${JSON.stringify(fixture.root)}, "src", "index.ts");
    console.log("before:" + fs.existsSync(p));
    fs.unlinkSync(p);
    console.log("after:" + fs.existsSync(p));
    console.log("listed:" + fs.readdirSync(path.dirname(p)).includes("index.ts"));
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("before:true");
  expect(stdout).toContain("after:false");
  expect(stdout).toContain("listed:false");
  expect(ghCalls(fixture).length).toBe(0);
});

test("hydrating VFS - paths outside the root pass through untouched", async () => {
  const fixture = freshClone();
  const outside = path.join(workDir, `outside-${cloneCounter}.txt`);
  writeFileSync(outside, "outside content");

  const { exitCode, stdout, events } = await runHydrated(
    `
    const fs = require('fs');
    console.log("outside:" + fs.readFileSync(${JSON.stringify(outside)}, "utf-8"));
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("outside:outside content");
  expect(ghCalls(fixture).length).toBe(0);
  expect(events.filter((e) => e.type === "hydrate_fetch").length).toBe(0);
});

test("hydrating VFS - git strategy fetches blobs from the promisor remote without gh", async () => {
  const fixture = freshClone();
  fixture.env.CC_HYDRATE_STRATEGY = "git";
  const target = path.join(fixture.root, "src", "index.ts");

  const { exitCode, stdout, events } = await runHydrated(
    `
    const fs = require('fs');
    console.log("read:" + fs.readFileSync(${JSON.stringify(target)}, "utf-8").trim());
    const helper = require('path').join(${JSON.stringify(fixture.root)}, "src", "util", "helper.ts");
    fs.promises.readFile(helper, "utf-8").then((d) => console.log("async:" + d.trim()));
    const readme = require('path').join(${JSON.stringify(fixture.root)}, "README.md");
    console.log("statsize:" + fs.statSync(readme).size);
  `,
    fixture,
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("read:export const answer = 42;");
  expect(stdout).toContain("async:export function help() {}");
  // No blob sizes without downloading under the git strategy: stat hydrates.
  expect(stdout).toContain(`statsize:${statSync(path.join(upstream, "README.md")).size}`);
  // gh was never invoked — content came through git's lazy promisor fetch
  expect(ghCalls(fixture).length).toBe(0);
  expect(readFileSync(target, "utf-8")).toBe("export const answer = 42;\n");

  const init = events.find((e) => e.type === "hydrate_init");
  expect(init?.strategy).toBe("git");
  expect(events.find((e) => e.type === "hydrate_fetch")?.rel).toBe("src/index.ts");
});

test("hydrating VFS - composes with the plan-file VFS preload", async () => {
  const fixture = freshClone();
  const planFile = path.join(PLANS_DIR, "hydrate-compose-test.md");

  const { exitCode, stdout, events } = await runHydrated(
    `
    const fs = require('fs');
    const path = require('path');
    // Read a repo file through the hydrating VFS
    const repoFile = path.join(${JSON.stringify(fixture.root)}, "README.md");
    console.log("repo:" + fs.readFileSync(repoFile, "utf-8").trim());
    // Write a plan file through the virtual VFS
    fs.writeFileSync(${JSON.stringify(planFile)}, "# Plan from blob-less repo");
    console.log("plan:" + fs.readFileSync(${JSON.stringify(planFile)}, "utf-8"));
  `,
    fixture,
    [VIRTUAL_SCRIPT, HYDRATE_SCRIPT],
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("repo:# Widgets");
  expect(stdout).toContain("plan:# Plan from blob-less repo");

  // Both preloads announced themselves and did their jobs
  expect(events.find((e) => e.type === "vfs_init")).toBeDefined();
  expect(events.find((e) => e.type === "hydrate_init")).toBeDefined();
  expect(events.find((e) => e.type === "hydrate_fetch")).toBeDefined();
  expect(events.find((e) => e.type === "vfs_write")).toBeDefined();

  // The plan file never touched disk; the repo file did
  expect(existsSync(planFile)).toBe(false);
  expect(existsSync(path.join(fixture.root, "README.md"))).toBe(true);
});
