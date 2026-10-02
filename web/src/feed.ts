/**
 * A session's transcript as an append-only list of feed items, and its
 * conversion into assistant-ui thread messages.
 *
 * Every user message starts a new user turn; everything the server emits
 * between two user messages (assistant text, tool activity, questions,
 * permission prompts, notices) becomes the parts of one assistant message,
 * in arrival order.
 */

import type { ThreadMessageLike } from "@assistant-ui/react";
import type { DiffPayload, UserQuestion } from "../lib/protocol";

export type FeedItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; detail: string; diff?: DiffPayload }
  | {
      kind: "question";
      /** The AskUserQuestion tool_use id. */
      id: string;
      questions: UserQuestion[];
      answers?: Record<string, string>;
    }
  | {
      kind: "permission";
      /** The permission request id. */
      id: string;
      toolName: string;
      detail: string;
      diff?: DiffPayload;
      decision?: PermissionDecision;
    }
  | { kind: "info"; id: string; text: string }
  | { kind: "error"; id: string; text: string }
  | { kind: "hydrate"; id: string; count: number; latest: string };

export interface PermissionDecision {
  allow: boolean;
  always?: boolean;
}

/** Tool names of the interactive tool-call parts (rendered by tool UIs). */
export const QUESTION_TOOL = "AskUserQuestion";
export const PERMISSION_TOOL = "cc-permission";
/** Non-interactive tool activity reported by the server. */
export const ACTIVITY_TOOL = "cc-activity";

export interface ActivityArgs {
  name: string;
  detail: string;
  diff?: DiffPayload;
}

export interface QuestionArgs {
  questions: UserQuestion[];
}

export interface PermissionArgs {
  toolName: string;
  detail: string;
  diff?: DiffPayload;
}

type Part = Exclude<ThreadMessageLike["content"], string>[number];

/**
 * Tool args and results must be JSON objects; our payloads are plain JSON
 * but typed as interfaces, so cast at this one boundary.
 */
function json<T>(value: T): never {
  return value as never;
}

function toPart(item: Exclude<FeedItem, { kind: "user" }>): Part {
  switch (item.kind) {
    case "text":
      return { type: "text", text: item.text };
    case "tool":
      return {
        type: "tool-call",
        toolCallId: item.id,
        toolName: ACTIVITY_TOOL,
        args: json<ActivityArgs>({ name: item.name, detail: item.detail, diff: item.diff }),
        result: "",
      };
    case "question":
      return {
        type: "tool-call",
        toolCallId: item.id,
        toolName: QUESTION_TOOL,
        args: json<QuestionArgs>({ questions: item.questions }),
        result: item.answers,
      };
    case "permission":
      return {
        type: "tool-call",
        toolCallId: item.id,
        toolName: PERMISSION_TOOL,
        args: json<PermissionArgs>({
          toolName: item.toolName,
          detail: item.detail,
          diff: item.diff,
        }),
        result: item.decision,
      };
    case "info":
      return { type: "data-notice", data: { text: item.text } };
    case "error":
      return { type: "data-error", data: { text: item.text } };
    case "hydrate":
      return { type: "data-hydrate", data: { count: item.count, latest: item.latest } };
  }
}

/** Group a feed into alternating user/assistant thread messages. */
export function toThreadMessages(feed: readonly FeedItem[]): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [];
  let parts: Part[] | null = null;
  for (const item of feed) {
    if (item.kind === "user") {
      parts = null;
      messages.push({ id: item.id, role: "user", content: [{ type: "text", text: item.text }] });
      continue;
    }
    if (!parts) {
      parts = [];
      messages.push({ id: item.id, role: "assistant", content: parts });
    }
    parts.push(toPart(item));
  }
  return messages;
}
