import { useCallback, useEffect, useState } from "react";
import { Check, Lock, LockOpen, UserPlus, X } from "lucide-react";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";

import {
  declineJoin,
  ownerView,
  setJoinPolicy,
  setRole,
  setThreadOpen,
  sharedThreadError,
  type OwnerView,
  type SharedThreadError,
} from "../lib/shared-threads-api";
import { useSharedThreadsStore } from "../stores/shared-threads-store";

/**
 * What only a Shared Thread's owner manages (ATL-406): join requests to
 * approve or decline, each person's role, whether joining needs approval, and
 * closing or reopening the thread. Every action answers the fresh view; a
 * join request arriving on the socket refetches it.
 */
export function OwnerPanel({ sharedThreadId }: { sharedThreadId: string }) {
  const [view, setView] = useState<OwnerView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SharedThreadError | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const asked = useSharedThreadsStore((s) => s.joinRequests[sharedThreadId] ?? 0);

  useEffect(() => {
    let live = true;
    ownerView(sharedThreadId)
      .then((v) => live && setView(v))
      .catch((e) => live && setError(sharedThreadError(e)));
    return () => {
      live = false;
    };
  }, [sharedThreadId, asked]);

  const act = useCallback(async (action: () => Promise<OwnerView>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await action());
    } catch (e) {
      setError(sharedThreadError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!view) {
    return error ? <p className="text-error">{error.message}</p> : null;
  }
  const closed = view.status === "closed";
  const people = view.participants.filter((p) => p.role !== "owner");

  return (
    <section aria-label="Manage this thread" className="flex flex-col gap-2">
      {view.requests.length > 0 && (
        <div className="flex flex-col gap-1 rounded bg-warning-muted p-2">
          <span className="flex items-center gap-1.5 font-medium text-[var(--foreground)]">
            <UserPlus size={12} /> Waiting to join
          </span>
          {view.requests.map((r) => (
            <div key={r.userId} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono">{r.userId}</span>
              <Button
                size="xs"
                variant="outline"
                aria-label={`Approve ${r.userId}`}
                disabled={busy}
                onClick={() => void act(() => setRole(sharedThreadId, r.userId, "participant"))}
              >
                <Check size={11} /> Approve
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Decline ${r.userId}`}
                disabled={busy}
                onClick={() => void act(() => declineJoin(sharedThreadId, r.userId))}
              >
                <X size={11} /> Decline
              </Button>
            </div>
          ))}
        </div>
      )}

      {people.length > 0 && (
        <ul aria-label="People" className="flex flex-col gap-1">
          {people.map((p) => (
            <li key={p.userId} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--secondary-foreground)]">
                {p.userId}
              </span>
              <div role="group" aria-label={`${p.userId}'s role`} className="flex">
                {(["participant", "viewer"] as const).map((role) => (
                  <button
                    key={role}
                    type="button"
                    aria-pressed={p.role === role}
                    disabled={busy || closed || p.role === role}
                    onClick={() => void act(() => setRole(sharedThreadId, p.userId, role))}
                    className={cn(
                      "h-5 border border-[var(--atlas-border-subtle)] px-1.5 text-2xs capitalize first:rounded-l last:rounded-r",
                      p.role === role
                        ? "bg-[var(--atlas-element-hover)] text-[var(--foreground)]"
                        : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                    )}
                  >
                    {role}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-[var(--secondary-foreground)]">
        <input
          type="checkbox"
          checked={view.joinPolicy === "approval"}
          disabled={busy || closed}
          onChange={(e) =>
            void act(() => setJoinPolicy(sharedThreadId, e.target.checked ? "approval" : "auto"))
          }
          className="size-3 cursor-pointer accent-[var(--primary)]"
        />
        Approval required to join
      </label>

      <div className="flex items-center gap-1.5">
        {closed ? (
          <>
            <Badge variant="outline">Closed</Badge>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void act(() => setThreadOpen(sharedThreadId, true))}
            >
              <LockOpen size={11} /> Reopen
            </Button>
          </>
        ) : confirmClose ? (
          <>
            <span className="text-[var(--secondary-foreground)]">
              Everyone&apos;s copy turns read-only.
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setConfirmClose(false);
                void act(() => setThreadOpen(sharedThreadId, false));
              }}
            >
              Close thread
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmClose(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirmClose(true)}>
            <Lock size={11} /> Close…
          </Button>
        )}
      </div>
      {error && <p className="text-error">{error.message}</p>}
    </section>
  );
}
