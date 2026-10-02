/**
 * Renders a file change with @pierre/diffs (Shiki-highlighted unified
 * diff). Used for Edit/Write tool activity and inside permission cards so
 * changes can be reviewed before they're allowed.
 */

import type { FileDiffOptions } from "@pierre/diffs";
import { MultiFileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { DiffPayload } from "../../lib/protocol";

const OPTIONS: FileDiffOptions<undefined> = {
  diffStyle: "unified",
  themeType: "dark",
  lineDiffType: "word",
};

export function Diff({ diff }: { diff: DiffPayload }) {
  const [oldFile, newFile] = useMemo(() => {
    const name = diff.filePath.split("/").pop() || diff.filePath;
    return [
      { name, contents: diff.oldText },
      { name, contents: diff.newText },
    ];
  }, [diff]);

  return (
    <MultiFileDiff
      oldFile={oldFile}
      newFile={newFile}
      options={OPTIONS}
      className="border-border my-1 block overflow-hidden rounded-md border"
    />
  );
}
