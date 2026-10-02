/**
 * Sidebar list of sessions (live and restored from localStorage), built on
 * assistant-ui's thread-list primitives. Each thread's `custom` data carries
 * the session's status and repo (see threadListAdapter in App).
 */

import { ThreadListItemPrimitive, ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { Plus, X } from "lucide-react";
import type { SessionStatus } from "../store";

const STATUS_LABELS: Record<SessionStatus, string> = {
  draft: "draft",
  starting: "starting",
  running: "running",
  idle: "awaiting message",
  "awaiting-input": "needs input",
  reviewing: "review plan",
  approved: "approved",
  done: "done",
  stopped: "stopped",
  error: "error",
};

const STATUS_DOT: Record<SessionStatus, string> = {
  draft: "bg-muted/40",
  starting: "bg-accent-2",
  running: "bg-accent-2 animate-pulse",
  idle: "bg-good/60",
  "awaiting-input": "bg-warn",
  reviewing: "bg-warn",
  approved: "bg-good",
  done: "bg-good",
  stopped: "bg-muted",
  error: "bg-bad",
};

export interface SessionListCustom {
  status: SessionStatus;
  repo: string;
  createdAt: number;
}

function SessionListItem() {
  const custom = useAuiState((s) => s.threadListItem.custom) as SessionListCustom | undefined;
  const status = custom?.status ?? "draft";
  return (
    <ThreadListItemPrimitive.Root className="group hover:bg-panel data-active:bg-panel-2 data-active:border-border relative rounded-md border border-transparent">
      <ThreadListItemPrimitive.Trigger className="block w-full cursor-pointer px-3 py-2 text-left">
        <div className="flex items-center gap-2 pr-5">
          <span
            className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`}
            title={STATUS_LABELS[status]}
          />
          <span className="text-accent-2 truncate font-mono text-xs">
            {custom?.repo || "(no repo)"}
          </span>
        </div>
        <div className="mt-0.5 line-clamp-2 text-sm">
          <ThreadListItemPrimitive.Title fallback="New session" />
        </div>
        <div className="text-muted mt-0.5 text-[11px]">
          {STATUS_LABELS[status]}
          {custom && ` · ${new Date(custom.createdAt).toLocaleString()}`}
        </div>
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemPrimitive.Delete
        className="text-muted hover:text-bad absolute top-2 right-2 hidden cursor-pointer group-hover:block"
        title="Delete session"
      >
        <X className="size-4" />
      </ThreadListItemPrimitive.Delete>
    </ThreadListItemPrimitive.Root>
  );
}

export function SessionList() {
  return (
    <ThreadListPrimitive.Root className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <ThreadListPrimitive.New className="btn w-full justify-center">
        <Plus className="size-4" /> New session
      </ThreadListPrimitive.New>
      <div className="-mx-1 flex-1 space-y-1 overflow-y-auto px-1">
        <ThreadListPrimitive.Items components={{ ThreadListItem: SessionListItem }} />
      </div>
    </ThreadListPrimitive.Root>
  );
}
