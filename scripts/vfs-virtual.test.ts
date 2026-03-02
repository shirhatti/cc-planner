import { test, expect } from "bun:test";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

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
  // Track files that existed before test
  const filesBefore = new Set<string>();
  try {
    const existing = await Bun.readdir(PLANS_DIR);
    existing.forEach((f) => filesBefore.add(f));
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
    filesAfter = await Bun.readdir(PLANS_DIR);
  } catch {
    filesAfter = [];
  }

  const newFiles = filesAfter.filter((f) => !filesBefore.has(f));

  // Assert: No files should have been written to disk
  expect(newFiles.length).toBe(0);

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
