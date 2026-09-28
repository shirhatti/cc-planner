/**
 * Resolves on-disk resources the session runners need at runtime: the VFS
 * preload scripts (injected via BUN_OPTIONS, so they must be real files) and
 * the native Claude Code binary the SDK spawns.
 *
 * From a source checkout everything resolves relative to this file. In the
 * packaged desktop app (see electrobun.config.ts) the bun process is bundled
 * to a single file, which breaks import.meta-relative paths — the desktop
 * entrypoint sets CC_RESOURCES_ROOT to the bundle's Resources/app directory,
 * where build.copy placed copies of preload/ and the native claude binary.
 */

import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resourcesRoot(): string | undefined {
  return process.env.CC_RESOURCES_ROOT || undefined;
}

/** Absolute path of a VFS preload script (preload/<name>). */
export function preloadScript(name: string): string {
  const root = resourcesRoot();
  return root
    ? path.join(root, "preload", name)
    : path.join(__dirname, "..", "..", "preload", name);
}

/** Whether this Linux process runs against musl libc (e.g. Alpine). */
function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
  return !report?.header?.glibcVersionRuntime;
}

/** Name of the per-platform SDK package holding the native claude binary. */
export function nativePackageName(): string {
  const musl = isMusl() ? "-musl" : "";
  return `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl}`;
}

const BINARY_NAME = process.platform === "win32" ? "claude.exe" : "claude";

/** Directory of an installed package, hoisted or nested under the SDK. */
function resolvePackageDir(pkg: string): string | undefined {
  const here = createRequire(import.meta.url);
  const resolvers = [
    () => here,
    () => createRequire(here.resolve("@anthropic-ai/claude-agent-sdk")),
  ];
  for (const resolver of resolvers) {
    try {
      return path.dirname(resolver().resolve(`${pkg}/package.json`));
    } catch {
      // try the next location
    }
  }
  return undefined;
}

/**
 * Path to the native Claude Code binary (a Bun-compiled executable, so it
 * honors BUN_OPTIONS=--preload). The SDK installs it as a per-platform
 * optional dependency; the packaged app ships a copy under Resources/app.
 */
export function claudeExecutablePath(): string {
  const root = resourcesRoot();
  if (root) return path.join(root, "claude-native", BINARY_NAME);
  const pkg = nativePackageName();
  const dir = resolvePackageDir(pkg);
  if (!dir) {
    // Usually node_modules predates the SDK upgrade that introduced the
    // native binary (pulled new code without re-installing).
    const sdkDir = resolvePackageDir("@anthropic-ai/claude-agent-sdk");
    let installed = "not installed";
    try {
      if (sdkDir) {
        installed = (
          JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf-8")) as {
            version: string;
          }
        ).version;
      }
    } catch {
      // keep "not installed"
    }
    throw new Error(
      `Claude Code binary package ${pkg} is not installed (installed @anthropic-ai/claude-agent-sdk: ${installed}). ` +
        "Run `bun install` in the cc-planner checkout to install the SDK version in bun.lock, which includes the native binary for this platform.",
    );
  }
  const bin = path.join(dir, BINARY_NAME);
  if (!existsSync(bin)) throw new Error(`Claude Code binary not found at ${bin}`);
  return bin;
}
