/**
 * Workspace options for a draft session: the source (GitHub repo, a local
 * folder on the server's machine, or the server's baked repo) plus advanced
 * tool/system-prompt knobs. The first message typed in the composer starts
 * the session with these options. Sessions always run in plan mode and end
 * when the plan is approved.
 */

import { draftError, sessionStore, useAppState, type DraftOptions } from "../session-store";

export function StartForm({ id }: { id: string }) {
  const { config, drafts, connected } = useAppState();
  const options = drafts[id];
  if (!options) return null;

  const update = (patch: Partial<DraftOptions>) => sessionStore.updateDraft(id, patch);
  const field =
    (key: keyof DraftOptions) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      update({ [key]: e.target.value });
  const error = connected ? draftError(options) : "Not connected to the server";

  return (
    <div className="mx-auto mt-8 max-w-xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold">New planning session</h2>
        <p className="text-muted">
          Pick a workspace, then describe the change below. Claude explores the code in plan mode
          and ends with a plan for you to approve.
        </p>
      </div>
      <div className="border-border bg-panel space-y-3 rounded-lg border p-4">
        <select className="w-full" value={options.source} onChange={field("source")}>
          {config.mode === "baked" && (
            <option value="baked">Server repo ({config.repo ?? "baked"})</option>
          )}
          <option value="repo">GitHub repo</option>
          <option value="local">Local folder</option>
        </select>
        {options.source === "repo" && (
          <div className="flex gap-2">
            <input
              className="flex-2"
              placeholder="owner/repo"
              spellCheck={false}
              value={options.repo}
              onChange={field("repo")}
            />
            <input
              className="flex-1"
              placeholder="branch (optional)"
              spellCheck={false}
              value={options.branch}
              onChange={field("branch")}
            />
          </div>
        )}
        {options.source === "local" && (
          <input
            className="w-full"
            placeholder="/absolute/path/to/checkout or ~/code/repo"
            spellCheck={false}
            value={options.localPath}
            onChange={field("localPath")}
          />
        )}
        <details className="group">
          <summary className="text-muted hover:text-fg cursor-pointer text-xs">Advanced</summary>
          <div className="mt-3 space-y-3">
            <label className="block space-y-1">
              <span className="text-muted text-xs">
                Extra system prompt (appended to Claude Code's)
              </span>
              <textarea
                className="w-full"
                rows={2}
                placeholder="e.g. Always answer in French. Keep plans under 10 bullets."
                value={options.appendSystemPrompt}
                onChange={field("appendSystemPrompt")}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-muted text-xs">
                Always-allowed tools (comma-separated; Bash(...) patterns work)
              </span>
              <input
                className="w-full"
                placeholder="e.g. Bash(bun test:*), WebFetch"
                spellCheck={false}
                value={options.allowedTools}
                onChange={field("allowedTools")}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-muted text-xs">
                Disallowed tools (removed from the session)
              </span>
              <input
                className="w-full"
                placeholder="e.g. WebSearch, NotebookEdit"
                spellCheck={false}
                value={options.disallowedTools}
                onChange={field("disallowedTools")}
              />
            </label>
          </div>
        </details>
      </div>
      {error && <div className="text-warn text-xs">{error}</div>}
    </div>
  );
}
