/**
 * Virtual File System for Plan Files
 *
 * Completely virtualizes ~/.claude/plans/ - files never touch disk.
 * All reads/writes are intercepted and stored in memory.
 *
 * This allows:
 * - Streaming plan content to UI in real-time
 * - No disk I/O for plan files
 * - Complete control over plan file lifecycle
 */

const fs = require("node:fs");
const path = require("node:path");

import type {
  PathLike,
  PathOrFileDescriptor,
  NoParamCallback,
  ObjectEncodingOptions,
  StatSyncOptions,
  WriteFileOptions,
} from "node:fs";

type ReadFileOptions = BufferEncoding | (ObjectEncodingOptions & { flag?: string }) | null;
type ReadFileCallback = (err: NodeJS.ErrnoException | null, data?: string | Buffer) => void;

const PLANS_DIR = path.join(process.env.HOME, ".claude", "plans");

// In-memory virtual filesystem for plan files
const virtualFiles = new Map<string, string>();

// Helper to check if path is in plans directory
function isVirtualPath(filePath: PathOrFileDescriptor): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  const normalized = path.resolve(filePath);
  return normalized.startsWith(PLANS_DIR);
}

// Create a Node.js-style ENOENT error with proper errno fields.
function makeEnoent(
  syscall: string,
  filePath: PathOrFileDescriptor | PathLike,
): NodeJS.ErrnoException {
  const p = String(filePath);
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), {
    code: "ENOENT" as const,
    errno: -2,
    syscall,
    path: p,
  });
}

// Send an IPC message to the parent process if an IPC channel exists.
function sendIpc(msg: Record<string, unknown>): void {
  if (process.send) {
    process.send({ ...msg, timestamp: Date.now() });
  }
}

// Convert write data (string or ArrayBufferView) to a UTF-8 string.
function toContentString(data: string | NodeJS.ArrayBufferView): string {
  return typeof data === "string"
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
}

// Send init message via IPC
sendIpc({
  type: "vfs_init",
  plansDir: PLANS_DIR,
  mode: "virtual",
});

// Store original methods
const orig = {
  writeFile: fs.writeFile,
  writeFileSync: fs.writeFileSync,
  readFile: fs.readFile,
  readFileSync: fs.readFileSync,
  rename: fs.rename,
  renameSync: fs.renameSync,
  existsSync: fs.existsSync,
  statSync: fs.statSync,
  unlinkSync: fs.unlinkSync,
};

// Intercept fs.writeFileSync - store in memory instead of disk
fs.writeFileSync = function (
  filePath: PathOrFileDescriptor,
  data: string | NodeJS.ArrayBufferView,
  options?: WriteFileOptions,
) {
  if (isVirtualPath(filePath)) {
    const content = toContentString(data);
    const normalized = path.resolve(filePath);

    virtualFiles.set(normalized, content);

    sendIpc({
      type: "vfs_write",
      path: normalized,
      filename: path.basename(normalized),
      content,
      size: content.length,
    });

    return;
  }

  return orig.writeFileSync.call(this, filePath, data, options);
};

// Intercept fs.writeFile (async)
fs.writeFile = function (
  filePath: PathOrFileDescriptor,
  data: string | NodeJS.ArrayBufferView,
  options: WriteFileOptions | NoParamCallback,
  callback?: NoParamCallback,
) {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? undefined : options;

  if (isVirtualPath(filePath)) {
    const content = toContentString(data);
    const normalized = path.resolve(filePath);

    virtualFiles.set(normalized, content);

    sendIpc({
      type: "vfs_write",
      path: normalized,
      filename: path.basename(normalized),
      content,
      size: content.length,
    });

    // Simulate async completion
    if (cb) {
      process.nextTick(cb, null);
    }
    return;
  }

  return orig.writeFile.call(this, filePath, data, opts, cb);
};

// Intercept fs.readFileSync - read from memory
fs.readFileSync = function (filePath: PathOrFileDescriptor, options?: ReadFileOptions) {
  if (isVirtualPath(filePath)) {
    const normalized = path.resolve(filePath);
    const content = virtualFiles.get(normalized);

    if (content === undefined) {
      throw makeEnoent("open", filePath);
    }

    sendIpc({
      type: "vfs_read",
      path: normalized,
      filename: path.basename(normalized),
      size: content.length,
    });

    // Return from virtual filesystem
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? content : Buffer.from(content, "utf-8");
  }

  return orig.readFileSync.call(this, filePath, options);
};

// Intercept fs.readFile (async)
fs.readFile = function (
  filePath: PathOrFileDescriptor,
  options: ReadFileOptions | ReadFileCallback,
  callback?: ReadFileCallback,
) {
  const cb = typeof options === "function" ? options : callback;
  const opts: ReadFileOptions | undefined = typeof options === "function" ? undefined : options;

  if (isVirtualPath(filePath)) {
    const normalized = path.resolve(filePath);
    const content = virtualFiles.get(normalized);

    if (content === undefined) {
      const err = makeEnoent("open", filePath);
      if (cb) {
        process.nextTick(cb, err);
      } else {
        throw err;
      }
      return;
    }

    sendIpc({
      type: "vfs_read",
      path: normalized,
      filename: path.basename(normalized),
      size: content.length,
    });

    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    const result = encoding ? content : Buffer.from(content, "utf-8");

    if (cb) {
      process.nextTick(cb, null, result);
    }
    return;
  }

  return orig.readFile.call(this, filePath, opts, cb);
};

// Intercept fs.renameSync - rename in virtual filesystem
fs.renameSync = function (oldPath: PathLike, newPath: PathLike) {
  const oldVirtual = isVirtualPath(oldPath);
  const newVirtual = isVirtualPath(newPath);

  if (oldVirtual || newVirtual) {
    const oldNormalized = path.resolve(oldPath);
    const newNormalized = path.resolve(newPath);

    // Get content from virtual fs or disk
    let content: string | undefined;
    if (oldVirtual) {
      // Case 1: virtual -> virtual
      content = virtualFiles.get(oldNormalized);
      virtualFiles.delete(oldNormalized);
    } else {
      // Case 2: disk -> virtual
      content = orig.readFileSync.call(fs, oldPath, "utf-8");
      try {
        orig.unlinkSync.call(fs, oldPath);
      } catch (unlinkErr: unknown) {
        // Source cleanup failed after successful read — log but continue
        // since we already have the content for the virtual filesystem.
        sendIpc({
          type: "vfs_error",
          operation: "renameSync_unlink",
          path: oldNormalized,
          error: unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr),
        });
      }
    }

    if (content && newVirtual) {
      virtualFiles.set(newNormalized, content);

      sendIpc({
        type: "plan_file_write",
        path: newNormalized,
        filename: path.basename(newNormalized),
        content,
        size: content.length,
      });

      return;
    }
  }

  return orig.renameSync.call(this, oldPath, newPath);
};

// Intercept fs.existsSync - check virtual filesystem first
fs.existsSync = function (filePath: PathLike) {
  if (isVirtualPath(filePath)) {
    const normalized = path.resolve(filePath);
    return virtualFiles.has(normalized);
  }

  return orig.existsSync.call(this, filePath);
};

// Intercept fs.statSync - fake stats for virtual files
fs.statSync = function (filePath: PathLike, options?: StatSyncOptions) {
  if (isVirtualPath(filePath)) {
    const normalized = path.resolve(filePath);
    const content = virtualFiles.get(normalized);

    if (content === undefined) {
      throw makeEnoent("stat", filePath);
    }

    // Return fake stats
    const now = new Date();
    return {
      dev: 0,
      ino: 0,
      mode: 33188, // -rw-r--r--
      nlink: 1,
      uid: process.getuid?.() || 0,
      gid: process.getgid?.() || 0,
      rdev: 0,
      size: content.length,
      blksize: 4096,
      blocks: Math.ceil(content.length / 512),
      atimeMs: now.getTime(),
      mtimeMs: now.getTime(),
      ctimeMs: now.getTime(),
      birthtimeMs: now.getTime(),
      atime: now,
      mtime: now,
      ctime: now,
      birthtime: now,
      isFile: () => true,
      isDirectory: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    };
  }

  return orig.statSync.call(this, filePath, options);
};

// Intercept fs.unlinkSync - delete from virtual filesystem
fs.unlinkSync = function (filePath: PathLike) {
  if (isVirtualPath(filePath)) {
    const normalized = path.resolve(filePath);
    const existed = virtualFiles.delete(normalized);

    if (!existed) {
      throw makeEnoent("unlink", filePath);
    }

    sendIpc({
      type: "vfs_unlink",
      path: normalized,
      filename: path.basename(normalized),
    });

    return;
  }

  return orig.unlinkSync.call(this, filePath);
};
