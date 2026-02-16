import { test, expect } from "bun:test";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");
const VFS_SCRIPT = path.join(PROJECT_ROOT, "preload", "vfs-virtual.ts");
const PLANS_DIR = path.join(process.env.HOME!, ".claude", "plans");

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
