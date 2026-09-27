/**
 * Virtual File System for Plan Files
 *
 * Completely virtualizes files under ~/.claude/plans/ - they never touch disk.
 * All reads/writes are intercepted and stored in memory.
 *
 * The plans directory itself is NOT virtual: mkdir/stat/exists on the
 * directory (and readdir, which is not intercepted) pass through to disk, so
 * callers that `mkdirSync(plansDir, { recursive: true })` keep working. Only
 * paths strictly inside the directory are virtual.
 *
 * This allows:
 * - Streaming plan content to UI in real-time
 * - No disk I/O for plan files
 * - Complete control over plan file lifecycle
 */

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

// Injected via BUN_OPTIONS (scripts/lib/spawn-vfs.ts): restore the caller's
// own BUN_OPTIONS so subprocesses claude runs don't inherit the VFS preloads.
if (process.env.CC_VFS_ORIGINAL_BUN_OPTIONS !== undefined) {
  const original = process.env.CC_VFS_ORIGINAL_BUN_OPTIONS;
  if (original) process.env.BUN_OPTIONS = original;
  else delete process.env.BUN_OPTIONS;
  delete process.env.CC_VFS_ORIGINAL_BUN_OPTIONS;
}

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
type ErrCallback = (err: NodeJS.ErrnoException | null, result?: unknown) => void;

const PLANS_DIR: string = path.join(process.env.HOME, ".claude", "plans");

interface VirtualEntry {
  data: Buffer;
  birthtime: Date;
  mtime: Date;
}

// In-memory virtual filesystem for plan files, keyed by resolved path.
const virtualFiles = new Map<string, VirtualEntry>();

// Convert a path-like (string, Buffer, file: URL) to a string; null for fds.
function toPathString(filePath: unknown): string | null {
  if (typeof filePath === "string") return filePath;
  if (Buffer.isBuffer(filePath)) return filePath.toString("utf-8");
  if (filePath instanceof URL) {
    return filePath.protocol === "file:" ? fileURLToPath(filePath) : null;
  }
  return null;
}

function resolvePath(filePath: unknown): string {
  return path.resolve(toPathString(filePath) ?? String(filePath));
}

// Helper to check if path is strictly inside the plans directory.
function isVirtualPath(filePath: unknown): boolean {
  const p = toPathString(filePath);
  if (!p) return false;
  return path.resolve(p).startsWith(PLANS_DIR + path.sep);
}

// Create a Node.js-style ENOENT error with proper errno fields.
function makeEnoent(syscall: string, filePath: unknown, dest?: unknown): NodeJS.ErrnoException {
  const p = toPathString(filePath) ?? String(filePath);
  const d = dest === undefined ? undefined : (toPathString(dest) ?? String(dest));
  const target = d === undefined ? `'${p}'` : `'${p}' -> '${d}'`;
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} ${target}`), {
    code: "ENOENT" as const,
    errno: -2,
    syscall,
    path: p,
    ...(d === undefined ? {} : { dest: d }),
  });
}

// Send an IPC message to the parent process if an IPC channel exists.
function sendIpc(msg: Record<string, unknown>): void {
  if (process.send) {
    process.send({ ...msg, timestamp: Date.now() });
  }
}

function encodingOf(options: unknown): BufferEncoding | "buffer" | null {
  if (typeof options === "string") return options as BufferEncoding;
  if (options && typeof options === "object" && "encoding" in options) {
    return ((options as { encoding?: BufferEncoding | null }).encoding ?? null) as BufferEncoding;
  }
  return null;
}

// Convert write data (string or ArrayBufferView) to a Buffer copy.
function toBuffer(data: string | NodeJS.ArrayBufferView, options?: unknown): Buffer {
  if (typeof data === "string") {
    const enc = encodingOf(options);
    return Buffer.from(data, enc && enc !== "buffer" ? enc : "utf-8");
  }
  return Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

// Decode stored bytes per the requested encoding; always returns a copy.
function decode(data: Buffer, options: unknown): string | Buffer {
  const enc = encodingOf(options);
  return enc && enc !== "buffer" ? data.toString(enc) : Buffer.from(data);
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
  lstatSync: fs.lstatSync,
  stat: fs.stat,
  lstat: fs.lstat,
  accessSync: fs.accessSync,
  access: fs.access,
  unlinkSync: fs.unlinkSync,
  unlink: fs.unlink,
};

const promises = fs.promises;
const origPromises = {
  readFile: promises.readFile,
  writeFile: promises.writeFile,
  rename: promises.rename,
  unlink: promises.unlink,
  stat: promises.stat,
  lstat: promises.lstat,
  access: promises.access,
};

// ---------------------------------------------------------------------------
// Core virtual operations (synchronous; throw Node-style errors)
// ---------------------------------------------------------------------------

function vWrite(filePath: unknown, data: string | NodeJS.ArrayBufferView, options?: unknown): void {
  const normalized = resolvePath(filePath);
  const buf = toBuffer(data, options);
  const now = new Date();
  const prev = virtualFiles.get(normalized);
  virtualFiles.set(normalized, { data: buf, birthtime: prev?.birthtime ?? now, mtime: now });

  sendIpc({
    type: "vfs_write",
    path: normalized,
    filename: path.basename(normalized),
    content: buf.toString("utf-8"),
    size: buf.length,
  });
}

function vRead(filePath: unknown, options: unknown): string | Buffer {
  const normalized = resolvePath(filePath);
  const entry = virtualFiles.get(normalized);
  if (!entry) throw makeEnoent("open", filePath);

  sendIpc({
    type: "vfs_read",
    path: normalized,
    filename: path.basename(normalized),
    size: entry.data.length,
  });

  return decode(entry.data, options);
}

function makeStats(entry: VirtualEntry) {
  const size = entry.data.length;
  return {
    dev: 0,
    ino: 0,
    mode: 0o100644, // regular file, -rw-r--r--
    nlink: 1,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    rdev: 0,
    size,
    blksize: 4096,
    blocks: Math.ceil(size / 4096) * 8, // 512-byte blocks, allocated in 4K units
    atimeMs: entry.mtime.getTime(),
    mtimeMs: entry.mtime.getTime(),
    ctimeMs: entry.mtime.getTime(),
    birthtimeMs: entry.birthtime.getTime(),
    atime: entry.mtime,
    mtime: entry.mtime,
    ctime: entry.mtime,
    birthtime: entry.birthtime,
    isFile: () => true,
    isDirectory: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function vStat(filePath: unknown, syscall: string) {
  const entry = virtualFiles.get(resolvePath(filePath));
  if (!entry) throw makeEnoent(syscall, filePath);
  return makeStats(entry);
}

function vAccess(filePath: unknown): void {
  if (!virtualFiles.has(resolvePath(filePath))) throw makeEnoent("access", filePath);
}

function vUnlink(filePath: unknown): void {
  const normalized = resolvePath(filePath);
  if (!virtualFiles.delete(normalized)) throw makeEnoent("unlink", filePath);

  sendIpc({
    type: "vfs_unlink",
    path: normalized,
    filename: path.basename(normalized),
  });
}

// Rename where at least one side is virtual.
function vRename(oldPath: unknown, newPath: unknown): void {
  const oldVirtual = isVirtualPath(oldPath);
  const newVirtual = isVirtualPath(newPath);
  const oldNormalized = resolvePath(oldPath);
  const newNormalized = resolvePath(newPath);

  let data: Buffer;
  if (oldVirtual) {
    const entry = virtualFiles.get(oldNormalized);
    if (!entry) throw makeEnoent("rename", oldPath, newPath);
    data = entry.data;
  } else {
    // disk -> virtual: read the source (throws its own ENOENT if missing)
    data = orig.readFileSync.call(fs, oldPath);
  }

  if (newVirtual) {
    const now = new Date();
    virtualFiles.set(newNormalized, { data, birthtime: now, mtime: now });
  } else {
    // virtual -> disk
    orig.writeFileSync.call(fs, newPath, data);
  }

  // Remove the source (skip when renaming onto itself).
  if (oldNormalized !== newNormalized) {
    if (oldVirtual) {
      virtualFiles.delete(oldNormalized);
    } else {
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
  }

  if (newVirtual) {
    sendIpc({
      type: "plan_file_write",
      path: newNormalized,
      filename: path.basename(newNormalized),
      content: data.toString("utf-8"),
      size: data.length,
    });
  }
}

// Run a sync virtual op and deliver its result/error to a Node-style callback.
function deliver(cb: ErrCallback | undefined, fn: () => unknown): void {
  let result: unknown;
  try {
    result = fn();
  } catch (err) {
    if (!cb) throw err;
    process.nextTick(cb, err);
    return;
  }
  if (cb) process.nextTick(cb, null, result);
}

// ---------------------------------------------------------------------------
// Sync API
// ---------------------------------------------------------------------------

fs.writeFileSync = function (
  filePath: PathOrFileDescriptor,
  data: string | NodeJS.ArrayBufferView,
  options?: WriteFileOptions,
) {
  if (isVirtualPath(filePath)) return vWrite(filePath, data, options);
  return orig.writeFileSync.call(this, filePath, data, options);
};

fs.readFileSync = function (filePath: PathOrFileDescriptor, options?: ReadFileOptions) {
  if (isVirtualPath(filePath)) return vRead(filePath, options);
  return orig.readFileSync.call(this, filePath, options);
};

fs.renameSync = function (oldPath: PathLike, newPath: PathLike) {
  if (isVirtualPath(oldPath) || isVirtualPath(newPath)) return vRename(oldPath, newPath);
  return orig.renameSync.call(this, oldPath, newPath);
};

fs.existsSync = function (filePath: PathLike) {
  if (isVirtualPath(filePath)) return virtualFiles.has(resolvePath(filePath));
  return orig.existsSync.call(this, filePath);
};

fs.statSync = function (filePath: PathLike, options?: StatSyncOptions) {
  if (isVirtualPath(filePath)) {
    if (options?.throwIfNoEntry === false && !virtualFiles.has(resolvePath(filePath))) {
      return undefined;
    }
    return vStat(filePath, "stat");
  }
  return orig.statSync.call(this, filePath, options);
};

fs.lstatSync = function (filePath: PathLike, options?: StatSyncOptions) {
  if (isVirtualPath(filePath)) {
    if (options?.throwIfNoEntry === false && !virtualFiles.has(resolvePath(filePath))) {
      return undefined;
    }
    return vStat(filePath, "lstat");
  }
  return orig.lstatSync.call(this, filePath, options);
};

fs.accessSync = function (filePath: PathLike, mode?: number) {
  if (isVirtualPath(filePath)) return vAccess(filePath);
  return orig.accessSync.call(this, filePath, mode);
};

fs.unlinkSync = function (filePath: PathLike) {
  if (isVirtualPath(filePath)) return vUnlink(filePath);
  return orig.unlinkSync.call(this, filePath);
};

// ---------------------------------------------------------------------------
// Callback API
// ---------------------------------------------------------------------------

fs.writeFile = function (
  filePath: PathOrFileDescriptor,
  data: string | NodeJS.ArrayBufferView,
  options: WriteFileOptions | NoParamCallback,
  callback?: NoParamCallback,
) {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? undefined : options;
  if (isVirtualPath(filePath)) {
    return deliver(cb as ErrCallback | undefined, () => {
      vWrite(filePath, data, opts);
    });
  }
  return orig.writeFile.call(this, filePath, data, opts, cb);
};

fs.readFile = function (
  filePath: PathOrFileDescriptor,
  options: ReadFileOptions | ReadFileCallback,
  callback?: ReadFileCallback,
) {
  const cb = typeof options === "function" ? options : callback;
  const opts: ReadFileOptions | undefined = typeof options === "function" ? undefined : options;
  if (isVirtualPath(filePath)) {
    return deliver(cb as ErrCallback | undefined, () => vRead(filePath, opts));
  }
  return orig.readFile.call(this, filePath, opts, cb);
};

fs.rename = function (oldPath: PathLike, newPath: PathLike, callback: NoParamCallback) {
  if (isVirtualPath(oldPath) || isVirtualPath(newPath)) {
    return deliver(callback as ErrCallback, () => {
      vRename(oldPath, newPath);
    });
  }
  return orig.rename.call(this, oldPath, newPath, callback);
};

fs.unlink = function (filePath: PathLike, callback: NoParamCallback) {
  if (isVirtualPath(filePath)) {
    return deliver(callback as ErrCallback, () => {
      vUnlink(filePath);
    });
  }
  return orig.unlink.call(this, filePath, callback);
};

fs.stat = function (filePath: PathLike, ...rest: unknown[]) {
  if (isVirtualPath(filePath)) {
    const cb = rest.find((a) => typeof a === "function") as ErrCallback | undefined;
    return deliver(cb, () => vStat(filePath, "stat"));
  }
  return orig.stat.call(this, filePath, ...rest);
};

fs.lstat = function (filePath: PathLike, ...rest: unknown[]) {
  if (isVirtualPath(filePath)) {
    const cb = rest.find((a) => typeof a === "function") as ErrCallback | undefined;
    return deliver(cb, () => vStat(filePath, "lstat"));
  }
  return orig.lstat.call(this, filePath, ...rest);
};

fs.access = function (filePath: PathLike, ...rest: unknown[]) {
  if (isVirtualPath(filePath)) {
    const cb = rest.find((a) => typeof a === "function") as ErrCallback | undefined;
    return deliver(cb, () => {
      vAccess(filePath);
    });
  }
  return orig.access.call(this, filePath, ...rest);
};

// ---------------------------------------------------------------------------
// Promises API (fs.promises === require("fs/promises"))
// ---------------------------------------------------------------------------

promises.writeFile = async function (
  filePath: unknown,
  data: string | NodeJS.ArrayBufferView,
  options?: unknown,
) {
  if (isVirtualPath(filePath)) return vWrite(filePath, data, options);
  return origPromises.writeFile.call(this, filePath, data, options);
};

promises.readFile = async function (filePath: unknown, options?: unknown) {
  if (isVirtualPath(filePath)) return vRead(filePath, options);
  return origPromises.readFile.call(this, filePath, options);
};

promises.rename = async function (oldPath: unknown, newPath: unknown) {
  if (isVirtualPath(oldPath) || isVirtualPath(newPath)) return vRename(oldPath, newPath);
  return origPromises.rename.call(this, oldPath, newPath);
};

promises.unlink = async function (filePath: unknown) {
  if (isVirtualPath(filePath)) return vUnlink(filePath);
  return origPromises.unlink.call(this, filePath);
};

promises.stat = async function (filePath: unknown, options?: unknown) {
  if (isVirtualPath(filePath)) return vStat(filePath, "stat");
  return origPromises.stat.call(this, filePath, options);
};

promises.lstat = async function (filePath: unknown, options?: unknown) {
  if (isVirtualPath(filePath)) return vStat(filePath, "lstat");
  return origPromises.lstat.call(this, filePath, options);
};

promises.access = async function (filePath: unknown, mode?: unknown) {
  if (isVirtualPath(filePath)) return vAccess(filePath);
  return origPromises.access.call(this, filePath, mode);
};
