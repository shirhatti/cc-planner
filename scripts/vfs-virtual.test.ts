import { test, expect } from "bun:test";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");
const VFS_SCRIPT = path.join(PROJECT_ROOT, "preload", "vfs-virtual.ts");
const PLANS_DIR = path.join(process.env.HOME!, ".claude", "plans");

interface TestResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  events: Record<string, unknown>[];
}

async function runWithVfs(script: string): Promise<TestResult> {
  const events: Record<string, unknown>[] = [];
  let stdout = "";
  let stderr = "";

  const proc = spawn("bun", ["--preload", VFS_SCRIPT, "-e", script], {
    stdio: ["inherit", "pipe", "pipe", "ipc"],
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

  const exitCode = await new Promise<number | null>((resolve) => {
    proc.on("exit", (code) => resolve(code));
  });

  return { exitCode, stdout, stderr, events };
}

test("virtual VFS - plan files never touch disk", async () => {
  // Ensure the real plans dir exists so the "nothing new on disk" check is meaningful
  mkdirSync(PLANS_DIR, { recursive: true });

  // Track files that existed before test
  const filesBefore = new Set<string>();
  try {
    readdirSync(PLANS_DIR).forEach((f) => filesBefore.add(f));
  } catch {
    // Plans directory doesn't exist yet
  }

  const events: Record<string, unknown>[] = [];

  // Create a simple test script
  const testScript = `
const fs = require('fs');
const path = require('path');

const plansDir = "${PLANS_DIR}";
const testFile = path.join(plansDir, "virtual-test.md");
const tempFile = path.join(plansDir, "virtual-test.md.tmp.99999");

console.log("Writing to temp file...");
fs.writeFileSync(tempFile, "# Test Plan\\n\\nThis is a test.");

console.log("Renaming to final file...");
fs.renameSync(tempFile, testFile);

console.log("Reading back...");
const content = fs.readFileSync(testFile, "utf-8");
console.log("Read:", content.substring(0, 50));

console.log("Checking existence...");
console.log("Exists:", fs.existsSync(testFile));

console.log("Getting stats...");
const stats = fs.statSync(testFile);
console.log("Size:", stats.size);

console.log("All operations complete!");
`;

  const proc = spawn("bun", ["--preload", VFS_SCRIPT, "-e", testScript], {
    stdio: ["inherit", "pipe", "pipe", "ipc"],
  });

  proc.on("message", (msg: Record<string, unknown>) => {
    events.push(msg);
  });

  // Wait for process to complete
  const exitCode = await new Promise<number | null>((resolve) => {
    proc.on("exit", (code) => resolve(code));
  });

  expect(exitCode).toBe(0);

  // Wait a bit for filesystem to settle
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Check if any new files were created on disk
  let filesAfter: string[];
  try {
    filesAfter = readdirSync(PLANS_DIR);
  } catch {
    filesAfter = [];
  }

  const newFiles = filesAfter.filter((f) => !filesBefore.has(f));

  // Assert: No files should have been written to disk
  expect(newFiles).toEqual([]);
  expect(existsSync(path.join(PLANS_DIR, "virtual-test.md"))).toBe(false);
  expect(existsSync(path.join(PLANS_DIR, "virtual-test.md.tmp.99999"))).toBe(false);

  // Assert: We should have received VFS events
  expect(events.length).toBeGreaterThan(0);

  const vfsInit = events.find((e) => e.type === "vfs_init");
  const planWrite = events.find((e) => e.type === "plan_file_write");

  expect(vfsInit).toBeDefined();
  expect(vfsInit?.mode).toBe("virtual");

  expect(planWrite).toBeDefined();
  expect(planWrite?.filename).toBe("virtual-test.md");
  expect(planWrite?.content).toContain("# Test Plan");
});

test("virtual VFS - regular files pass through to disk", async () => {
  const TEST_FILE = path.join(PROJECT_ROOT, "test-passthrough-file.txt");

  // Clean up test file if it exists
  if (existsSync(TEST_FILE)) {
    await Bun.write(TEST_FILE, ""); // Clear it
  }

  const events: Record<string, unknown>[] = [];

  const testScript = `
const fs = require('fs');

const regularFile = "${TEST_FILE}";
const content = "This is a regular file that should touch disk.";

fs.writeFileSync(regularFile, content);

const exists = fs.existsSync(regularFile);
console.log("Exists:", exists);

const readContent = fs.readFileSync(regularFile, "utf-8");
console.log("Read:", readContent.substring(0, 50));

const stats = fs.statSync(regularFile);
console.log("Size:", stats.size);

console.log("All operations complete!");
`;

  const proc = spawn("bun", ["--preload", VFS_SCRIPT, "-e", testScript], {
    stdio: ["inherit", "pipe", "pipe", "ipc"],
  });

  proc.on("message", (msg: Record<string, unknown>) => {
    events.push(msg);
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    proc.on("exit", (code) => resolve(code));
  });

  expect(exitCode).toBe(0);

  // Wait a bit for filesystem
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Assert: Regular file should exist on disk
  const fileExists = existsSync(TEST_FILE);
  expect(fileExists).toBe(true);

  // Assert: VFS should not have intercepted regular file operations
  const vfsEvents = events.filter((e) => e.type === "vfs_write" || e.type === "vfs_read");
  expect(vfsEvents.length).toBe(0);

  // Clean up
  if (existsSync(TEST_FILE)) {
    await Bun.$`rm ${TEST_FILE}`;
  }
});

test("virtual VFS - readFileSync throws ENOENT for non-existent plan files", async () => {
  const { exitCode, stdout } = await runWithVfs(`
    const fs = require('fs');
    const path = require('path');
    const testFile = path.join("${PLANS_DIR}", "does-not-exist.md");
    try {
      fs.readFileSync(testFile, "utf-8");
      console.log("ERROR: should have thrown");
    } catch (err) {
      console.log("code:" + err.code);
      console.log("syscall:" + err.syscall);
      console.log("errno:" + err.errno);
    }
  `);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("code:ENOENT");
  expect(stdout).toContain("syscall:open");
  expect(stdout).toContain("errno:-2");
});

test("virtual VFS - readFile async calls back with ENOENT for non-existent plan files", async () => {
  const { exitCode, stdout } = await runWithVfs(`
    const fs = require('fs');
    const path = require('path');
    const testFile = path.join("${PLANS_DIR}", "does-not-exist-async.md");
    fs.readFile(testFile, "utf-8", (err, data) => {
      if (err) {
        console.log("code:" + err.code);
        console.log("syscall:" + err.syscall);
        console.log("errno:" + err.errno);
      } else {
        console.log("ERROR: should have received error");
      }
    });
  `);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("code:ENOENT");
  expect(stdout).toContain("syscall:open");
  expect(stdout).toContain("errno:-2");
});

test("virtual VFS - statSync returns correct size and isFile for virtual files", async () => {
  const { exitCode, stdout } = await runWithVfs(`
    const fs = require('fs');
    const path = require('path');
    const testFile = path.join("${PLANS_DIR}", "stat-test.md");
    fs.writeFileSync(testFile, "hello world");
    const stats = fs.statSync(testFile);
    console.log("size:" + stats.size);
    console.log("isFile:" + stats.isFile());
    console.log("isDir:" + stats.isDirectory());
  `);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("size:11");
  expect(stdout).toContain("isFile:true");
  expect(stdout).toContain("isDir:false");
});

test("virtual VFS - statSync throws ENOENT for non-existent plan files", async () => {
  const { exitCode, stdout } = await runWithVfs(`
    const fs = require('fs');
    const path = require('path');
    const testFile = path.join("${PLANS_DIR}", "stat-missing.md");
    try {
      fs.statSync(testFile);
      console.log("ERROR: should have thrown");
    } catch (err) {
      console.log("code:" + err.code);
      console.log("syscall:" + err.syscall);
      console.log("errno:" + err.errno);
    }
  `);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("code:ENOENT");
  expect(stdout).toContain("syscall:stat");
  expect(stdout).toContain("errno:-2");
});

test("virtual VFS - unlinkSync deletes virtual files", async () => {
  const { exitCode, stdout, events } = await runWithVfs(`
    const fs = require('fs');
    const path = require('path');
    const testFile = path.join("${PLANS_DIR}", "unlink-test.md");
    fs.writeFileSync(testFile, "to be deleted");
    console.log("before:" + fs.existsSync(testFile));
    fs.unlinkSync(testFile);
    console.log("after:" + fs.existsSync(testFile));
  `);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("before:true");
  expect(stdout).toContain("after:false");
  expect(events.find((e) => e.type === "vfs_unlink")).toBeDefined();
});

test("virtual VFS - unlinkSync throws ENOENT for non-existent plan files", async () => {
  const { exitCode, stdout } = await runWithVfs(`
    const fs = require('fs');
    const path = require('path');
    const testFile = path.join("${PLANS_DIR}", "unlink-missing.md");
    try {
      fs.unlinkSync(testFile);
      console.log("ERROR: should have thrown");
    } catch (err) {
      console.log("code:" + err.code);
      console.log("syscall:" + err.syscall);
      console.log("errno:" + err.errno);
    }
  `);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("code:ENOENT");
  expect(stdout).toContain("syscall:unlink");
  expect(stdout).toContain("errno:-2");
});

test("virtual VFS - renameSync completes atomic write pattern", async () => {
  const { exitCode, stdout, events } = await runWithVfs(`
    const fs = require('fs');
    const path = require('path');
    const temp = path.join("${PLANS_DIR}", "plan.md.tmp.123.456");
    const final_ = path.join("${PLANS_DIR}", "plan.md");
    fs.writeFileSync(temp, "atomic content");
    fs.renameSync(temp, final_);
    console.log("tempExists:" + fs.existsSync(temp));
    console.log("finalExists:" + fs.existsSync(final_));
    console.log("content:" + fs.readFileSync(final_, "utf-8"));
  `);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("tempExists:false");
  expect(stdout).toContain("finalExists:true");
  expect(stdout).toContain("content:atomic content");
  const planWrite = events.find((e) => e.type === "plan_file_write");
  expect(planWrite).toBeDefined();
  expect(planWrite?.content).toBe("atomic content");
});

test("virtual VFS - readFileSync returns Buffer when no encoding specified", async () => {
  const { exitCode, stdout } = await runWithVfs(`
    const fs = require('fs');
    const path = require('path');
    const testFile = path.join("${PLANS_DIR}", "buffer-test.md");
    fs.writeFileSync(testFile, "buffer content");
    const result = fs.readFileSync(testFile);
    console.log("isBuffer:" + Buffer.isBuffer(result));
    console.log("content:" + result.toString("utf-8"));
  `);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("isBuffer:true");
  expect(stdout).toContain("content:buffer content");
});

test("virtual VFS - existsSync works for virtual paths", async () => {
  const { exitCode, stdout } = await runWithVfs(`
    const fs = require('fs');
    const path = require('path');
    const testFile = path.join("${PLANS_DIR}", "exists-test.md");
    console.log("before:" + fs.existsSync(testFile));
    fs.writeFileSync(testFile, "exists");
    console.log("after:" + fs.existsSync(testFile));
  `);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("before:false");
  expect(stdout).toContain("after:true");
});

test("virtual VFS - non-ASCII content reports byte size and round-trips exactly", async () => {
  const text = "héllo ✓ 日本";
  const bytes = Buffer.byteLength(text, "utf-8");
  const { exitCode, stdout, stderr, events } = await runWithVfs(`
    const fs = require('fs');
    const path = require('path');
    const f = path.join(${JSON.stringify(PLANS_DIR)}, "utf8-test.md");
    const text = ${JSON.stringify(text)};
    fs.writeFileSync(f, text);
    console.log("size:" + fs.statSync(f).size);
    const buf = fs.readFileSync(f);
    console.log("bufLen:" + buf.length);
    console.log("bufEq:" + buf.equals(Buffer.from(text, "utf-8")));
    console.log("utf8Eq:" + (fs.readFileSync(f, "utf-8") === text));
    console.log("b64Eq:" + (fs.readFileSync(f, { encoding: "base64" }) === Buffer.from(text).toString("base64")));
    buf[0] = 0; // mutating the returned buffer must not affect the stored file
    console.log("unmutated:" + (fs.readFileSync(f, "utf8") === text));
    fs.writeFileSync(f, Buffer.from(text).toString("base64"), { encoding: "base64" });
    console.log("b64WriteEq:" + (fs.readFileSync(f, "utf8") === text));
  `);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`size:${bytes}`);
  expect(stdout).toContain(`bufLen:${bytes}`);
  expect(stdout).toContain("bufEq:true");
  expect(stdout).toContain("utf8Eq:true");
  expect(stdout).toContain("b64Eq:true");
  expect(stdout).toContain("unmutated:true");
  expect(stdout).toContain("b64WriteEq:true");
  const write = events.find((e) => e.type === "vfs_write");
  expect(write?.content).toBe(text);
  expect(write?.size).toBe(bytes);
});

test("virtual VFS - sibling dirs with plans prefix and the plans dir itself hit disk", async () => {
  const sibling = PLANS_DIR + `-vfstest-${process.pid}`;
  const siblingFile = path.join(sibling, "x.md");
  try {
    const { exitCode, stdout, stderr, events } = await runWithVfs(`
      const fs = require('fs');
      fs.mkdirSync(${JSON.stringify(sibling)}, { recursive: true });
      fs.writeFileSync(${JSON.stringify(siblingFile)}, "on disk");
      fs.mkdirSync(${JSON.stringify(PLANS_DIR)}, { recursive: true });
      console.log("dirExists:" + fs.existsSync(${JSON.stringify(PLANS_DIR)}));
      console.log("dirIsDir:" + fs.statSync(${JSON.stringify(PLANS_DIR)}).isDirectory());
    `);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("dirExists:true");
    expect(stdout).toContain("dirIsDir:true");
    expect(readFileSync(siblingFile, "utf-8")).toBe("on disk");
    expect(events.filter((e) => e.type === "vfs_write")).toEqual([]);
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }
});

test("virtual VFS - renameSync handles empty plans, missing sources and virtual->disk", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "vfs-virtual-"));
  const diskTarget = path.join(tmpDir, "exported.md");
  try {
    const { exitCode, stdout, stderr, events } = await runWithVfs(`
      const fs = require('fs');
      const path = require('path');
      const dir = ${JSON.stringify(PLANS_DIR)};
      const tmp = path.join(dir, "empty.md.tmp.1");
      const final_ = path.join(dir, "empty.md");
      fs.writeFileSync(tmp, "");
      fs.renameSync(tmp, final_);
      console.log("emptyExists:" + fs.existsSync(final_));
      console.log("emptyContent:[" + fs.readFileSync(final_, "utf-8") + "]");
      console.log("tmpExists:" + fs.existsSync(tmp));
      try {
        fs.renameSync(path.join(dir, "nope.md.tmp.2"), final_);
        console.log("ERROR: should have thrown");
      } catch (err) {
        console.log("code:" + err.code + " syscall:" + err.syscall);
      }
      const src = path.join(dir, "export.md");
      fs.writeFileSync(src, "exported ✓");
      fs.renameSync(src, ${JSON.stringify(diskTarget)});
      console.log("srcExists:" + fs.existsSync(src));
    `);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("emptyExists:true");
    expect(stdout).toContain("emptyContent:[]");
    expect(stdout).toContain("tmpExists:false");
    expect(stdout).toContain("code:ENOENT syscall:rename");
    expect(stdout).toContain("srcExists:false");
    expect(readFileSync(diskTarget, "utf-8")).toBe("exported ✓");
    const planWrite = events.find((e) => e.type === "plan_file_write");
    expect(planWrite?.filename).toBe("empty.md");
    expect(planWrite?.content).toBe("");
    expect(planWrite?.size).toBe(0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("virtual VFS - fs.promises is intercepted with the same semantics", async () => {
  const { exitCode, stdout, stderr, events } = await runWithVfs(`
    const fsp = require('fs/promises');
    const path = require('path');
    const dir = ${JSON.stringify(PLANS_DIR)};
    const tmp = path.join(dir, "promise.md.tmp.1.2");
    const final_ = path.join(dir, "promise.md");
    (async () => {
      await fsp.writeFile(tmp, "promised ✓");
      await fsp.rename(tmp, final_);
      console.log("content:" + (await fsp.readFile(final_, "utf-8")));
      console.log("isBuffer:" + Buffer.isBuffer(await fsp.readFile(final_)));
      console.log("size:" + (await fsp.stat(final_)).size);
      console.log("lstatFile:" + (await fsp.lstat(final_)).isFile());
      await fsp.access(final_);
      console.log("access:ok");
      await fsp.unlink(final_);
      for (const [name, fn] of [
        ["readFile", () => fsp.readFile(final_)],
        ["stat", () => fsp.stat(final_)],
        ["access", () => fsp.access(final_)],
        ["unlink", () => fsp.unlink(final_)],
        ["rename", () => fsp.rename(final_, tmp)],
      ]) {
        try {
          await fn();
          console.log(name + ":ERROR");
        } catch (err) {
          console.log(name + ":" + err.code + ":" + err.syscall);
        }
      }
    })();
  `);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("content:promised ✓");
  expect(stdout).toContain("isBuffer:true");
  expect(stdout).toContain(`size:${Buffer.byteLength("promised ✓")}`);
  expect(stdout).toContain("lstatFile:true");
  expect(stdout).toContain("access:ok");
  expect(stdout).toContain("readFile:ENOENT:open");
  expect(stdout).toContain("stat:ENOENT:stat");
  expect(stdout).toContain("access:ENOENT:access");
  expect(stdout).toContain("unlink:ENOENT:unlink");
  expect(stdout).toContain("rename:ENOENT:rename");
  expect(events.find((e) => e.type === "vfs_write")?.filename).toBe("promise.md.tmp.1.2");
  const planWrite = events.find((e) => e.type === "plan_file_write");
  expect(planWrite?.filename).toBe("promise.md");
  expect(planWrite?.content).toBe("promised ✓");
  expect(events.find((e) => e.type === "vfs_unlink")).toBeDefined();
  expect(existsSync(path.join(PLANS_DIR, "promise.md"))).toBe(false);
});

test("virtual VFS - statSync/lstatSync honor throwIfNoEntry and callback APIs work", async () => {
  const { exitCode, stdout, stderr, events } = await runWithVfs(`
    const fs = require('fs');
    const path = require('path');
    const dir = ${JSON.stringify(PLANS_DIR)};
    const missing = path.join(dir, "missing.md");
    console.log("stat:" + fs.statSync(missing, { throwIfNoEntry: false }));
    console.log("lstat:" + fs.lstatSync(missing, { throwIfNoEntry: false }));
    const tmp = path.join(dir, "cb.md.tmp.1");
    const final_ = path.join(dir, "cb.md");
    fs.writeFileSync(tmp, "callback");
    console.log("lstatSize:" + fs.lstatSync(tmp).size);
    fs.rename(tmp, final_, (err) => {
      console.log("renameErr:" + err);
      fs.stat(final_, (err, st) => {
        console.log("cbStat:" + st.size);
        fs.access(final_, fs.constants.R_OK, (err) => {
          console.log("accessErr:" + err);
          fs.unlink(final_, (err) => {
            console.log("unlinkErr:" + err);
            fs.stat(final_, (err) => console.log("statAfter:" + err.code));
          });
        });
      });
    });
  `);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("stat:undefined");
  expect(stdout).toContain("lstat:undefined");
  expect(stdout).toContain("lstatSize:8");
  expect(stdout).toContain("renameErr:null");
  expect(stdout).toContain("cbStat:8");
  expect(stdout).toContain("accessErr:null");
  expect(stdout).toContain("unlinkErr:null");
  expect(stdout).toContain("statAfter:ENOENT");
  expect(events.find((e) => e.type === "plan_file_write")?.filename).toBe("cb.md");
});
