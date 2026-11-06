import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { useArtifactsStore, type OpenSession } from "../stores/artifacts-store";
import type { BoardSession, ProjectFilter } from "../types";
import { readBoard, refreshCloudBoard } from "./board-api";
import { boardKey, rowForCheckout } from "./board-key";
import { clearDetailCache, invalidateCachedDetail } from "./detail-cache";

/**
 * Same idea for the board list: cheap signature, not a deep compare. A session
 * only moves on the board when it gains activity (updatedAt) or rows
 * appear/disappear — first/last cover reordering since the read is sorted.
 */
function sameBoard(a: BoardSession[], b: BoardSession[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  // By board key, not id: a Session re-sent to another Project keeps its id,
  // and a row that changed Project must still re-render.
  const sig = (s: BoardSession) => `${boardKey(s)}|${s.updatedAt}`;
  return (
    sig(a[0]) === sig(b[0]) &&
    sig(a[a.length - 1]) === sig(b[b.length - 1]) &&
    a.every((s, i) => sig(s) === sig(b[i]))
  );
}

/**
 * The Timeline board's rows: the sequenced read, the event-driven refresh, the
 * reset on an Organisation switch, and the cloud-failure notice. The panel
 * (`artifacts-panel.tsx`) calls this once; see its docblock for the
 * correctness rules this keeps.
 */
export function useTimelineBoard({
  open,
  projectPaths,
  projectsKey,
  projectFilter,
  activeOrganisationId,
  openSession,
  setProjectFilter,
}: {
  open: OpenSession | null;
  projectPaths: string[];
  projectsKey: string;
  projectFilter: ProjectFilter | null;
  activeOrganisationId: string | null;
  openSession: (open: OpenSession | null) => void;
  setProjectFilter: (filter: ProjectFilter | null) => void;
}) {
  const [sessions, setSessions] = useState<BoardSession[]>([]);
  /** True once the first board read has landed. */
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A synced Organisation's first server read has not landed.
   *
   * The board is local-first, so for a synced Organisation the first read comes
   * back with nothing and `loaded` flips true — which rendered "No sessions
   * captured yet" for the moment before the remote rows arrived. The local-only
   * case never had this, because its first read is the whole answer.
   */
  const [cloudPending, setCloudPending] = useState(false);
  /**
   * Which Organisation we have already told the user about.
   *
   * The board re-reads on every capture and git event and on a fifteen-second
   * ticker, and all of them carry the failure flag — so without this the notice
   * would reappear every few seconds for as long as the connection is down.
   * Cleared on an org switch and on a successful read, so a later failure is
   * reported again.
   */
  const cloudFailureToldFor = useRef<string | null>(null);

  const retryCloud = useCallback(() => {
    void refreshCloudBoard()
      .then((ok) => {
        if (ok) toast.success("Cloud sessions loaded.");
        // A failed retry re-arms the notice rather than raising a second one
        // on top of the first — `refresh` below will report it again.
        else cloudFailureToldFor.current = null;
      })
      .catch(() => {
        cloudFailureToldFor.current = null;
      })
      .finally(() => void refreshRef.current?.());
  }, []);

  const reportCloudFailure = useCallback(
    (failed: boolean, orgId: string | null) => {
      if (!failed) {
        cloudFailureToldFor.current = null;
        return;
      }
      if (cloudFailureToldFor.current === orgId) return;
      cloudFailureToldFor.current = orgId;
      toast.error("Couldn't load this Organization's shared sessions.", {
        id: "timeline-cloud-failed",
        description: "Showing the sessions recorded on this machine.",
        action: { label: "Retry", onClick: retryCloud },
      });
    },
    [retryCloud],
  );

  /** `refresh` is defined below and the retry needs it; a ref keeps the two
   *  from having to be declared in dependency order. */
  const refreshRef = useRef<(() => void) | null>(null);

  /** Monotonic read sequence — only the newest read may write list state. */
  const listSeq = useRef(0);

  // A Session opened from outside the board — a commit's "Produced by" card,
  // Atlas Agent's open action — names its checkout but not its server Project,
  // and without that the Session reads as unshared: no comments, no link. The
  // board row knows it, so take it from there once the board has it.
  useEffect(() => {
    if (!open || open.remoteProjectId !== undefined) return;
    const row = rowForCheckout(sessions, open.sessionId, open.projectPath);
    if (row) openSession({ ...open, remoteProjectId: row.remoteProjectId });
  }, [open, sessions, openSession]);

  // Switching Organisation closes whatever was open and drops the cache.
  //
  // The comment here used to *claim* the open Session was dropped. It was not,
  // and that was the bug behind the red banner over the board: a Session from
  // the previous tenant stayed open, its detail re-read against the new one,
  // and a Project the new Organisation has never heard of came back as a
  // failure. A Session belongs to the Organisation it was opened in.
  //
  // Keyed on a ref rather than firing on mount, because a Session opened from
  // outside — the git panel's history, a Checkpoint — is set *before* this
  // panel mounts, and clearing on the first run would close it again.
  const lastOrg = useRef(activeOrganisationId);
  useEffect(() => {
    if (lastOrg.current === activeOrganisationId) return;
    lastOrg.current = activeOrganisationId;
    clearDetailCache();
    openSession(null);
    // A server Project belongs to the Organisation it was chosen in; kept, it
    // would narrow the next tenant's board to nothing.
    const filter = useArtifactsStore.getState().projectFilter;
    if (filter && "remote" in filter) setProjectFilter(null);
    setError(null);
    // Back to the loading state rather than the previous tenant's rows. The
    // refresh below repopulates; leaving them up means one Organisation's work
    // is briefly on screen under another's name.
    setSessions([]);
    setLoaded(false);
    setCloudPending(true);
    // A new tenant gets its own notice if it also fails.
    cloudFailureToldFor.current = null;
    toast.dismiss("timeline-cloud-failed");
  }, [activeOrganisationId, openSession, setProjectFilter]);

  // A filter naming a project that is no longer open would hide everything with
  // no way back, so it is dropped rather than left dangling.
  useEffect(() => {
    if (projectFilter && "local" in projectFilter && !projectPaths.includes(projectFilter.local))
      setProjectFilter(null);
  }, [projectFilter, projectPaths, setProjectFilter]);

  const refresh = useCallback(async () => {
    const seq = ++listSeq.current;
    try {
      // Filtering narrows the *query*, not the result. The board caps how many
      // rows it returns, so filtering afterwards would show only this project's
      // share of the newest few hundred; asking for one project reads its
      // history whole.
      // The filter is explicit, not `[path]`: one open folder is not a filter,
      // and a server Project with no checkout has no path to send.
      const page = await readBoard(projectPaths, projectFilter);
      if (seq !== listSeq.current) return; // a newer read owns the state now
      const rows = page.sessions;
      setCloudPending(page.cloudPending);
      reportCloudFailure(page.cloudFailed, activeOrganisationId);
      // Same-data bailout, the list-side sibling of `sameDetail`: the poll and
      // the capture/git events re-read even when nothing changed, and an
      // unconditional setSessions handed a fresh array identity to the memo'd
      // grouping + all ~500 rows every 15 s. Signature over the fields that
      // move when any row changes (ids + updatedAt at both ends + count).
      setSessions((current) => (sameBoard(current, rows) ? current : rows));
      setError(null);
      setLoaded(true);
    } catch (e) {
      if (seq === listSeq.current) setError(String(e));
    }
    // `projectsKey` stands in for `projectPaths`: same content, stable identity.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsKey, projectFilter, reportCloudFailure, activeOrganisationId]);

  // The retry needs `refresh` and is declared above it — see `refreshRef`.
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Event-driven refresh, with a visible-only poll as the fallback for
  // capture writes (turn finished, import progressed, drain sent rows) that
  // move no git ref and therefore emit no event.
  useEffect(() => {
    // Two push signals, then the poll as a floor.
    //
    // `atlas:capture-changed` is the one that matters: the capture worker emits
    // it (coalesced) whenever it writes, which is what makes a session you just
    // started appear immediately rather than up to fifteen seconds later. It
    // did not exist before, so the poll *was* the refresh — and capture writes
    // move no git ref, so `atlas:git-changed` never fired for them.
    //
    // Any project's commit can add a Checkpoint to this board, so unlike the
    // project-scoped view this no longer filters the git event by path.
    const unlisten = Promise.all([
      listen("atlas:git-changed", () => void refresh()),
      listen("atlas:capture-changed", (e) => {
        // A local write to one Session. Its cached timeline is now a snapshot
        // of a Session that has since moved, and the cache is served
        // SYNCHRONOUSLY on the next open — so a stale entry is a wrong panel,
        // not a slow one.
        // The recording worker names what it wrote (`CaptureChanged` in
        // capture.rs); other emitters send nothing and only mean "re-read".
        const changed = e.payload as { sessionIds?: string[]; all?: boolean } | null;
        if (changed?.all) clearDetailCache();
        else for (const id of changed?.sessionIds ?? []) invalidateCachedDetail(id);
        void refresh();
      }),
      // The cloud half of the same story: a teammate's Session grew, or a
      // resync says everything we hold may be behind.
      listen("atlas:artifacts-cloud", (e) => {
        const frame = e.payload as { kind?: string; sessionId?: string } | null;
        if (!frame) return;
        if (frame.kind === "entryUpsert" && frame.sessionId) {
          invalidateCachedDetail(frame.sessionId);
        } else if (frame.kind === "boardChanged") {
          void refresh();
        } else if (frame.kind === "resync") {
          clearDetailCache();
          void refresh();
        }
      }),
    ]);

    // Read once more as soon as the listeners are actually live.
    //
    // `listen` is a round trip: between this panel's first read and its
    // subscription being registered there is a window, and an event emitted
    // inside it reaches nobody. Rust fills the cloud half of the board in the
    // background and emits exactly once when it lands — so losing that one
    // event left every REMOTE Session off the board until something unrelated
    // refreshed it, which is why the rows appeared the moment you opened a
    // Session or touched a filter.
    //
    // Cheap, and idempotent: a board read that finds nothing new hits the
    // `sameBoard` bailout and does not even re-render.
    void unlisten.then(() => void refresh());
    // No poll: the two events above cover every write path (they are why a
    // fresh session appears immediately), and the visibility handler below
    // catches anything that happened while the window was hidden. The 15s
    // interval predated both and was pure redundancy by the time it died.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      void unlisten.then((stops) => stops.forEach((stop) => stop()));
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return { sessions, loaded, error, cloudPending };
}
