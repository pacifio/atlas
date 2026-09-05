import { useState } from "react";
import { AlertTriangle, Frame, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { useSpaceSession } from "../lib/use-space-session";
import { useSpacesStore } from "../stores/spaces-store";
import { readDock, writeDock, type SpaceDock } from "../lib/dock";
import { SpaceCanvas } from "./space-canvas";
import { SpacePages } from "./space-pages";

/**
 * The center-tab host for one conversation's realtime Space — the
 * comms-draft-tab pattern: takes only the id, looks the conversation up live
 * from the store, and owns nothing but layout state (the pages sidebar
 * toggle). The session hook owns the socket; closing the tab closes it.
 */
export function SpacesTab({ convId }: { convId: string }) {
  const conv = useCommsStore((s) => s.conversations.find((c) => c.id === convId));
  if (!conv) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[12px] text-text-tertiary">
        <Frame size={18} className="opacity-60" />
        <div>This Space is no longer available.</div>
        <div className="text-[10px]">The conversation was removed, or you left it.</div>
      </div>
    );
  }
  return <SpaceHost convId={convId} />;
}

function SpaceHost({ convId }: { convId: string }) {
  const session = useSpaceSession(convId);
  const meta = useSpacesStore((s) => s.byConv[convId]);
  const [pagesOpen, setPagesOpen] = useState(true);
  const [dock, setDock] = useState<SpaceDock>(readDock);
  const changeDock = (next: SpaceDock) => {
    setDock(next);
    writeDock(next);
  };

  if (meta?.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[12px] text-text-tertiary">
        <AlertTriangle size={18} className="opacity-60" />
        <div>{meta.error}</div>
      </div>
    );
  }

  const connection = meta?.connection ?? "disconnected";
  const archived = meta?.archived ?? false;
  const treeEditable = connection === "open" && !archived;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-base">
      {archived && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-white/[0.03] px-3 py-1 text-[10px] text-text-tertiary">
          This conversation is archived — the canvas is read-only. Cursors still show who is
          looking.
        </div>
      )}
      {session.readOnly === "actor_ceiling" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-white/[0.03] px-3 py-1 text-[10px] text-text-tertiary">
          This page is full — you are viewing. Re-open the page when a seat frees up.
        </div>
      )}
      {connection === "unavailable" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-white/[0.03] px-3 py-1 text-[10px] text-[var(--status-error,#f66)]">
          This Space refused the connection — you may no longer be a member.
        </div>
      )}
      {session.banner && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-white/[0.03] px-3 py-1 text-[10px] text-text-tertiary">
          <AlertTriangle size={11} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{session.banner}</span>
          <button
            type="button"
            onClick={session.dismissBanner}
            className="flex h-4 w-4 cursor-pointer items-center justify-center rounded text-text-tertiary hover:text-text-primary"
          >
            <X size={10} />
          </button>
        </div>
      )}

      {/* The dock decides the axis: left/right are columns beside the canvas,
          bottom is a row under it. */}
      <div className={cn("flex min-h-0 flex-1", dock === "bottom" ? "flex-col" : "flex-row")}>
        {pagesOpen && dock === "left" && (
          <SpacePages convId={convId} session={session} editable={treeEditable} dock={dock} />
        )}
        <div className="min-h-0 min-w-0 flex-1">
          <SpaceCanvas
            convId={convId}
            session={session}
            pagesOpen={pagesOpen}
            onTogglePages={() => setPagesOpen((o) => !o)}
            dock={dock}
            onDock={changeDock}
          />
        </div>
        {pagesOpen && dock !== "left" && (
          <SpacePages convId={convId} session={session} editable={treeEditable} dock={dock} />
        )}
      </div>
    </div>
  );
}
