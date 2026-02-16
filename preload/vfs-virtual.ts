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

const PLANS_DIR = path.join(process.env.HOME, ".claude", "plans");

// In-memory virtual filesystem for plan files
const virtualFiles = new Map<string, string>();

// Helper to check if path is in plans directory
function isVirtualPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  const normalized = path.resolve(filePath);
  return normalized.startsWith(PLANS_DIR);
}

// Send init message via IPC
if (process.send) {
  process.send({
    type: "vfs_init",
    plansDir: PLANS_DIR,
    mode: "virtual",
    timestamp: Date.now(),
  });
}

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
fs.writeFileSync = function (filePath: any, data: any, options?: any) {
  if (isVirtualPath(filePath)) {
    const content = typeof data === "string" ? data : data?.toString("utf-8") || "";
    const normalized = path.resolve(filePath);

    // Store in virtual filesystem
    virtualFiles.set(normalized, content);

    // Broadcast write event
    if (process.send) {
      process.send({
        type: "vfs_write",
        path: normalized,
        filename: path.basename(normalized),
        content,
        size: content.length,
        timestamp: Date.now(),
      });
    }

    // Don't call original - file is virtual!
    return;
  }

  // Non-virtual files go to disk
  return orig.writeFileSync.call(this, filePath, data, options);
};

// Intercept fs.writeFile (async)
fs.writeFile = function (filePath: any, data: any, options: any, callback?: any) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }

  if (isVirtualPath(filePath)) {
    const content = typeof data === "string" ? data : data?.toString("utf-8") || "";
    const normalized = path.resolve(filePath);

    virtualFiles.set(normalized, content);

    if (process.send) {
      process.send({
        type: "vfs_write",
        path: normalized,
        filename: path.basename(normalized),
        content,
        size: content.length,
        timestamp: Date.now(),
      });
    }

    // Simulate async completion
    if (callback) {
      process.nextTick(callback, null);
    }
    return;
  }

  return orig.writeFile.call(this, filePath, data, options, callback);
};

// Intercept fs.readFileSync - read from memory
fs.readFileSync = function (filePath: any, options?: any) {
  if (isVirtualPath(filePath)) {
    const normalized = path.resolve(filePath);
    const content = virtualFiles.get(normalized);

    if (content === undefined) {
      // File doesn't exist in VFS
      const err: any = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      err.code = "ENOENT";
      err.errno = -2;
      err.syscall = "open";
      err.path = filePath;
      throw err;
    }

    // Broadcast read event
    if (process.send) {
      process.send({
        type: "vfs_read",
        path: normalized,
        filename: path.basename(normalized),
        size: content.length,
        timestamp: Date.now(),
      });
    }

    // Return from virtual filesystem
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? content : Buffer.from(content, "utf-8");
  }

  return orig.readFileSync.call(this, filePath, options);
};

// Intercept fs.readFile (async)
fs.readFile = function (filePath: any, options: any, callback?: any) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }

  if (isVirtualPath(filePath)) {
    const normalized = path.resolve(filePath);
    const content = virtualFiles.get(normalized);

    if (content === undefined) {
      const err: any = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      err.code = "ENOENT";
      if (callback) {
        process.nextTick(callback, err);
      }
      return;
    }

    // Broadcast read event only for files that exist
    if (process.send) {
      process.send({
        type: "vfs_read",
        path: normalized,
        filename: path.basename(normalized),
        size: content.length,
        timestamp: Date.now(),
      });
    }

    const encoding = typeof options === "string" ? options : options?.encoding;
    const result = encoding ? content : Buffer.from(content, "utf-8");

    if (callback) {
      process.nextTick(callback, null, result);
    }
    return;
  }

  return orig.readFile.call(this, filePath, options, callback);
};

// Intercept fs.renameSync - rename in virtual filesystem
fs.renameSync = function (oldPath: any, newPath: any) {
  const oldVirtual = isVirtualPath(oldPath);
  const newVirtual = isVirtualPath(newPath);

  if (oldVirtual || newVirtual) {
    const oldNormalized = path.resolve(oldPath);
    const newNormalized = path.resolve(newPath);

    // Get content from virtual fs or disk
    let content: string | undefined;
    if (oldVirtual) {
      content = virtualFiles.get(oldNormalized);
      virtualFiles.delete(oldNormalized);
    } else {
      // Reading from disk, moving to virtual
      content = orig.readFileSync.call(fs, oldPath, "utf-8");
      try {
        orig.unlinkSync.call(fs, oldPath);
      } catch (unlinkErr: any) {
        // Source cleanup failed after successful read — log but continue
        // since we already have the content for the virtual filesystem.
        if (process.send) {
          process.send({
            type: "vfs_error",
            operation: "renameSync_unlink",
            path: oldNormalized,
            error: unlinkErr?.message || String(unlinkErr),
            timestamp: Date.now(),
          });
        }
      }
    }

    if (content && newVirtual) {
      // Store with new name
      virtualFiles.set(newNormalized, content);

      // Broadcast rename event with final content
      if (process.send) {
        process.send({
          type: "plan_file_write",
          path: newNormalized,
          filename: path.basename(newNormalized),
          content,
          size: content.length,
          timestamp: Date.now(),
        });
      }

      return; // Don't touch disk
    }
  }

  return orig.renameSync.call(this, oldPath, newPath);
};

// Intercept fs.existsSync - check virtual filesystem first
fs.existsSync = function (filePath: any) {
  if (isVirtualPath(filePath)) {
    const normalized = path.resolve(filePath);
    return virtualFiles.has(normalized);
  }

  return orig.existsSync.call(this, filePath);
};

// Intercept fs.statSync - fake stats for virtual files
fs.statSync = function (filePath: any, options?: any) {
  if (isVirtualPath(filePath)) {
    const normalized = path.resolve(filePath);
    const content = virtualFiles.get(normalized);

    if (content === undefined) {
      const err: any = new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
      err.code = "ENOENT";
      throw err;
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
fs.unlinkSync = function (filePath: any) {
  if (isVirtualPath(filePath)) {
    const normalized = path.resolve(filePath);
    const existed = virtualFiles.delete(normalized);

    if (!existed) {
      const err: any = new Error(`ENOENT: no such file or directory, unlink '${filePath}'`);
      err.code = "ENOENT";
      throw err;
    }

    if (process.send) {
      process.send({
        type: "vfs_unlink",
        path: normalized,
        filename: path.basename(normalized),
        timestamp: Date.now(),
      });
    }

    return;
  }

  return orig.unlinkSync.call(this, filePath);
};
