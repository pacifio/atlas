import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CommsAvatar } from "./comms-avatar";
import { comms } from "../lib/comms-api";
import { useCommsStore } from "../stores/comms-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import type { ChatConversation, PromptDraft } from "../types";
import { DraftsTabView } from "./views/drafts-tab-view";

/** Web parity: `CHAT_DRAFT_TITLE_MAX`. Refused server-side, not truncated. */
const TITLE_MAX = 200;
/** The web client's cadence. No push channel exists for the draft list. */
const POLL_MS = 10_000;

/**
 * The conversation's prompt drafts: list + create.
 *
 * Deliberately thin — the realtime Yjs editor is a later slice, and the
 * server offers exactly two operations (create, list). The list lives HERE,
 * not in the store: with no lifecycle frames to keep a cache honest, store
 * residency would only manufacture staleness. Poll while visible, refresh on
 * mount, prepend our own 201s.
 */
export function DraftsTab({ conv }: { conv: ChatConversation }) {
  const convId = conv.id;
  const memberList = useCommsStore.use.members();
  const members = useMemo(() => new Map(memberList.map((m) => [m.id, m])), [memberList]);
  // From the STORE, so returning to this tab paints the last list on the
  // first frame. `undefined` means never fetched (skeleton); an empty array
  // is a real answer (empty state).
  const drafts = useCommsStore((s) => s.drafts[convId]);
  const actions = useCommsStore.use.actions();

  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Revalidate silently on entry and on the poll. Nothing clears the cache
    // first, so a refresh is invisible unless the answer actually differs.
    const load = () => {
      if (document.visibilityState !== "visible") return;
      void actions.loadDrafts(convId);
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [convId, actions]);

  const create = async () => {
    const trimmed = title.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const draft = await comms.createDraft(convId, trimmed);
      // The server deliberately does not announce creation — fold our own in.
      actions.adoptDraft(convId, draft);
      setTitle("");
      inputRef.current?.focus();
    } catch (e) {
      console.warn("comms: create draft failed:", convId, e);
      toast.error(typeof e === "string" ? e : "Could not create that draft.");
    } finally {
      setCreating(false);
    }
  };

  // A draft opens as a CENTER tab — a co-written document wants editor real
  // estate and a tab of its own; the chat panel is for glancing. Keyed by
  // draft id so a second click refocuses the existing tab.
  const openInCenter = (d: PromptDraft) => {
    const layout = useLayoutStore.getState();
    const tabId = `comms-draft-${d.id}`;
    if (layout.tabs.some((t) => t.id === tabId)) {
      layout.actions.setActiveTab(tabId);
      return;
    }
    layout.actions.addTab({
      id: tabId,
      type: "comms-draft",
      title: d.title,
      closable: true,
      dirty: false,
      data: { convId, draftId: d.id },
    });
  };

  return (
    <DraftsTabView
      drafts={drafts}
      title={title}
      onTitleChange={setTitle}
      creating={creating}
      onCreate={() => void create()}
      onOpen={openInCenter}
      titleMax={TITLE_MAX}
      inputRef={inputRef}
      author={(id) => {
        const member = members.get(id) ?? null;
        return { name: member?.name ?? null, avatar: <CommsAvatar member={member} size={16} /> };
      }}
    />
  );
}
