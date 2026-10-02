/**
 * Root component: wires the session store into an assistant-ui external
 * store runtime (messages, composer, tool results, thread list) and lays out
 * the sidebar, thread, and plan/stats column.
 */

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreThreadData,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useMemo } from "react";
import { PERMISSION_TOOL, QUESTION_TOOL, toThreadMessages, type PermissionDecision } from "../feed";
import { draftError, isFinished, sessionStore, useAppState } from "../session-store";
import { PlanPanel } from "./PlanPanel";
import { SessionList, type SessionListCustom } from "./SessionList";
import { SettingsPanel } from "./SettingsPanel";
import { StatsPanel } from "./StatsPanel";
import { Thread } from "./Thread";

function messageText(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

export function App() {
  const state = useAppState();
  const { records, activeId, feeds, drafts, connected, config } = state;
  const record = records.find((r) => r.id === activeId) ?? records[0];
  const feed = feeds[record.id];
  const messages = useMemo(() => toThreadMessages(feed ?? []), [feed]);

  const draft = record.status === "draft";
  const live = Boolean(feed) && !isFinished(record.status);
  const draftOptions = drafts[record.id];

  const threads = useMemo(
    () =>
      records.map(
        (r): ExternalStoreThreadData<"regular"> => ({
          status: "regular",
          id: r.id,
          title: r.prompt || undefined,
          custom: {
            status: r.status,
            repo: r.repo,
            createdAt: r.createdAt,
          } satisfies SessionListCustom,
        }),
      ),
    [records],
  );

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    isRunning: record.status === "starting" || record.status === "running",
    isDisabled: !draft && !live,
    isSendDisabled: draft && (!connected || !draftOptions || draftError(draftOptions) !== null),
    onNew: async (message) => {
      const text = messageText(message);
      if (text) sessionStore.sendUserMessage(text);
    },
    onCancel: async () => sessionStore.interrupt(),
    onAddToolResult: ({ toolCallId, toolName, result }) => {
      if (toolName === QUESTION_TOOL) {
        sessionStore.answerQuestion(
          record.id,
          toolCallId,
          result as unknown as Record<string, string>,
        );
      } else if (toolName === PERMISSION_TOOL) {
        sessionStore.decidePermission(
          record.id,
          toolCallId,
          result as unknown as PermissionDecision,
        );
      }
    },
    adapters: {
      threadList: {
        threadId: record.id,
        threads,
        onSwitchToNewThread: () => sessionStore.newDraft(),
        onSwitchToThread: (id) => sessionStore.setActive(id),
        onDelete: (id) => sessionStore.deleteSession(id),
      },
    },
  });

  const badge = !connected
    ? "connecting…"
    : config.mode === "baked"
      ? `baked: ${config.repo}${config.ref ? " @ " + config.ref.slice(0, 8) : ""}`
      : "lazy hydration";

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full flex-col">
        <header className="border-border flex items-center gap-3 border-b px-4 py-2.5">
          <h1 className="font-semibold">claude · web tty</h1>
          <span className="bg-panel-2 border-border text-accent-2 rounded-full border px-2.5 py-0.5 text-xs">
            {badge}
          </span>
          {!draft && (
            <span className="text-muted min-w-0 truncate text-xs">
              {record.repo}
              {record.ref && ` @ ${record.ref.slice(0, 8)}`} · plan mode · {record.status}
            </span>
          )}
        </header>
        <div className="flex min-h-0 flex-1">
          <aside className="border-border flex w-72 shrink-0 flex-col border-r">
            <SessionList />
            <SettingsPanel />
          </aside>
          <main className="min-w-0 flex-1">
            <Thread record={record} />
          </main>
          <section className="border-border flex w-[28rem] shrink-0 flex-col border-l max-lg:hidden">
            <PlanPanel record={record} />
            <StatsPanel record={record} />
          </section>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
