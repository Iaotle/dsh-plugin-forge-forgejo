/** Unified patches of commit ranges, which Forgejo's API lists as changed files only and the web page gives only to a signed-in browser. */

import { structuredPatch } from 'diff'

/**
 * Compare two texts as the `---`, `+++`, and hunk lines of a patch with three lines of context.
 * @param oldName - old side's name, such as `a/<path>` or `/dev/null`.
 * @param newName - new side's name.
 * @param before - old text.
 * @param after - new text.
 * @returns the patch lines, ending with a newline.
 */
export function textPatch(oldName: string, newName: string, before: string, after: string): string {
  const patch = structuredPatch(oldName, newName, before, after, '', '', { context: 3 })
  // Git numbers an empty side from the line before it, so an added or deleted file's empty side starts at 0.
  const start = (line: number, count: number): number => count === 0 ? line - 1 : line
  const hunks = patch.hunks.map(hunk =>
    `@@ -${start(hunk.oldStart, hunk.oldLines)},${hunk.oldLines} +${start(hunk.newStart, hunk.newLines)},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`)
  return `--- ${oldName}\n+++ ${newName}\n${hunks.join('')}`
}

/**
 * Whether a commit object name is complete: 40 hexadecimal characters, or 64 for SHA-256 repositories.
 * @param value - candidate name.
 * @returns whether it names a full commit.
 */
export function isCommit(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
}
