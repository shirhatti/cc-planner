/**
 * <cc-diff> — renders a file change with @pierre/diffs (Shiki-highlighted
 * unified diff). Used for Edit/Write tool activity and inside permission
 * cards so changes can be reviewed before they're allowed.
 */

import { FileDiff } from "@pierre/diffs";
import type { DiffPayload } from "../../lib/protocol";

export class CcDiff extends HTMLElement {
  show(diff: DiffPayload): void {
    const name = diff.filePath.split("/").pop() || diff.filePath;
    const fileDiff = new FileDiff({
      diffStyle: "unified",
      themeType: "dark",
      lineDiffType: "word",
    });
    fileDiff.render({
      oldFile: { name, contents: diff.oldText },
      newFile: { name, contents: diff.newText },
      fileContainer: this,
    });
  }
}

customElements.define("cc-diff", CcDiff);

declare global {
  interface HTMLElementTagNameMap {
    "cc-diff": CcDiff;
  }
}
