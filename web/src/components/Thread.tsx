/**
 * The chat thread for the active session, built from assistant-ui
 * primitives: messages, the composer (which also starts a draft session),
 * and the draft's workspace form in the empty state.
 */

import { AuiIf, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { ArrowDown, ArrowUp, Square } from "lucide-react";
import { ACTIVITY_TOOL, PERMISSION_TOOL, QUESTION_TOOL } from "../feed";
import { isFinished, sessionStore, useAppState } from "../session-store";
import type { SessionRecord } from "../store";
import {
  ErrorPart,
  HydratePart,
  MarkdownText,
  NoticePart,
  PermissionCard,
  QuestionCard,
  ToolActivity,
} from "./parts";
import { StartForm } from "./StartForm";

function UserMessage() {
  return (
    <MessagePrimitive.Root className="my-4 flex justify-end">
      <div className="bg-panel-2 border-border max-w-[85%] rounded-2xl border px-4 py-2 whitespace-pre-wrap">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="my-4">
      <MessagePrimitive.Parts
        components={{
          Text: MarkdownText,
          tools: {
            by_name: {
              [ACTIVITY_TOOL]: ToolActivity,
              [QUESTION_TOOL]: QuestionCard,
              [PERMISSION_TOOL]: PermissionCard,
            },
          },
          data: { by_name: { notice: NoticePart, error: ErrorPart, hydrate: HydratePart } },
        }}
      />
    </MessagePrimitive.Root>
  );
}

function EmptyState({ record }: { record: SessionRecord }) {
  if (record.status === "draft") return <StartForm id={record.id} />;
  return (
    <div className="text-muted mx-auto mt-16 max-w-md text-center">
      Transcript not available — session restored from local storage.
    </div>
  );
}

function Composer({ record }: { record: SessionRecord }) {
  const { feeds } = useAppState();
  const draft = record.status === "draft";
  const live = Boolean(feeds[record.id]) && !isFinished(record.status);
  if (!draft && !live) return null;

  return (
    <div className="space-y-2">
      <ComposerPrimitive.Root className="border-border bg-panel focus-within:border-accent-2 flex items-end gap-2 rounded-2xl border p-2">
        <ComposerPrimitive.Input
          autoFocus
          rows={1}
          maxRows={10}
          placeholder={
            draft
              ? "What should Claude plan? This starts the session — you can keep chatting after."
              : "Message Claude… (Enter to send, Shift+Enter for newline)"
          }
          className="max-h-60 flex-1 resize-none border-none bg-transparent px-2 py-1.5 focus:border-none"
        />
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel
            className="btn size-9 justify-center rounded-full p-0"
            title="Interrupt the current turn"
          >
            <Square className="size-3.5 fill-current" />
          </ComposerPrimitive.Cancel>
        </AuiIf>
        <ComposerPrimitive.Send
          className="btn btn-primary size-9 justify-center rounded-full p-0"
          title="Send"
        >
          <ArrowUp className="size-4" />
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
      {live && (
        <div className="flex justify-end">
          <button
            type="button"
            className="text-muted hover:text-fg text-xs"
            title="Close input; Claude finishes and exits"
            onClick={() => sessionStore.endSession()}
          >
            End session
          </button>
        </div>
      )}
    </div>
  );
}

export function Thread({ record }: { record: SessionRecord }) {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col overflow-y-auto px-4">
        <div className="mx-auto w-full max-w-3xl flex-1 pt-4">
          <ThreadPrimitive.Empty>
            <EmptyState record={record} />
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </div>
        <ThreadPrimitive.ViewportFooter className="bg-bg sticky bottom-0 mx-auto w-full max-w-3xl pt-2 pb-4">
          <ThreadPrimitive.ScrollToBottom className="btn absolute -top-10 left-1/2 size-8 -translate-x-1/2 justify-center rounded-full p-0 disabled:invisible">
            <ArrowDown className="size-4" />
          </ThreadPrimitive.ScrollToBottom>
          <Composer record={record} />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
