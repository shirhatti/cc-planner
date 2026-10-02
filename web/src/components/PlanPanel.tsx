/**
 * Live-rendered plan markdown plus the plan-review bar shown when Claude
 * calls ExitPlanMode.
 */

import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sessionStore } from "../session-store";
import type { SessionRecord } from "../store";

function Review({ record }: { record: SessionRecord }) {
  const [feedback, setFeedback] = useState("");
  const review = record.pendingReview!;
  const decide = (approved: boolean) => sessionStore.decidePlan(record.id, approved, feedback);

  return (
    <div className="border-warn/50 bg-panel space-y-2 border-t p-4">
      <div className="font-medium">Claude is ready to finalize this plan.</div>
      {!record.plan.trim() && (
        <div className="text-muted text-xs">
          No plan content was provided for this review — Claude exited plan mode without writing a
          plan. Consider requesting changes and asking for a written plan.
        </div>
      )}
      {review.allowedPrompts?.length > 0 && (
        <div className="text-muted text-xs">
          Implementation would need permission to:{" "}
          {review.allowedPrompts.map((p) => p.prompt).join("; ")}
        </div>
      )}
      <textarea
        className="w-full"
        rows={2}
        placeholder="Optional: what should change? (used when requesting changes)"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary" onClick={() => decide(true)}>
          Approve plan
        </button>
        <button type="button" className="btn btn-bad" onClick={() => decide(false)}>
          Request changes
        </button>
      </div>
    </div>
  );
}

export function PlanPanel({ record }: { record: SessionRecord }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex items-baseline gap-2 border-b px-4 py-3">
        <h2 className="font-semibold">Plan</h2>
        {record.plan && <span className="text-muted truncate text-xs">{record.planFilename}</span>}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {record.plan ? (
          <article className="prose-cc">
            <Markdown remarkPlugins={[remarkGfm]}>{record.plan}</Markdown>
          </article>
        ) : (
          <div className="text-muted">The plan will stream here when Claude writes one.</div>
        )}
      </div>
      {/* Keyed so the feedback box resets for each review. */}
      {record.pendingReview && <Review key={record.pendingReview.id} record={record} />}
    </div>
  );
}
