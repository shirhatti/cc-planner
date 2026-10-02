/**
 * Message-part renderers for assistant messages: markdown text, the
 * server's tool activity, the interactive AskUserQuestion and permission
 * tool calls (answered through assistant-ui's addResult), and the
 * notice/error/hydration data parts.
 */

import {
  type DataMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { Check, ShieldQuestion, TriangleAlert, Wrench, X } from "lucide-react";
import { useState } from "react";
import remarkGfm from "remark-gfm";
import type { ActivityArgs, PermissionArgs, PermissionDecision, QuestionArgs } from "../feed";
import { Diff } from "./Diff";

export const MarkdownText: TextMessagePartComponent = () => (
  <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="prose-cc" />
);

function ToolLine({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="text-muted flex min-w-0 items-baseline gap-2 font-mono text-xs">
      <Wrench className="size-3 shrink-0 self-center" />
      <span className="text-accent-2 shrink-0">{name}</span>
      <span className="truncate" title={detail}>
        {detail}
      </span>
    </div>
  );
}

export const ToolActivity: ToolCallMessagePartComponent<ActivityArgs> = ({ args }) => (
  <div className="my-1">
    <ToolLine name={args.name} detail={args.detail} />
    {args.diff && <Diff diff={args.diff} />}
  </div>
);

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-accent/15 text-accent rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase">
      {children}
    </span>
  );
}

const cardClass = "border-border bg-panel my-2 rounded-lg border p-3";

/**
 * One AskUserQuestion tool call: 1-4 questions, each with options
 * (optionally multi-select) plus an "Other" free-text answer. The result is
 * the answers keyed by question text, matching the tool's expected input.
 */
export const QuestionCard: ToolCallMessagePartComponent<QuestionArgs, Record<string, string>> = ({
  args,
  result,
  addResult,
}) => {
  const answered = result !== undefined;
  const [selections, setSelections] = useState<string[][]>(() => args.questions.map(() => []));
  const [others, setOthers] = useState<string[]>(() => args.questions.map(() => ""));
  const [error, setError] = useState("");

  const toggle = (qi: number, label: string, multi?: boolean) => {
    if (answered) return;
    setSelections((prev) =>
      prev.map((picked, i) => {
        if (i !== qi) return picked;
        if (!multi) return [label];
        return picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label];
      }),
    );
  };

  const submit = () => {
    const answers: Record<string, string> = {};
    args.questions.forEach((q, qi) => {
      const picked = [...selections[qi]];
      if (others[qi].trim()) picked.push(others[qi].trim());
      if (picked.length) answers[q.question] = picked.join(", ");
    });
    if (Object.keys(answers).length < args.questions.length) {
      setError("Answer every question first");
      return;
    }
    addResult(answers);
  };

  return (
    <div className={cardClass}>
      {args.questions.map((q, qi) => (
        <div key={q.question} className="mb-3 space-y-1.5">
          <Chip>{q.header || "Question"}</Chip>
          <div className="font-medium">{q.question}</div>
          {q.options.map((opt) => {
            const selected = answered
              ? (result[q.question] ?? "").split(", ").includes(opt.label)
              : selections[qi].includes(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                disabled={answered}
                onClick={() => toggle(qi, opt.label, q.multiSelect)}
                className={`flex w-full flex-col items-start rounded-md border px-3 py-2 text-left transition-colors ${
                  selected
                    ? "border-accent bg-accent/10"
                    : "border-border hover:border-accent-2 disabled:hover:border-border"
                } disabled:cursor-default`}
              >
                <span>{opt.label}</span>
                {opt.description && <span className="text-muted text-xs">{opt.description}</span>}
              </button>
            );
          })}
          {!answered && (
            <input
              className="w-full"
              placeholder="Other (free text)"
              value={others[qi]}
              onChange={(e) =>
                setOthers((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))
              }
            />
          )}
        </div>
      ))}
      {answered ? (
        <div className="text-muted text-xs">Answered</div>
      ) : (
        <div className="flex items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={submit}>
            Submit answers
          </button>
          {error && <span className="text-warn text-xs">{error}</span>}
        </div>
      )}
    </div>
  );
};

/** A gated tool call (Bash, Edit, Write, ...) awaiting the user's decision. */
export const PermissionCard: ToolCallMessagePartComponent<PermissionArgs, PermissionDecision> = ({
  args,
  result,
  addResult,
}) => (
  <div className={cardClass}>
    <div className="mb-2 flex items-center gap-2">
      <ShieldQuestion className="text-warn size-4" />
      <Chip>Permission</Chip>
    </div>
    <ToolLine name={args.toolName} detail={args.detail} />
    {args.diff && <Diff diff={args.diff} />}
    {result ? (
      <div className="text-muted mt-2 text-xs">
        {result.allow ? (result.always ? "Always allowed" : "Allowed") : "Denied"}
      </div>
    ) : (
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-good" onClick={() => addResult({ allow: true })}>
          <Check className="size-4" /> Allow
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => addResult({ allow: true, always: true })}
        >
          Always allow
        </button>
        <button type="button" className="btn btn-bad" onClick={() => addResult({ allow: false })}>
          <X className="size-4" /> Deny
        </button>
      </div>
    )}
  </div>
);

export const NoticePart: DataMessagePartComponent<{ text: string }> = ({ data }) => (
  <div className="text-muted my-1 text-xs italic">{data.text}</div>
);

export const ErrorPart: DataMessagePartComponent<{ text: string }> = ({ data }) => (
  <div className="border-bad/40 bg-bad/10 text-bad my-2 flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
    <span className="whitespace-pre-wrap">{data.text}</span>
  </div>
);

export const HydratePart: DataMessagePartComponent<{ count: number; latest: string }> = ({
  data,
}) => (
  <div className="text-muted my-1 text-xs italic">
    Hydrated {data.count} file{data.count === 1 ? "" : "s"} (latest: {data.latest})
  </div>
);
