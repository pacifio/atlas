import { useCallback, useEffect, useRef, useState } from "react";

import type { OpenSession } from "../stores/artifacts-store";
import type { BoardSession, SessionDetail as Detail } from "../types";
import { sessionState } from "./board";
import { boardKey } from "./board-key";
import { readCachedDetail, writeCachedDetail } from "./detail-cache";
import { readSessionDetail } from "./read-session-detail";

/**
 * Is this re-read structurally the same Session we already have?
 *
 * Deliberately a *signature*, not a deep compare: the point is to avoid touching
 * a megabyte of objects, so walking them to decide would defeat itself. The
 * three fields below move whenever a Session gains anything — a message, a tool
 * call, a Checkpoint — which is the only way its timeline can change.
 */
function sameDetail(a: Detail | null | undefined, b: Detail | null): boolean {
  if (!a || !b) return false;
  return (
    a.summary.id === b.summary.id &&
    a.summary.updatedAt === b.summary.updatedAt &&
    a.entries.length === b.entries.length
  );
}

/** The board row a Session was opened from, if it is still on the board. */
function boardRowFor(sessions: BoardSession[], open: OpenSession): BoardSession | undefined {
  const k = openKeyOf(open);
  return sessions.find((s) => boardKey(s) === k);
}

/** The {@link boardKey} of the open Session — the same Session id can be on the
 *  board once per Project, so the id alone does not say which row is open. */
export function openKeyOf(open: OpenSession): string {
  return boardKey({
    id: open.sessionId,
    projectPath: open.projectPath,
    remoteProjectId: open.remoteProjectId ?? null,
  });
}

/**
 * A Session with its summary but not yet its timeline.
 *
 * The board row already carries every field the masthead reads, so this costs
 * nothing and removes the whole round trip from the first paint. It is only
 * ever shown with `entriesPending`, which is what stops the empty `entries`
 * being read as "this Session recorded nothing".
 */
function shellDetail(row: BoardSession): Detail {
  return {
    summary: row,
    entries: [],
    counts: { prompts: 0, responses: 0, thinking: 0, toolCalls: 0, checkpoints: 0 },
    tools: [],
  };
}

/**
 * The open Session's detail: the cached / shell / full read sequence, the
 * streamed progress, and the re-read while it is live. See the panel's
 * docblock for why `detail` is tri-state and why reads are sequenced.
 */
export function useOpenSessionDetail({
  open,
  sessions,
  loaded,
}: {
  open: OpenSession | null;
  sessions: BoardSession[];
  loaded: boolean;
}) {
  /**
   * The timeline is still arriving for the Session on screen.
   *
   * Distinct from `detail === undefined` (nothing to show yet) because the
   * masthead is painted from the board row the instant it is clicked, ahead of
   * the entries. Without this the shell's empty `entries` would render
   * "Nothing was recorded in this session." — which is exactly what a Session
   * with genuinely no rows says, and the two must not look alike.
   */
  const [entriesPending, setEntriesPending] = useState(false);
  /**
   * Part of the timeline is on screen and the rest is still arriving — a
   * remote Session streamed page by page (`readSessionDetail`'s progress).
   * The reader says so at its foot, and holds a jump to an entry that has not
   * arrived yet rather than dropping it.
   */
  const [entriesStreaming, setEntriesStreaming] = useState(false);
  /**
   * The detail on screen is a WHOLE Session for the open row: a finished read,
   * the in-memory cache, or the disk copy. Progress is applied only while this
   * is false — a background re-read must never swap a whole timeline for a
   * growing prefix of the same one — and a failed re-read leaves it up rather
   * than replacing it with an error.
   */
  const shownWhole = useRef(false);
  /** `undefined` while a detail read is in flight; `null` when not found. */
  const [detail, setDetail] = useState<Detail | null | undefined>(undefined);
  /** Why the open Session could not be read. Scoped to its own pane — see the
   *  `readDetail` catch. */
  const [detailError, setDetailError] = useState<string | null>(null);
  /** Same, for the detail read. */
  const detailSeq = useRef(0);

  // Opening a Session reads its full timeline; the list row does not carry it.
  // The read goes to the store of the project the row came from, which is not
  // necessarily the Project currently open.
  const readDetail = useCallback(
    (showLoading: boolean) => {
      if (!open) return;
      const seq = ++detailSeq.current;
      if (showLoading) setDetail(undefined);
      // Local store first, the server second — see `readSessionDetail` for
      // why the second step is not optional: a teammate's Session in a Project
      // this machine has bound carries a local `projectPath` and is not in the
      // local store.
      readSessionDetail(open, undefined, (partial, complete) => {
        if (seq !== detailSeq.current || shownWhole.current) return;
        setDetail(partial);
        setEntriesPending(false);
        setEntriesStreaming(!complete);
        if (complete) shownWhole.current = true;
      })
        .then((result) => {
          if (result) writeCachedDetail(open, result);
          if (seq !== detailSeq.current) return;
          shownWhole.current = result !== null;
          setEntriesStreaming(false);
          // Keep the previous object when nothing changed.
          //
          // This is the difference between a background refresh being free and
          // being the single most expensive thing the panel does. `detail` flows
          // into `visible` → `groups` → every `Row`'s `group` prop, so swapping
          // in a structurally identical object invalidates every memo in the
          // tree and re-renders every mounted row — hundreds of them, mid-scroll.
          setDetail((current) => (sameDetail(current, result) ? current : result));
          setEntriesPending(false);
          setDetailError(null);
        })
        .catch((e) => {
          if (seq !== detailSeq.current) return;
          setEntriesStreaming(false);
          // A re-read that failed behind a whole timeline (offline, a server
          // hiccup) leaves that timeline up: it is still the Session, just
          // possibly behind.
          if (shownWhole.current) return;
          {
            // A failed read over a painted shell must not leave the masthead up
            // with an empty timeline under it — that reads as "no rows".
            setDetail(null);
            setEntriesPending(false);
            // Deliberately NOT `setError`: that banner spans the whole board,
            // and one Session failing to open says nothing about the other
            // four hundred. It goes in the pane that failed.
            setDetailError(String(e));
          }
        });
    },
    [open],
  );

  useEffect(() => {
    // Whatever is on screen belongs to the row being left.
    shownWhole.current = false;
    setEntriesStreaming(false);
    if (!open) {
      detailSeq.current += 1;
      setDetail(undefined);
      setEntriesPending(false);
      return;
    }
    // A Session read once this browsing session paints from memory and refreshes
    // behind the content. Stepping back to the board and into the next row is
    // the normal way to use the Timeline, and re-reading SQLite for a *finished*
    // Session put a blank panel in front of that every time.
    const cached = readCachedDetail(open);
    if (cached) {
      setDetail(cached);
      setEntriesPending(false);
      shownWhole.current = true;
      readDetail(false);
      return;
    }

    // Nothing cached — but the board row this was opened from IS the summary,
    // so the masthead can paint now and the timeline can arrive after it. That
    // matters most for a Session held on the server, where the read is a paged
    // network walk rather than a local SQLite hit and the whole pane would
    // otherwise sit on "Reading the session…" for seconds.
    const row = boardRowFor(sessions, open);
    if (row) {
      setDetail(shellDetail(row));
      setEntriesPending(true);
      readDetail(false);
      return;
    }

    setEntriesPending(false);
    readDetail(true);
    // `sessions` is read for the opening frame only — re-running this effect on
    // every board refresh would re-paint the shell over a loaded timeline.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, readDetail]);

  // A live Session keeps growing while it is open — piggyback the detail
  // re-read on the same signals that refresh the list, without flashing the
  // loading state over content that is already on screen.
  //
  // Gated on the Session actually being live. `sessions` changes on every board
  // refresh — a 15 s poll plus git and capture events — and re-reading a
  // *finished* Session on each of those costs a megabyte of IPC and a full
  // deserialize to learn that nothing moved. A Session whose last update is
  // older than the live window is not going to grow.
  useEffect(() => {
    if (!open || !loaded || !detail) return;
    if (sessionState(detail.summary) !== "live") return;
    readDetail(false);
    // `sessions` is the freshest signal that a background refresh landed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  return { detail, entriesPending, entriesStreaming, detailError };
}
