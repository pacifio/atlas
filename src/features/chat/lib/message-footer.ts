// Which actions a message's hover footer offers, and where each one sits.
//
// Pure so the action set per message kind can be tested without rendering a
// row; `user-row-actions.tsx` and `prose-row-actions.tsx` render exactly what
// this returns, in this order.
//
// The footer keeps the frequent actions inline as icons and puts the rare ones
// behind a "…" menu. What decides the split:
//
//  - Copy is inline everywhere. Retry is inline because it only ever appears
//    on the latest prompt, which is where it is wanted. Branch is inline for
//    the same reason: it only ever appears on the latest response.
//  - Pin is inline everywhere, as ONE toggle whose state never moves it: dim
//    unpinned, lit pinned, `aria-pressed` either way. It used to live in the
//    menu and jump inline once pinned, which unmounted the item being
//    activated (and, on a response, the whole menu with it) and dropped
//    keyboard focus to `<body>`. A control that changes place when pressed
//    cannot keep focus.
//  - "Edit and send as new message" goes in the menu. A response has nothing
//    rare left, so it has no menu at all.
//
// The comment button is not listed: it shares a surround with copy and appears
// only when the message has a cloud anchor (`CommentAndCopy`), which is a
// store fact the row resolves itself.

import { RowKind, type Row } from "./turn-rows";

export type MessageAction = "retry" | "copy" | "branch" | "pin" | "edit";

export interface MessageFooterActions {
  /** Icon buttons, in render order. */
  inline: MessageAction[];
  /** The "…" menu's items, in order. Empty means no menu button at all. */
  overflow: MessageAction[];
}

export function userFooterActions({
  canRetry,
}: {
  /** The session's last prompt on an agent that can rewind (`retry-gate.ts`). */
  canRetry: boolean;
}): MessageFooterActions {
  return {
    inline: canRetry ? ["retry", "pin", "copy"] : ["pin", "copy"],
    overflow: ["edit"],
  };
}

export function responseFooterActions({
  canBranch,
}: {
  /** The session's latest settled response, on an agent that advertised
   *  `fork`, with no turn running. Forking copies the session as it stands,
   *  so the latest response is the only row "branch from here" is true of. */
  canBranch: boolean;
}): MessageFooterActions {
  return { inline: canBranch ? ["copy", "branch", "pin"] : ["copy", "pin"], overflow: [] };
}

/**
 * The id of the session's latest settled response, which is the only prose row
 * that may offer "Branch from here". `undefined` when the last prompt has no
 * settled answer yet: a branch taken then would carry the unanswered prompt,
 * and the response above it is not "here" any more. Walks back from the end
 * and stops at the first prompt, so it touches only the last exchange.
 */
export function latestResponseRowId(rows: readonly Row[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === RowKind.User || row.kind === RowKind.Injected) return undefined;
    if (row.kind === RowKind.Prose) return row.streaming ? undefined : row.id;
  }
  return undefined;
}
