import { useContext, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";

import type { ArtifactPayload } from "../types";
import { RemoteSourceContext } from "../lib/session-detail-context";
import type { PayloadPart } from "../lib/session-timeline";

/**
 * Expand a payload the timeline only carries a preview of.
 *
 * The failure copy matters: a pruned blob store is a real state (the Session
 * still renders from previews) and "could not load" must not read as a crash.
 *
 * Two sources, because there are two places an oversized payload can live. A
 * Session captured on this machine spilled it to the local blob sidecar and is
 * addressed by content key. One captured elsewhere was never written here at
 * all — the server holds it, addressed by the entry's row id and which part of
 * it you want. `blobRef` picks the first; the remote context picks the second.
 */
export function ShowFull({
  projectPath,
  blobRef,
  onLoaded,
  rowId,
  part,
}: {
  projectPath: string;
  /** `null` on a remote Session — nothing was spilled to this disk. */
  blobRef: string | null;
  /** The entry the payload belongs to, for the remote read. */
  rowId: string;
  part: PayloadPart;
  onLoaded: (text: string) => void;
}) {
  const remote = useContext(RemoteSourceContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFull = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = blobRef
        ? await invoke<ArtifactPayload>("artifacts_payload", { projectPath, blobRef })
        : await invoke<ArtifactPayload>("artifacts_cloud_payload", {
            projectId: remote?.projectId,
            sessionId: remote?.sessionId,
            rowId,
            part,
          });
      if (payload.text !== null) onLoaded(payload.text);
      else setError("The full payload is binary and cannot be shown.");
    } catch {
      setError("The full payload is no longer on disk.");
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return <span className="ml-1.5 text-xs text-[var(--muted-foreground)]">{error}</span>;
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void fetchFull()}
      className="ml-1.5 inline-flex cursor-pointer items-center gap-1 text-xs text-[var(--secondary-foreground)] underline underline-offset-2 transition-colors hover:no-underline hover:text-[var(--foreground)] disabled:opacity-60"
    >
      {busy && <Loader2 size={10} className="animate-spin" />}
      Show full
    </button>
  );
}
