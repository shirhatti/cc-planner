/**
 * Hydrating File System for Blob-less Clones
 *
 * Lets Claude Code work against a repo that was cloned with
 * `git clone --filter=blob:none --no-checkout` — commit and tree metadata
 * are local, but no file contents exist on disk.
 *
 * The directory listing is answered from git tree metadata (`git ls-tree`),
 * which is always available locally in a blob-less clone. File contents are
 * fetched on demand via the `gh` CLI (GitHub Contents API) the first time a
 * file is read, then written to disk so subsequent access — including from
 * subprocesses like ripgrep — hits the hydrated copy.
 *
 * Configuration (env vars):
 * - CC_HYDRATE_ROOT  (required) absolute path of the blob-less working tree.
 *                    If unset, this preload is inert.
 * - CC_HYDRATE_REPO  "owner/repo" on GitHub. Defaults to parsing the
 *                    `origin` remote URL.
 * - CC_HYDRATE_REF   commit-ish to hydrate from. Defaults to HEAD's sha.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Extract "owner/repo" from a GitHub remote URL (https, ssh, or scp-like). */
export function parseGitHubRepo(remoteUrl: string): string | null {
  const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Percent-encode each segment of a repo-relative path for the contents API. */
export function encodeApiPath(rel: string): string {
  return rel.split("/").map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------------------
// Installation (only when CC_HYDRATE_ROOT is configured)
// ---------------------------------------------------------------------------

if (process.env.CC_HYDRATE_ROOT) {
  install(process.env.CC_HYDRATE_ROOT);
}

function install(rootInput: string): void {
  const ROOT = path.resolve(rootInput);

  function git(args: string[]): string {
    const res = spawnSync("git", ["-C", ROOT, ...args], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`vfs-hydrate: git ${args.join(" ")} failed: ${res.stderr}`);
    }
    return res.stdout;
  }

  const REPO =
    process.env.CC_HYDRATE_REPO ??
    (() => {
      const repo = parseGitHubRepo(git(["remote", "get-url", "origin"]));
      if (!repo) {
        throw new Error(
          "vfs-hydrate: could not derive owner/repo from the origin remote; set CC_HYDRATE_REPO",
        );
      }
      return repo;
    })();
  const REF = process.env.CC_HYDRATE_REF ?? git(["rev-parse", "HEAD"]).trim();

  // -------------------------------------------------------------------------
  // Manifest: every file and directory in the tree at REF.
  // `git ls-tree` only needs tree objects, which blob-less clones have
  // locally — building the manifest never touches the network.
  // -------------------------------------------------------------------------

  const files = new Map<string, { mode: string }>();
  const dirs = new Set<string>([""]);
  const childrenByDir = new Map<string, Map<string, "file" | "dir">>();
  // Manifest files unlinked by the program; they must stop existing even
  // though they remain in the git tree.
  const deleted = new Set<string>();

  function addChild(dir: string, name: string, kind: "file" | "dir"): void {
    let children = childrenByDir.get(dir);
    if (!children) {
      children = new Map();
      childrenByDir.set(dir, children);
    }
    if (!children.has(name)) children.set(name, kind);
  }

  for (const entry of git(["ls-tree", "-r", "-z", REF]).split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type] = entry.slice(0, tab).split(" ");
    const rel = entry.slice(tab + 1);
    if (type !== "blob") continue; // skip submodules
    files.set(rel, { mode });

    let cur = rel;
    let kind: "file" | "dir" = "file";
    while (cur !== "") {
      const parent = path.posix.dirname(cur);
      const parentKey = parent === "." ? "" : parent;
      addChild(parentKey, path.posix.basename(cur), kind);
      if (parentKey !== "") dirs.add(parentKey);
      cur = parentKey;
      kind = "dir";
    }
  }

  function hasManifestFile(rel: string): boolean {
    return files.has(rel) && !deleted.has(rel);
  }

  // -------------------------------------------------------------------------
  // Originals and IPC
  // -------------------------------------------------------------------------

  const orig = {
    readFileSync: fs.readFileSync,
    readFile: fs.readFile,
    writeFileSync: fs.writeFileSync,
    writeFile: fs.writeFile,
    appendFileSync: fs.appendFileSync,
    appendFile: fs.appendFile,
    statSync: fs.statSync,
    lstatSync: fs.lstatSync,
    stat: fs.stat,
    lstat: fs.lstat,
    existsSync: fs.existsSync,
    accessSync: fs.accessSync,
    access: fs.access,
    openSync: fs.openSync,
    open: fs.open,
    readdirSync: fs.readdirSync,
    readdir: fs.readdir,
    realpathSync: fs.realpathSync,
    realpathSyncNative: fs.realpathSync.native,
    realpath: fs.realpath,
    unlinkSync: fs.unlinkSync,
    unlink: fs.unlink,
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
    copyFileSync: fs.copyFileSync,
    copyFile: fs.copyFile,
  };

  const promises = fs.promises;
  const origPromises = {
    readFile: promises.readFile,
    stat: promises.stat,
    lstat: promises.lstat,
    access: promises.access,
    open: promises.open,
    readdir: promises.readdir,
    realpath: promises.realpath,
    unlink: promises.unlink,
    appendFile: promises.appendFile,
    writeFile: promises.writeFile,
    copyFile: promises.copyFile,
  };

  function sendIpc(msg: Record<string, unknown>): void {
    if (process.send) {
      process.send({ ...msg, timestamp: Date.now() });
    }
  }

  // -------------------------------------------------------------------------
  // Hydration
  // -------------------------------------------------------------------------

  function hydrate(rel: string, abs: string): void {
    const entry = files.get(rel);
    if (!entry) return;

    const res = spawnSync(
      "gh",
      [
        "api",
        `repos/${REPO}/contents/${encodeApiPath(rel)}?ref=${REF}`,
        "-H",
        "Accept: application/vnd.github.raw+json",
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    );

    if (res.error) {
      sendIpc({ type: "hydrate_error", path: abs, rel, error: String(res.error) });
      throw new Error(`vfs-hydrate: failed to run gh for '${rel}': ${res.error}`);
    }
    if (res.status !== 0) {
      const stderr = (res.stderr?.toString("utf-8") ?? "").trim();
      sendIpc({ type: "hydrate_error", path: abs, rel, error: stderr });
      throw Object.assign(new Error(`vfs-hydrate: gh api fetch failed for '${rel}': ${stderr}`), {
        code: "EIO",
        path: abs,
      });
    }

    orig.mkdirSync.call(fs, path.dirname(abs), { recursive: true });
    orig.writeFileSync.call(fs, abs, res.stdout);
    if (entry.mode === "100755") {
      orig.chmodSync.call(fs, abs, 0o755);
    }

    sendIpc({ type: "hydrate_fetch", path: abs, rel, size: res.stdout.length });
  }

  /**
   * Map a path to its repo-relative form, or null when this preload should
   * not get involved (outside the root, inside .git, or not a string path).
   */
  function relUnderRoot(p: unknown): string | null {
    if (typeof p !== "string" || p.length === 0) return null;
    const resolved = path.resolve(p);
    if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null;
    const rel = path.relative(ROOT, resolved);
    if (rel === ".git" || rel.startsWith(".git" + path.sep)) return null;
    return rel;
  }

  /** Make a manifest path real on disk: fetch files, mkdir directories. */
  function ensureMaterialized(p: unknown): void {
    const rel = relUnderRoot(p);
    if (rel === null) return;
    const abs = path.join(ROOT, rel);
    if (orig.existsSync.call(fs, abs)) return;
    if (hasManifestFile(rel)) {
      hydrate(rel, abs);
    } else if (dirs.has(rel)) {
      orig.mkdirSync.call(fs, abs, { recursive: true });
    }
  }

  /** Create the parent directory on disk when the manifest says it exists. */
  function ensureParentDir(p: unknown): void {
    const rel = relUnderRoot(p);
    if (rel === null || rel === "") return;
    const parent = path.dirname(rel);
    const parentRel = parent === "." ? "" : parent;
    if (parentRel === "" || !dirs.has(parentRel)) return;
    const parentAbs = path.join(ROOT, parentRel);
    if (!orig.existsSync.call(fs, parentAbs)) {
      orig.mkdirSync.call(fs, parentAbs, { recursive: true });
    }
  }

  /** Whether open() flags require existing content (anything but truncate). */
  function flagsNeedContent(flags: unknown): boolean {
    return typeof flags !== "string" || !flags.includes("w");
  }

  // -------------------------------------------------------------------------
  // Generic wrappers: run an "ensure" step, then delegate to the original.
  // -------------------------------------------------------------------------

  type Ensure = (args: unknown[]) => void;

  const ensureRead: Ensure = (args) => ensureMaterialized(args[0]);
  const ensureWrite: Ensure = (args) => ensureParentDir(args[0]);
  const ensureAppend: Ensure = (args) => {
    ensureMaterialized(args[0]);
    ensureParentDir(args[0]);
  };
  const ensureOpen: Ensure = (args) => {
    if (flagsNeedContent(args[1])) ensureMaterialized(args[0]);
    ensureParentDir(args[0]);
  };
  // copyFile(src, dest): hydrate the source, materialize the dest's parent.
  const ensureCopy: Ensure = (args) => {
    ensureMaterialized(args[0]);
    ensureParentDir(args[1]);
  };

  type AnyFn = (...args: never[]) => unknown;

  function withEnsureSync<F extends AnyFn>(original: F, ensure: Ensure): F {
    return function (this: unknown, ...args: unknown[]) {
      ensure(args);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as F;
  }

  function withEnsureCallback<F extends AnyFn>(original: F, ensure: Ensure): F {
    return function (this: unknown, ...args: unknown[]) {
      const maybeCb = args[args.length - 1];
      try {
        ensure(args);
      } catch (err) {
        if (typeof maybeCb === "function") {
          process.nextTick(maybeCb as (e: unknown) => void, err);
          return;
        }
        throw err;
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as F;
  }

  function withEnsureAsync<F extends AnyFn>(original: F, ensure: Ensure): F {
    return async function (this: unknown, ...args: unknown[]) {
      ensure(args);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as F;
  }

  // -------------------------------------------------------------------------
  // Patch fs
  // -------------------------------------------------------------------------

  fs.readFileSync = withEnsureSync(orig.readFileSync, ensureRead);
  fs.statSync = withEnsureSync(orig.statSync, ensureRead);
  fs.lstatSync = withEnsureSync(orig.lstatSync, ensureRead);
  fs.accessSync = withEnsureSync(orig.accessSync, ensureRead);
  fs.openSync = withEnsureSync(orig.openSync, ensureOpen);
  fs.writeFileSync = withEnsureSync(orig.writeFileSync, ensureWrite);
  fs.appendFileSync = withEnsureSync(orig.appendFileSync, ensureAppend);
  fs.copyFileSync = withEnsureSync(orig.copyFileSync, ensureCopy);
  fs.realpathSync = Object.assign(withEnsureSync(orig.realpathSync, ensureRead), {
    native: withEnsureSync(orig.realpathSyncNative, ensureRead),
  });

  fs.readFile = withEnsureCallback(orig.readFile, ensureRead);
  fs.stat = withEnsureCallback(orig.stat, ensureRead);
  fs.lstat = withEnsureCallback(orig.lstat, ensureRead);
  fs.access = withEnsureCallback(orig.access, ensureRead);
  fs.open = withEnsureCallback(orig.open, ensureOpen);
  fs.writeFile = withEnsureCallback(orig.writeFile, ensureWrite);
  fs.appendFile = withEnsureCallback(orig.appendFile, ensureAppend);
  fs.copyFile = withEnsureCallback(orig.copyFile, ensureCopy);
  fs.realpath = Object.assign(withEnsureCallback(orig.realpath, ensureRead), {
    native: orig.realpath.native ? withEnsureCallback(orig.realpath.native, ensureRead) : undefined,
  });

  promises.readFile = withEnsureAsync(origPromises.readFile, ensureRead);
  promises.stat = withEnsureAsync(origPromises.stat, ensureRead);
  promises.lstat = withEnsureAsync(origPromises.lstat, ensureRead);
  promises.access = withEnsureAsync(origPromises.access, ensureRead);
  promises.open = withEnsureAsync(origPromises.open, ensureOpen);
  promises.realpath = withEnsureAsync(origPromises.realpath, ensureRead);
  promises.writeFile = withEnsureAsync(origPromises.writeFile, ensureWrite);
  promises.appendFile = withEnsureAsync(origPromises.appendFile, ensureAppend);
  promises.copyFile = withEnsureAsync(origPromises.copyFile, ensureCopy);

  // --- existsSync: answer from disk first, then the manifest ---

  fs.existsSync = function (p: unknown): boolean {
    if (orig.existsSync.call(this, p)) return true;
    const rel = relUnderRoot(p);
    return rel !== null && (hasManifestFile(rel) || dirs.has(rel));
  };

  // --- unlink: deleting an unhydrated manifest file is a tombstone ---

  /** Returns true when the delete was satisfied without touching disk. */
  function virtualUnlink(p: unknown): boolean {
    const rel = relUnderRoot(p);
    if (rel === null || !hasManifestFile(rel)) return false;
    deleted.add(rel);
    return !orig.existsSync.call(fs, path.join(ROOT, rel));
  }

  fs.unlinkSync = function (p: unknown) {
    if (virtualUnlink(p)) return;
    return orig.unlinkSync.call(this, p);
  };

  fs.unlink = function (p: unknown, callback: (err: unknown) => void) {
    if (virtualUnlink(p)) {
      process.nextTick(callback, null);
      return;
    }
    return orig.unlink.call(this, p, callback);
  };

  promises.unlink = async function (p: unknown) {
    if (virtualUnlink(p)) return;
    return origPromises.unlink.call(this, p);
  };

  // --- readdir: merge what's on disk with unhydrated manifest entries ---

  function normalizeReaddirOpts(options: unknown): {
    encoding: string;
    withFileTypes: boolean;
    recursive: boolean;
  } {
    if (typeof options === "string") {
      return { encoding: options, withFileTypes: false, recursive: false };
    }
    const o = (options ?? {}) as {
      encoding?: string;
      withFileTypes?: boolean;
      recursive?: boolean;
    };
    return {
      encoding: o.encoding ?? "utf8",
      withFileTypes: o.withFileTypes === true,
      recursive: o.recursive === true,
    };
  }

  /** Manifest entries under `rel`, as [name-relative-to-rel, kind] pairs. */
  function virtualEntries(rel: string, recursive: boolean): Array<[string, "file" | "dir"]> {
    if (!recursive) {
      const out: Array<[string, "file" | "dir"]> = [];
      for (const [name, kind] of childrenByDir.get(rel) ?? []) {
        const childRel = rel === "" ? name : `${rel}/${name}`;
        if (kind === "file" && deleted.has(childRel)) continue;
        out.push([name, kind]);
      }
      return out;
    }
    const prefix = rel === "" ? "" : rel + "/";
    const out: Array<[string, "file" | "dir"]> = [];
    for (const f of files.keys()) {
      if (deleted.has(f)) continue;
      if (prefix === "" || f.startsWith(prefix)) out.push([f.slice(prefix.length), "file"]);
    }
    for (const d of dirs) {
      if (d === "" || d === rel) continue;
      if (prefix === "" || d.startsWith(prefix)) out.push([d.slice(prefix.length), "dir"]);
    }
    return out;
  }

  /** Stable key for a disk readdir entry so manifest merging can dedupe. */
  function entryKey(e: unknown, dirAbs: string): string {
    if (typeof e === "string") return e;
    if (Buffer.isBuffer(e)) return e.toString("utf-8");
    const d = e as { name: string | Buffer; parentPath?: string };
    const name = typeof d.name === "string" ? d.name : d.name.toString("utf-8");
    if (d.parentPath && d.parentPath !== dirAbs) {
      return `${path.relative(dirAbs, d.parentPath)}/${name}`;
    }
    return name;
  }

  function makeDirent(dirAbs: string, name: string, kind: "file" | "dir") {
    const slash = name.lastIndexOf("/");
    const base = slash === -1 ? name : name.slice(slash + 1);
    const parentPath = slash === -1 ? dirAbs : path.join(dirAbs, name.slice(0, slash));
    return {
      name: base,
      parentPath,
      path: parentPath,
      isFile: () => kind === "file",
      isDirectory: () => kind === "dir",
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    };
  }

  fs.readdirSync = function (p: unknown, options?: unknown) {
    const rel = relUnderRoot(p);
    if (rel === null || !dirs.has(rel)) {
      return orig.readdirSync.call(this, p, options);
    }

    const abs = path.join(ROOT, rel);
    if (!orig.existsSync.call(fs, abs)) {
      orig.mkdirSync.call(fs, abs, { recursive: true });
    }

    const opts = normalizeReaddirOpts(options);
    const diskEntries: unknown[] = orig.readdirSync.call(fs, abs, options);
    const seen = new Set(diskEntries.map((e) => entryKey(e, abs)));
    const merged = diskEntries.slice();

    for (const [name, kind] of virtualEntries(rel, opts.recursive)) {
      if (seen.has(name)) continue;
      if (opts.withFileTypes) {
        merged.push(makeDirent(abs, name, kind));
      } else if (opts.encoding === "buffer") {
        merged.push(Buffer.from(name));
      } else {
        merged.push(name);
      }
    }
    return merged;
  };

  fs.readdir = function (p: unknown, options?: unknown, callback?: unknown) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? undefined : options;
    const rel = relUnderRoot(p);
    if (rel === null || !dirs.has(rel)) {
      return opts === undefined
        ? orig.readdir.call(this, p, cb)
        : orig.readdir.call(this, p, opts, cb);
    }
    try {
      const result = fs.readdirSync(p, opts);
      if (typeof cb === "function") process.nextTick(cb, null, result);
    } catch (err) {
      if (typeof cb === "function") process.nextTick(cb, err);
      else throw err;
    }
  };

  promises.readdir = async function (p: unknown, options?: unknown) {
    const rel = relUnderRoot(p);
    if (rel === null || !dirs.has(rel)) {
      return origPromises.readdir.call(this, p, options);
    }
    return fs.readdirSync(p, options);
  };

  // -------------------------------------------------------------------------

  sendIpc({
    type: "hydrate_init",
    mode: "hydrate",
    root: ROOT,
    repo: REPO,
    ref: REF,
    files: files.size,
  });
}
