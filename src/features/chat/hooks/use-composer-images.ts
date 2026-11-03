import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store";
import { agents } from "../lib/agents-api";
import { aggregateExceedsBudget } from "../lib/image-policy";
import type { StagedImage } from "../lib/downscale-attachment";

export function useComposerImages(tabId: string) {
  // ── Image attachments (multimodal input) ─────────────────────────────────
  // Images staged for the next send. Only populated when the bound agent
  // advertised promptCapabilities.image; otherwise picked images degrade to
  // path mention chips (any agent can read those off disk).
  //
  // A staged image shows only as its chip in the prompt — no thumbnail strip
  // above the field, which repeated what the chip already says. The chip and
  // the staged bytes are one attachment, joined by `path`: deleting the chip
  // drops the bytes (`handleDocChange`). The agent gets both the inline bytes
  // (downscaled if over budget) and the path, which it can open at full size.
  // The sent message still shows the images (`transcript-rows.tsx`).
  const [stagedImages, setStagedImages] = useState<StagedImage[]>([]);
  const stagedRef = useRef(stagedImages);
  stagedRef.current = stagedImages;
  const acpBoundKey = useChatStore((s) => {
    const sess = s.sessions[tabId];
    return sess?.acpAgentId && sess.acpSessionId
      ? `${sess.acpAgentId}::${sess.acpSessionId}`
      : null;
  });
  const [imageSupported, setImageSupported] = useState(false);
  useEffect(() => {
    if (!acpBoundKey) {
      setImageSupported(false);
      return;
    }
    const [agent_id, session_id] = acpBoundKey.split("::");
    let cancelled = false;
    agents
      .snapshotMeta({ agent_id, session_id })
      .then((snap) => {
        if (!cancelled) setImageSupported(!!snap.prompt_image_supported);
      })
      .catch(() => {
        if (!cancelled) setImageSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, [acpBoundKey]);
  // Rebinding to an agent without image support (agent switch, crash rebind)
  // drops staged images — they could no longer be sent truthfully.
  useEffect(() => {
    if (!imageSupported) setStagedImages([]);
  }, [imageSupported]);

  // The per-image budget is per image only: several in-budget attachments
  // plus the prompt, tools and history can still blow the gateway's body cap
  // (#71). The gateway's 413 stays the backstop — this is the warning the
  // user is owed BEFORE pressing send, once per crossing, cleared when they
  // remove enough to fit again.
  const stagedOverAggregateBudget = aggregateExceedsBudget(
    stagedImages.map((img) => img.dataBase64.length),
  );
  const warnedAggregateRef = useRef(false);
  useEffect(() => {
    if (stagedOverAggregateBudget && !warnedAggregateRef.current) {
      warnedAggregateRef.current = true;
      toast.warning(
        "These attachments together are near the 2 MB request limit — the send may be refused. Consider removing one.",
      );
    }
    if (!stagedOverAggregateBudget) warnedAggregateRef.current = false;
  }, [stagedOverAggregateBudget]);

  return { stagedImages, setStagedImages, stagedRef, imageSupported };
}
