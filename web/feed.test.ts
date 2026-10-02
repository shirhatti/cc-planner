import { describe, expect, test } from "bun:test";
import { PERMISSION_TOOL, QUESTION_TOOL, toThreadMessages, type FeedItem } from "./src/feed";

describe("toThreadMessages", () => {
  test("groups everything between user messages into one assistant message", () => {
    const feed: FeedItem[] = [
      { kind: "user", id: "u1", text: "plan it" },
      { kind: "info", id: "i1", text: "Workspace ready" },
      { kind: "text", id: "t1", text: "Looking around" },
      { kind: "tool", id: "tool1", name: "Read", detail: "src/a.ts" },
      { kind: "user", id: "u2", text: "more" },
      { kind: "text", id: "t2", text: "Done" },
    ];
    const messages = toThreadMessages(feed);
    expect(messages.map((m) => [m.id, m.role])).toEqual([
      ["u1", "user"],
      ["i1", "assistant"],
      ["u2", "user"],
      ["t2", "assistant"],
    ]);
    expect(messages[1].content).toHaveLength(3);
    expect((messages[1].content as readonly { type: string }[]).map((p) => p.type)).toEqual([
      "data-notice",
      "text",
      "tool-call",
    ]);
  });

  test("interactive tool calls carry their answer as the result", () => {
    const feed: FeedItem[] = [
      {
        kind: "question",
        id: "q1",
        questions: [{ question: "Which?", header: "Pick", options: [] }],
        answers: { "Which?": "A" },
      },
      { kind: "permission", id: "p1", toolName: "Bash", detail: "ls" },
    ];
    const [message] = toThreadMessages(feed);
    expect(message.content).toMatchObject([
      { type: "tool-call", toolCallId: "q1", toolName: QUESTION_TOOL, result: { "Which?": "A" } },
      { type: "tool-call", toolCallId: "p1", toolName: PERMISSION_TOOL, result: undefined },
    ]);
  });
});
