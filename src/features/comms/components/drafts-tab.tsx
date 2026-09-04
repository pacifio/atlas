import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { timeAgo } from "@/lib/time-ago";
import { CommsAvatar } from "./comms-avatar";
import { comms } from "../lib/comms-api";
import { useCommsStore } from "../stores/comms-store";
import type { PromptDraft } from "../types";

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
export function DraftsTab({ convId }: { convId: string }) {
  const memberList = useCommsStore.use.members();
  const members = useMemo(() => new Map(memberList.map((m) => [m.id, m])), [memberList]);

  const [drafts, setDrafts] = useState<PromptDraft[] | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      comms
        .drafts(convId)
        .then((list) => {
          if (live) setDrafts(list);
        })
        .catch((e) => {
          console.warn("comms: drafts fetch failed:", convId, e);
          if (live && drafts === null) setDrafts([]);
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  const create = async () => {
    const trimmed = title.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const draft = await comms.createDraft(convId, trimmed);
      // The server deliberately does not announce creation — prepend our own.
      setDrafts((prev) => [draft, ...(prev ?? [])]);
      setTitle("");
      inputRef.current?.focus();
    } catch (e) {
      console.warn("comms: create draft failed:", convId, e);
      toast.error(typeof e === "string" ? e : "Could not create that draft.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pb-1 pt-2">
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
            }}
            placeholder="Name a new draft…"
            aria-label="New draft title"
            className="min-w-0 flex-1 rounded-[10px] border border-border-default bg-bg-input px-2.5 py-[5px] text-[11.5px] text-text-primary outline-none placeholder:text-text-ghost focus:border-border-focus"
          />
          <button
            type="button"
            title="Create draft"
            disabled={!title.trim() || creating}
            onClick={() => void create()}
            className="flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-[10px] border border-border-default bg-bg-hover text-text-secondary transition-colors hover:bg-bg-active hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={13} />}
          </button>
        </div>
      </div>

      <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto pb-3">
        {drafts === null &&
          [0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2.5 px-3 py-[9px]">
              <div
                className="h-4 w-4 rounded bg-[var(--bg-elevated)] opacity-50"
                style={{ animation: "atlas-marker-shimmer 1.4s ease-in-out infinite" }}
              />
              <div
                className="h-[9px] rounded bg-[var(--bg-elevated)] opacity-50"
                style={{
                  width: 110 + ((i * 37) % 60),
                  animation: "atlas-marker-shimmer 1.4s ease-in-out infinite",
                }}
              />
            </div>
          ))}
        {drafts !== null && drafts.length === 0 && (
          <p className="px-3 pt-4 text-center text-[11px] text-text-ghost">No drafts yet.</p>
        )}
        {drafts?.map((d) => {
          const author = members.get(d.created_by) ?? null;
          return (
            <div
              key={d.id}
              className="flex flex-col gap-1 border-b border-border-subtle px-3 py-2 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <FileText size={12} className="shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-text-primary">
                  {d.title}
                </span>
                {d.sent_at !== null && (
                  <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-px text-[9.5px] font-medium text-text-primary">
                    sent
                  </span>
                )}
                <span className="shrink-0 text-[9.5px] text-text-ghost">
                  {timeAgo(new Date(d.updated_at).toISOString(), { suffix: true })}
                </span>
              </div>
              <div className="flex items-center gap-1.5 pl-[22px]">
                <CommsAvatar member={author} size={14} />
                <span className="truncate text-[10px] text-text-tertiary">
                  {author?.name ?? "Unknown"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
