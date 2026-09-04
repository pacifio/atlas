import { useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { timeAgo } from "@/lib/time-ago";
import { CommsAvatar } from "./comms-avatar";
import { comms } from "../lib/comms-api";
import { useCommsStore } from "../stores/comms-store";

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* One full-width band with the action inline, matching the agent
          history sidebar's search row (`session-sidebar.tsx`) — a boxed input
          floating inside padding read as a second, competing surface. */}
      <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border-default px-3">
        <FilePlus2 size={11} className="shrink-0 text-text-tertiary" />
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
          className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
        <button
          type="button"
          title="Create draft"
          disabled={!title.trim() || creating}
          onClick={() => void create()}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
        >
          {creating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={12} />}
        </button>
      </div>

      <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto pb-3">
        {drafts === undefined &&
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
        {drafts?.length === 0 && (
          <p className="px-3 pt-4 text-center text-[11px] text-text-ghost">No drafts yet.</p>
        )}
        {drafts?.map((d) => {
          const author = members.get(d.created_by) ?? null;
          // Table row, not a card: title takes the width it can, then a
          // fixed author column, then the created date — so the eye scans a
          // straight edge down the list instead of a ragged one.
          return (
            <div
              key={d.id}
              className="flex cursor-pointer items-center gap-2 border-b border-border-subtle px-3 py-2 transition-colors last:border-b-0 hover:bg-bg-hover"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-[11.5px] font-medium text-text-primary">
                    {d.title}
                  </span>
                  {d.sent_at !== null && (
                    <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-px text-[9.5px] font-medium text-text-primary">
                      sent
                    </span>
                  )}
                </div>
                <span className="mt-0.5 block truncate text-[9.5px] text-text-ghost">
                  Updated {timeAgo(new Date(d.updated_at).toISOString(), { suffix: true })}
                </span>
              </div>

              {/* Native `title`, not a tooltip component: these are
                  mass-rendered rows and the repo keeps native titles there —
                  and it is what carries the FULL name, since the label beside
                  the avatar is only the first. */}
              <span
                className="flex min-w-0 shrink-0 items-center gap-1"
                title={`Created by ${author?.name ?? "Unknown"}`}
              >
                <CommsAvatar member={author} size={16} />
                <span className="max-w-[72px] truncate text-[9.5px] text-text-tertiary">
                  {firstName(author?.name)}
                </span>
              </span>

              <span className="w-[62px] shrink-0 text-right text-[9.5px] tabular-nums text-text-tertiary">
                {formatCreated(d.created_at)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Created dates are calendar facts, not elapsed ones — a short absolute date
 *  reads faster in a column than "3 weeks ago", and the relative form is
 *  already carrying the updated-at line above it. */
function formatCreated(at: number): string {
  const d = new Date(at);
  const now = new Date();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "2-digit" }),
  });
}

/** Just the given name — the row has a date column to protect, and the
 *  avatar's `title` still carries the whole name for anyone who asks. */
function firstName(name: string | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first || "Unknown";
}
