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
 * subprocesses like ripgrep — hits the hydrated copy. Metadata calls
 * (stat/lstat/access/realpath) never hydrate: unhydrated files get
 * synthetic answers from the manifest. Async fs APIs fetch in a child
 * process without blocking the event loop.
 *
 * Configuration (env vars):
 * - CC_HYDRATE_ROOT     (required) absolute path of the blob-less working
 *                       tree. If unset, this preload is inert.
 * - CC_HYDRATE_REPO     "owner/repo" on GitHub. Defaults to parsing the
 *                       `origin` remote URL.
 * - CC_HYDRATE_REF      commit-ish to hydrate from. Defaults to HEAD's sha.
 * - CC_HYDRATE_STRATEGY "gh" (default) fetches via the GitHub contents API;
 *                       "git" lazily fetches blobs from the promisor remote
 *                       instead, for environments without a usable gh CLI.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

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
  // The same tree can be addressed through a symlinked prefix — on macOS
  // tmpdir() is /var/folders/..., which Claude Code realpaths to
  // /private/var/folders/... — so match paths under either spelling.
  const ROOT_ALIASES = [...new Set([ROOT, fs.realpathSync(ROOT) as string])];

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

  // "gh" fetches through the GitHub contents API; "git" lazily fetches blobs
  // from the promisor remote (works wherever the clone itself worked, e.g.
  // sandboxes that proxy git but block api.github.com).
  const STRATEGY: "gh" | "git" = process.env.CC_HYDRATE_STRATEGY === "git" ? "git" : "gh";

  const REPO =
    process.env.CC_HYDRATE_REPO ??
    (STRATEGY === "git"
      ? "" // not needed: git strategy addresses content by ref, not by repo
      : (() => {
          const repo = parseGitHubRepo(git(["remote", "get-url", "origin"]));
          if (!repo) {
            throw new Error(
              "vfs-hydrate: could not derive owner/repo from the origin remote; set CC_HYDRATE_REPO",
            );
          }
          return repo;
        })());
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
    realpathNative: fs.realpath.native,
    unlinkSync: fs.unlinkSync,
    unlink: fs.unlink,
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
    linkSync: fs.linkSync,
    utimesSync: fs.utimesSync,
    renameSync: fs.renameSync,
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
  // Path mapping and the on-disk cache
  // -------------------------------------------------------------------------

  /**
   * Map a path to its repo-relative form, or null when this preload should
   * not get involved (outside the root, inside .git, or not a string path).
   */
  function relUnderRoot(p: unknown): string | null {
    if (typeof p !== "string" || p.length === 0) return null;
    const resolved = path.resolve(p);
    const root = ROOT_ALIASES.find((r) => resolved === r || resolved.startsWith(r + path.sep));
    if (root === undefined) return null;
    const rel = path.relative(root, resolved);
    if (rel === ".git" || rel.startsWith(".git" + path.sep)) return null;
    return rel;
  }

  // Manifest paths known to exist on disk (hydrated, mkdir'd, or observed),
  // so repeat access skips the existsSync syscall. Entries are dropped when
  // this process unlinks the path. Removals made behind our back (a
  // subprocess `rm`, a rename away) leave a stale entry, which then surfaces
  // as a plain ENOENT from the real fs rather than a silent re-download.
  const onDisk = new Set<string>();

  function isManifestPath(rel: string): boolean {
    return hasManifestFile(rel) || dirs.has(rel);
  }

  /** Whether a manifest path is already on disk (cached, else one syscall). */
  function isOnDisk(rel: string): boolean {
    if (onDisk.has(rel)) return true;
    if (orig.existsSync.call(fs, path.join(ROOT, rel))) {
      onDisk.add(rel);
      return true;
    }
    return false;
  }

  function forgetOnDisk(p: unknown): void {
    const rel = relUnderRoot(p);
    if (rel !== null) onDisk.delete(rel);
  }

  // -------------------------------------------------------------------------
  // Hydration
  // -------------------------------------------------------------------------

  function fetchCommand(rel: string): [string, string[]] {
    if (STRATEGY === "git") {
      // Blob-less clones are promisor clones: cat-file on a missing blob
      // makes git fetch just that object from origin, reusing whatever
      // credentials/proxy the clone itself used.
      return ["git", ["-C", ROOT, "cat-file", "blob", `${REF}:${rel}`]];
    }
    return [
      "gh",
      [
        "api",
        `repos/${REPO}/contents/${encodeApiPath(rel)}?ref=${REF}`,
        "-H",
        "Accept: application/vnd.github.raw+json",
      ],
    ];
  }

  function spawnFailure(cmd: string, rel: string, abs: string, err: unknown): Error {
    sendIpc({ type: "hydrate_error", path: abs, rel, error: String(err) });
    return new Error(`vfs-hydrate: failed to run ${cmd} for '${rel}': ${err}`);
  }

  function fetchFailure(cmd: string, rel: string, abs: string, stderr: string): Error {
    sendIpc({ type: "hydrate_error", path: abs, rel, error: stderr });
    return Object.assign(new Error(`vfs-hydrate: ${cmd} fetch failed for '${rel}': ${stderr}`), {
      code: "EIO",
      path: abs,
    });
  }

  let tmpCounter = 0;
  const TMP_NAME = /^\..+\.vfs-hydrate-\d+-\d+$/;

  /**
   * Write fetched content to `abs` atomically: write a temp file in the same
   * directory, then hard-link it into place. link() fails with EEXIST instead
   * of clobbering, so a concurrent hydration of the same file or a write by
   * the program that landed while the fetch was in flight always wins, and
   * readers never observe partial content. Falls back to rename() on
   * filesystems without hard links. Uses sync fs calls on purpose: they are
   * local and fast, and keep the tombstone check and the publish in one tick.
   */
  function publish(rel: string, abs: string, data: Buffer, mode: string): void {
    if (deleted.has(rel)) return; // unlinked while the fetch was in flight
    const dir = path.dirname(abs);
    orig.mkdirSync.call(fs, dir, { recursive: true });
    tmpCounter += 1;
    const tmp = path.join(dir, `.${path.basename(abs)}.vfs-hydrate-${process.pid}-${tmpCounter}`);
    try {
      orig.writeFileSync.call(fs, tmp, data);
      if (mode === "100755") orig.chmodSync.call(fs, tmp, 0o755);
      // Keep mtime equal to the synthetic stat's (the commit time). Claude
      // Code records a file's mtime when it Reads it and refuses to Edit if
      // the mtime has since grown ("File has been modified since read");
      // Read stats before reading, so a download stamped "now" would trip it.
      const t = getRefTimeMs() / 1000;
      orig.utimesSync.call(fs, tmp, t, t);
      try {
        orig.linkSync.call(fs, tmp, abs);
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") {
          orig.renameSync.call(fs, tmp, abs);
        }
      }
    } finally {
      try {
        orig.unlinkSync.call(fs, tmp);
      } catch {
        // already renamed into place
      }
    }
    onDisk.add(rel);
  }

  function hydrateSync(rel: string, abs: string): void {
    const entry = files.get(rel);
    if (!entry) return;

    // A sync read can't wait on an in-flight async fetch of the same file;
    // it just fetches again. publish() makes the duplicate harmless.
    const [cmd, args] = fetchCommand(rel);
    const res = spawnSync(cmd, args, { maxBuffer: 256 * 1024 * 1024 });

    if (res.error) throw spawnFailure(cmd, rel, abs, res.error);
    if (res.status !== 0) {
      throw fetchFailure(cmd, rel, abs, (res.stderr?.toString("utf-8") ?? "").trim());
    }

    publish(rel, abs, res.stdout, entry.mode);
    sendIpc({ type: "hydrate_fetch", path: abs, rel, size: res.stdout.length });
  }

  // Async fetches in flight, so concurrent async reads of one file fetch once.
  const inFlight = new Map<string, Promise<void>>();

  function fetchAsync(rel: string, abs: string): Promise<Buffer> {
    const [cmd, args] = fetchCommand(rel);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", (e: unknown) => reject(spawnFailure(cmd, rel, abs, e)));
      child.on("close", (code: number | null) => {
        if (code === 0) resolve(Buffer.concat(out));
        else reject(fetchFailure(cmd, rel, abs, Buffer.concat(err).toString("utf-8").trim()));
      });
    });
  }

  function hydrateAsync(rel: string, abs: string): Promise<void> {
    const existing = inFlight.get(rel);
    if (existing) return existing;
    const entry = files.get(rel);
    if (!entry) return Promise.resolve();
    const pending = fetchAsync(rel, abs)
      .then((data) => {
        publish(rel, abs, data, entry.mode);
        sendIpc({ type: "hydrate_fetch", path: abs, rel, size: data.length });
      })
      .finally(() => inFlight.delete(rel));
    inFlight.set(rel, pending);
    return pending;
  }

  /** Make a manifest path real on disk: fetch files, mkdir directories. */
  function ensureMaterialized(p: unknown): void {
    const rel = relUnderRoot(p);
    if (rel === null || !isManifestPath(rel) || isOnDisk(rel)) return;
    const abs = path.join(ROOT, rel);
    if (hasManifestFile(rel)) {
      hydrateSync(rel, abs);
    } else {
      orig.mkdirSync.call(fs, abs, { recursive: true });
      onDisk.add(rel);
    }
  }

  /**
   * Async twin of ensureMaterialized: the network fetch runs in a child
   * process without blocking the event loop. Returns undefined when nothing
   * needs fetching, so callers can take a synchronous fast path.
   */
  function ensureMaterializedAsync(p: unknown): Promise<void> | undefined {
    const rel = relUnderRoot(p);
    if (rel === null || !isManifestPath(rel) || isOnDisk(rel)) return undefined;
    const abs = path.join(ROOT, rel);
    if (hasManifestFile(rel)) return hydrateAsync(rel, abs);
    orig.mkdirSync.call(fs, abs, { recursive: true });
    onDisk.add(rel);
    return undefined;
  }

  /** Create the parent directory on disk when the manifest says it exists. */
  function ensureParentDir(p: unknown): void {
    const rel = relUnderRoot(p);
    if (rel === null || rel === "") return;
    const parent = path.dirname(rel);
    const parentRel = parent === "." ? "" : parent;
    if (parentRel === "" || !dirs.has(parentRel) || isOnDisk(parentRel)) return;
    orig.mkdirSync.call(fs, path.join(ROOT, parentRel), { recursive: true });
    onDisk.add(parentRel);
  }

  /** Whether open() flags require existing content (anything but truncate). */
  function flagsNeedContent(flags: unknown): boolean {
    return typeof flags !== "string" || !flags.includes("w");
  }

  // -------------------------------------------------------------------------
  // Metadata without hydration: stat, lstat, access, realpath
  //
  // Claude Code's Glob stats every match to sort by mtime, so hydrating on
  // stat would download every file a broad glob touches. For a manifest file
  // that isn't on disk yet these answer from the manifest instead.
  // -------------------------------------------------------------------------

  // Synthetic mtime/ctime: the commit time of REF (commit objects are local
  // in a blob-less clone), computed once on first use.
  let refTimeMs: number | undefined;
  function getRefTimeMs(): number {
    if (refTimeMs === undefined) {
      try {
        refTimeMs = Number.parseInt(git(["show", "-s", "--format=%ct", REF]).trim(), 10) * 1000;
      } catch {
        refTimeMs = 0;
      }
      if (!Number.isFinite(refTimeMs)) refTimeMs = 0;
    }
    return refTimeMs;
  }

  // Blob sizes, when they can be learned without downloading blobs: the
  // gh strategy asks the GitHub trees API once for the whole tree. A size
  // that isn't known (git strategy, truncated tree, API failure) makes stat
  // fall back to hydrating — never report a wrong size: Claude Code rejects
  // a 0-byte PDF as empty without reading it.
  let blobSizes: Map<string, number> | undefined;
  function knownSize(rel: string): number | undefined {
    if (!blobSizes) {
      blobSizes = new Map();
      if (STRATEGY === "gh") {
        const res = spawnSync("gh", ["api", `repos/${REPO}/git/trees/${REF}?recursive=1`], {
          encoding: "utf-8",
          maxBuffer: 256 * 1024 * 1024,
        });
        if (!res.error && res.status === 0) {
          try {
            const body = JSON.parse(res.stdout) as {
              tree?: { path?: string; type?: string; size?: number }[];
            };
            for (const e of body.tree ?? []) {
              if (e.type === "blob" && typeof e.path === "string" && typeof e.size === "number") {
                blobSizes.set(e.path, e.size);
              }
            }
          } catch {
            // Unparseable response — every stat falls back to hydrating.
          }
        }
      }
    }
    return blobSizes.get(rel);
  }

  let rootDev: number | undefined;
  const syntheticInodes = new Map<string, number>();

  /**
   * A Stats object for an unhydrated manifest file.
   *
   * `size` must be the real blob size (see knownSize). mtime is the commit
   * time, which publish() also stamps on the hydrated file so stat answers
   * don't change across hydration. Symlinks (mode 120000) are reported as
   * regular files, matching how they are hydrated.
   */
  function syntheticFileStats(rel: string, size: number): unknown {
    rootDev ??= orig.statSync.call(fs, ROOT).dev as number;
    let ino = syntheticInodes.get(rel);
    if (ino === undefined) {
      ino = 2 ** 40 + syntheticInodes.size;
      syntheticInodes.set(rel, ino);
    }
    const perm = files.get(rel)?.mode === "100755" ? 0o755 : 0o644;
    const t = getRefTimeMs();
    const stats = Object.create(fs.Stats.prototype);
    const fields: Record<string, unknown> = {
      dev: rootDev,
      ino,
      mode: 0o100000 | perm,
      nlink: 1,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      rdev: 0,
      size,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      atimeMs: t,
      mtimeMs: t,
      ctimeMs: t,
      birthtimeMs: t,
      atime: new Date(t),
      mtime: new Date(t),
      ctime: new Date(t),
      birthtime: new Date(t),
    };
    // defineProperty (not assignment): Stats.prototype may define the date
    // fields as getter-only accessors.
    for (const [key, value] of Object.entries(fields)) {
      Object.defineProperty(stats, key, { value, writable: true, enumerable: true });
    }
    // Don't rely on prototype predicates reading internal slots.
    const kind = (mask: number) => () => (stats.mode & 0o170000) === mask;
    Object.assign(stats, {
      isFile: kind(0o100000),
      isDirectory: kind(0o040000),
      isSymbolicLink: kind(0o120000),
      isBlockDevice: kind(0o060000),
      isCharacterDevice: kind(0o020000),
      isFIFO: kind(0o010000),
      isSocket: kind(0o140000),
    });
    return stats;
  }

  /** Rel of a manifest file that is not on disk (and not tombstoned). */
  function unhydratedFile(p: unknown): string | null {
    const rel = relUnderRoot(p);
    if (rel === null || !hasManifestFile(rel) || isOnDisk(rel)) return null;
    return rel;
  }

  type Shortcut = (args: unknown[]) => { value: unknown } | { error: unknown } | null;

  const statShortcut: Shortcut = (args) => {
    const options = args[1] as { bigint?: boolean } | undefined;
    // BigInt stats are rare; those fall through to hydrate + real stat.
    if (options && typeof options === "object" && options.bigint) return null;
    const rel = unhydratedFile(args[0]);
    if (rel === null) return null;
    const size = knownSize(rel);
    // Unknown size: fall through to hydrate + real stat.
    return size === undefined ? null : { value: syntheticFileStats(rel, size) };
  };

  const accessShortcut: Shortcut = (args) => {
    const rel = unhydratedFile(args[0]);
    if (rel === null) return null;
    const mode = typeof args[1] === "number" ? args[1] : 0;
    if (mode & fs.constants.X_OK && files.get(rel)?.mode !== "100755") {
      return {
        error: Object.assign(new Error(`EACCES: permission denied, access '${args[0]}'`), {
          code: "EACCES",
          errno: -13,
          syscall: "access",
          path: args[0],
        }),
      };
    }
    return { value: undefined };
  };

  let realRoot: string | undefined;

  const realpathShortcut: Shortcut = (args) => {
    const rel = relUnderRoot(args[0]);
    if (rel === null || !isManifestPath(rel) || isOnDisk(rel)) return null;
    // Nothing under ROOT is on disk at this path, so no symlinks can sit
    // between ROOT and it: resolving ROOT itself is enough.
    realRoot ??= orig.realpathSync.call(fs, ROOT) as string;
    const resolved = path.join(realRoot, rel);
    const options = args[1];
    const encoding =
      typeof options === "string" ? options : (options as { encoding?: string })?.encoding;
    return { value: encoding === "buffer" ? Buffer.from(resolved) : resolved };
  };

  // -------------------------------------------------------------------------
  // Generic wrappers
  // -------------------------------------------------------------------------

  type Ensure = (args: unknown[]) => void;
  type EnsureAsync = (args: unknown[]) => Promise<void> | undefined;
  type AnyFn = (...args: never[]) => unknown;
  type LooseFn = (this: unknown, ...args: unknown[]) => unknown;

  const loose = (fn: AnyFn) => fn as unknown as LooseFn;

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

  const ensureReadAsync: EnsureAsync = (args) => ensureMaterializedAsync(args[0]);
  const ensureWriteAsync: EnsureAsync = (args) => {
    ensureParentDir(args[0]);
    return undefined;
  };
  const ensureAppendAsync: EnsureAsync = (args) => {
    const pending = ensureMaterializedAsync(args[0]);
    ensureParentDir(args[0]);
    return pending;
  };
  const ensureOpenAsync: EnsureAsync = (args) => {
    const pending = flagsNeedContent(args[1]) ? ensureMaterializedAsync(args[0]) : undefined;
    ensureParentDir(args[0]);
    return pending;
  };
  const ensureCopyAsync: EnsureAsync = (args) => {
    const pending = ensureMaterializedAsync(args[0]);
    ensureParentDir(args[1]);
    return pending;
  };

  function withEnsureSync<F extends AnyFn>(original: F, ensure: Ensure): F {
    const call = loose(original);
    return function (this: unknown, ...args: unknown[]) {
      ensure(args);
      return call.apply(this, args);
    } as unknown as F;
  }

  /**
   * Callback-style wrapper: hydrate asynchronously, then call the original
   * with the caller's callback; fetch errors go to the callback. When nothing
   * needs fetching the original is called synchronously, as before.
   */
  function withEnsureCallback<F extends AnyFn>(
    original: F,
    ensure: EnsureAsync,
    ensureSync: Ensure,
  ): F {
    const call = loose(original);
    return function (this: unknown, ...args: unknown[]) {
      const cb = args[args.length - 1];
      if (typeof cb !== "function") {
        // No callback: let the original raise its usual argument error.
        ensureSync(args);
        return call.apply(this, args);
      }
      let pending: Promise<void> | undefined;
      try {
        pending = ensure(args);
      } catch (err) {
        process.nextTick(cb, err);
        return;
      }
      if (!pending) return call.apply(this, args);
      pending.then(
        () => {
          try {
            call.apply(this, args);
          } catch (err) {
            cb(err);
          }
        },
        (err) => cb(err),
      );
    } as unknown as F;
  }

  function withEnsureAsync<F extends AnyFn>(original: F, ensure: EnsureAsync): F {
    const call = loose(original);
    return async function (this: unknown, ...args: unknown[]) {
      await ensure(args);
      return call.apply(this, args);
    } as unknown as F;
  }

  function withShortcutSync<F extends AnyFn>(fallback: F, shortcut: Shortcut): F {
    const call = loose(fallback);
    return function (this: unknown, ...args: unknown[]) {
      const r = shortcut(args);
      if (r) {
        if ("error" in r) throw r.error;
        return r.value;
      }
      return call.apply(this, args);
    } as unknown as F;
  }

  function withShortcutCallback<F extends AnyFn>(fallback: F, shortcut: Shortcut): F {
    const call = loose(fallback);
    return function (this: unknown, ...args: unknown[]) {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        const r = shortcut(args.slice(0, -1));
        if (r) {
          if ("error" in r) process.nextTick(cb, r.error);
          else process.nextTick(cb, null, r.value);
          return;
        }
      }
      return call.apply(this, args);
    } as unknown as F;
  }

  function withShortcutAsync<F extends AnyFn>(fallback: F, shortcut: Shortcut): F {
    const call = loose(fallback);
    return async function (this: unknown, ...args: unknown[]) {
      const r = shortcut(args);
      if (r) {
        if ("error" in r) throw r.error;
        return r.value;
      }
      return call.apply(this, args);
    } as unknown as F;
  }

  // -------------------------------------------------------------------------
  // Patch fs
  // -------------------------------------------------------------------------

  // Content reads hydrate.
  fs.readFileSync = withEnsureSync(orig.readFileSync, ensureRead);
  fs.openSync = withEnsureSync(orig.openSync, ensureOpen);
  fs.writeFileSync = withEnsureSync(orig.writeFileSync, ensureWrite);
  fs.appendFileSync = withEnsureSync(orig.appendFileSync, ensureAppend);
  fs.copyFileSync = withEnsureSync(orig.copyFileSync, ensureCopy);

  fs.readFile = withEnsureCallback(orig.readFile, ensureReadAsync, ensureRead);
  fs.open = withEnsureCallback(orig.open, ensureOpenAsync, ensureOpen);
  fs.writeFile = withEnsureCallback(orig.writeFile, ensureWriteAsync, ensureWrite);
  fs.appendFile = withEnsureCallback(orig.appendFile, ensureAppendAsync, ensureAppend);
  fs.copyFile = withEnsureCallback(orig.copyFile, ensureCopyAsync, ensureCopy);

  promises.readFile = withEnsureAsync(origPromises.readFile, ensureReadAsync);
  promises.open = withEnsureAsync(origPromises.open, ensureOpenAsync);
  promises.writeFile = withEnsureAsync(origPromises.writeFile, ensureWriteAsync);
  promises.appendFile = withEnsureAsync(origPromises.appendFile, ensureAppendAsync);
  promises.copyFile = withEnsureAsync(origPromises.copyFile, ensureCopyAsync);

  // Metadata answers from the manifest for unhydrated files; the fallback
  // (on-disk files, directories, bigint stats) keeps the old behavior.
  fs.statSync = withShortcutSync(withEnsureSync(orig.statSync, ensureRead), statShortcut);
  fs.lstatSync = withShortcutSync(withEnsureSync(orig.lstatSync, ensureRead), statShortcut);
  fs.accessSync = withShortcutSync(withEnsureSync(orig.accessSync, ensureRead), accessShortcut);
  fs.stat = withShortcutCallback(
    withEnsureCallback(orig.stat, ensureReadAsync, ensureRead),
    statShortcut,
  );
  fs.lstat = withShortcutCallback(
    withEnsureCallback(orig.lstat, ensureReadAsync, ensureRead),
    statShortcut,
  );
  fs.access = withShortcutCallback(
    withEnsureCallback(orig.access, ensureReadAsync, ensureRead),
    accessShortcut,
  );
  promises.stat = withShortcutAsync(
    withEnsureAsync(origPromises.stat, ensureReadAsync),
    statShortcut,
  );
  promises.lstat = withShortcutAsync(
    withEnsureAsync(origPromises.lstat, ensureReadAsync),
    statShortcut,
  );
  promises.access = withShortcutAsync(
    withEnsureAsync(origPromises.access, ensureReadAsync),
    accessShortcut,
  );

  // realpath never hydrates: a manifest path not on disk resolves under ROOT.
  fs.realpathSync = Object.assign(withShortcutSync(orig.realpathSync, realpathShortcut), {
    native: withShortcutSync(orig.realpathSyncNative, realpathShortcut),
  });
  fs.realpath = Object.assign(withShortcutCallback(orig.realpath, realpathShortcut), {
    native: orig.realpathNative
      ? withShortcutCallback(orig.realpathNative, realpathShortcut)
      : undefined,
  });
  promises.realpath = withShortcutAsync(origPromises.realpath, realpathShortcut);

  // --- existsSync: answer from disk first, then the manifest ---

  fs.existsSync = function (p: unknown): boolean {
    if (orig.existsSync.call(this, p)) return true;
    const rel = relUnderRoot(p);
    return rel !== null && isManifestPath(rel);
  };

  // --- unlink: deleting an unhydrated manifest file is a tombstone ---

  /** Returns true when the delete was satisfied without touching disk. */
  function virtualUnlink(p: unknown): boolean {
    forgetOnDisk(p);
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

  /**
   * Manifest entries under `rel`, as [name-relative-to-rel, kind] pairs.
   * Recursive listings walk the per-directory index from `rel`, so the cost
   * is proportional to the subtree rather than the whole repo.
   */
  function virtualEntries(rel: string, recursive: boolean): Array<[string, "file" | "dir"]> {
    const out: Array<[string, "file" | "dir"]> = [];
    const stack: Array<[string, string]> = [[rel, ""]];
    while (stack.length > 0) {
      const [dirRel, prefix] = stack.pop()!;
      for (const [name, kind] of childrenByDir.get(dirRel) ?? []) {
        const childRel = dirRel === "" ? name : `${dirRel}/${name}`;
        if (kind === "file" && deleted.has(childRel)) continue;
        const display = prefix === "" ? name : `${prefix}/${name}`;
        out.push([display, kind]);
        if (recursive && kind === "dir") stack.push([childRel, display]);
      }
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
    ensureMaterialized(abs);

    const opts = normalizeReaddirOpts(options);
    const diskEntries: unknown[] = orig.readdirSync.call(fs, abs, options);
    const merged: unknown[] = [];
    const seen = new Set<string>();
    for (const e of diskEntries) {
      const key = entryKey(e, abs);
      // Hide in-flight hydration temp files (see publish()).
      if (TMP_NAME.test(path.posix.basename(key))) continue;
      seen.add(key);
      merged.push(e);
    }

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
    strategy: STRATEGY,
    root: ROOT,
    repo: REPO,
    ref: REF,
    files: files.size,
  });
}
