// One memory in the Memories pane, props-only: its words, the fix-or-forget
// actions right under them (asking the agent first: most fixes are asked
// for, not typed), where it came from (the session that wrote it,
// on the history rail, with a way back to that session) and how agents use
// it. Editing is in place: a draft, ⌘↵ to save, Esc to put it back.

import {
  ArchiveRestore,
  ArrowLeft,
  Check,
  Eraser,
  ExternalLink,
  GitCommitHorizontal,
  Loader2,
  MoreHorizontal,
  Pencil,
  ThumbsDown,
  Timer,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { FileTreeConfirmDelete } from "@/features/explorer/components/file-tree-confirm-delete";
import { AgentGlyph } from "@/components/brand-marks";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  PropertyRow,
} from "@tryatlas/design";
import { kindNoun, provenanceSession } from "../../lib/memory-entries";
import { pluginIdForSource } from "../../lib/memory-agent";
import {
  confidenceLabel,
  fmtDateTime,
  sourceLabel,
  type MemoryEntry,
  type Provenance,
} from "../../lib/shared-memory-format";
import { AgentName, EntryAuthor, KindGlyph, StateBadge } from "./memory-entry-parts";
import { RailNode, RailRow } from "./memory-rail";
import { AskField } from "./memory-chrome";
import { ENTRY_ASK_EXAMPLE } from "../../lib/memory-ask";

/** Provenance dates arrive as `YYYY-MM-DD`; show them like the rest of the
 *  pane ("Sep 18"), and pass anything else through untouched. */
function addedLabel(added: string): string {
  const d = new Date(`${added}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? added
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface MemoryEntryDetailViewProps {
  entry: MemoryEntry;
  /** `null` while it loads. */
  provenance: Provenance[] | null;
  editing: boolean;
  draft: string;
  dirty: boolean;
  saving: boolean;
  /** A verdict or restore in flight. */
  busy: boolean;
  confirmForget: boolean;
  confirmErase: boolean;
  onDraftChange: (draft: string) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onAskForget: () => void;
  onAskErase: () => void;
  onForget: () => void;
  onErase: () => void;
  onConfirmForgetChange: (open: boolean) => void;
  onConfirmEraseChange: (open: boolean) => void;
  onMarkOutdated: () => void;
  onMarkWrong: () => void;
  onRestore: () => void;
  /** Open the ask box about this memory, grown from `anchor`. */
  onAskAgent: (anchor: HTMLElement) => void;
  /** Open the session a provenance names, on the Timeline. */
  onOpenSession: (p: Provenance) => void;
  onClose: () => void;
}

export function MemoryEntryDetailView(p: MemoryEntryDetailViewProps) {
  const e = p.entry;
  const archived = e.state === "archived";
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-2">
        <IconButton
          icon={ArrowLeft}
          label="Back to memories"
          size="xs"
          className="@3xl/memories:hidden"
          onClick={p.onClose}
        />
        <KindGlyph kind={e.kind} className="ml-1 text-muted-foreground" />
        <span className="text-xs font-medium text-secondary-foreground">{kindNoun(e.kind)}</span>
        <StateBadge state={e.state} />
        <span className="ml-auto" />
        <IconButton
          icon={X}
          label="Close"
          size="xs"
          className="hidden @3xl/memories:inline-flex"
          onClick={p.onClose}
        />
      </div>

      <div className="space-y-6 px-4 py-4">
        <div className="space-y-3">
          {p.editing ? (
            <textarea
              value={p.draft}
              autoFocus
              onChange={(ev) => p.onDraftChange(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
                  ev.preventDefault();
                  p.onSave();
                } else if (ev.key === "Escape") {
                  ev.stopPropagation();
                  p.onCancel();
                }
              }}
              spellCheck={false}
              rows={Math.min(10, Math.max(3, p.draft.split("\n").length + 1))}
              aria-label="Memory content"
              className={cn(
                "block w-full resize-y rounded-md border bg-panel-input px-3 py-2 font-sans text-sm leading-relaxed text-foreground outline-none",
                "transition-colors duration-fast ease-out-strong focus:border-border-strong",
                p.dirty ? "border-border-strong" : "border-border",
              )}
            />
          ) : (
            <p
              className={cn(
                "text-base leading-relaxed break-words whitespace-pre-wrap",
                archived ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {e.content || "—"}
            </p>
          )}

          {/* Asking is the primary fix: "this is outdated, we moved to
              Postgres" goes to a session, and the agent rewrites the memory.
              The verdicts stay one click; editing by hand is in ⋯. */}
          {!p.editing && (
            <AskField label="Ask agent…" hint={`“${ENTRY_ASK_EXAMPLE}”`} onOpen={p.onAskAgent} />
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            {p.editing ? (
              <>
                <Button size="sm" disabled={!p.dirty || p.saving} onClick={p.onSave}>
                  {p.saving ? (
                    <Loader2 aria-hidden className="size-3.5 animate-spin" />
                  ) : (
                    <Check aria-hidden className="size-3.5" />
                  )}
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={p.onCancel}>
                  Cancel
                </Button>
                <span className="ml-1 text-2xs text-disabled">⌘↵ to save · Esc to cancel</span>
              </>
            ) : (
              <>
                {archived ? (
                  <Button size="sm" variant="ghost" disabled={p.busy} onClick={p.onRestore}>
                    <ArchiveRestore aria-hidden className="size-3.5" />
                    Restore
                  </Button>
                ) : (
                  // Short labels so the verdicts and Forget fit one row of the
                  // pane; the full phrase is their name and their hover.
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={p.busy}
                      aria-label="Mark as outdated"
                      title="Mark as outdated"
                      onClick={p.onMarkOutdated}
                    >
                      <Timer aria-hidden className="size-3.5" />
                      Outdated
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={p.busy}
                      aria-label="Mark as wrong"
                      title="Mark as wrong"
                      onClick={p.onMarkWrong}
                    >
                      <ThumbsDown aria-hidden className="size-3.5" />
                      Wrong
                    </Button>
                  </>
                )}
                <Button size="sm" variant="ghost-destructive" onClick={p.onAskForget}>
                  <Trash2 aria-hidden className="size-3.5" />
                  Forget
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<IconButton icon={MoreHorizontal} label="More actions" size="sm" />}
                  />
                  <DropdownMenuContent align="start" side="bottom" className="w-64">
                    {!archived && (
                      <>
                        <DropdownMenuItem onClick={p.onEdit}>
                          <Pencil />
                          Edit by hand
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuItem variant="destructive" onClick={p.onAskErase}>
                      <Eraser />
                      Erase with history…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>

        <section aria-label="Where it came from">
          <h4 className="mb-2 text-2xs font-medium text-muted-foreground">Where it came from</h4>
          {p.provenance === null ? (
            <p className="text-xs text-muted-foreground">Looking it up…</p>
          ) : p.provenance.length === 0 ? (
            <Origin entry={e} />
          ) : (
            <div>
              {p.provenance.map((prov, i) => (
                <ProvenanceRow
                  key={`${prov.source}-${i}`}
                  provenance={prov}
                  first={i === 0}
                  last={i === p.provenance!.length - 1}
                  onOpen={() => p.onOpenSession(prov)}
                />
              ))}
            </div>
          )}
        </section>

        <section aria-label="How agents use it" className="space-y-0.5">
          <h4 className="mb-2 text-2xs font-medium text-muted-foreground">How agents use it</h4>
          <PropertyRow label="Used">
            <span className="tabular-nums text-secondary-foreground">
              {e.uses === 0 ? "Not yet" : `${e.uses} time${e.uses === 1 ? "" : "s"}`}
            </span>
          </PropertyRow>
          {e.lastUsedAt ? (
            <PropertyRow label="Last used">
              <span className="text-secondary-foreground">
                {timeAgo(new Date(e.lastUsedAt).toISOString(), { suffix: true })}
              </span>
            </PropertyRow>
          ) : null}
          <PropertyRow label="Confidence">
            <span className="tabular-nums text-secondary-foreground">
              {confidenceLabel(e.confidence)}
            </span>
          </PropertyRow>
          <PropertyRow label="Written by">
            <span className="min-w-0 truncate text-secondary-foreground">
              <EntryAuthor entry={e} />
            </span>
          </PropertyRow>
          <PropertyRow label="Source">
            <span className="text-secondary-foreground">{sourceLabel(e.source)}</span>
          </PropertyRow>
          {e.key ? (
            <PropertyRow label="Key">
              <code className="truncate font-mono text-2xs text-secondary-foreground">{e.key}</code>
            </PropertyRow>
          ) : null}
          <PropertyRow label="Created">
            <span className="text-secondary-foreground">{fmtDateTime(e.createdAt)}</span>
          </PropertyRow>
          <PropertyRow label="Updated">
            <span className="text-secondary-foreground">{fmtDateTime(e.updatedAt)}</span>
          </PropertyRow>
          <PropertyRow label="Revision">
            <span className="tabular-nums text-secondary-foreground">{e.revision}</span>
          </PropertyRow>
        </section>
      </div>

      <FileTreeConfirmDelete
        open={p.confirmForget}
        name={e.content}
        isDir={false}
        title="Forget this memory?"
        body="Every agent on this project stops seeing it, and it no longer shows in search. This can't be undone."
        confirmLabel="Forget"
        onConfirm={p.onForget}
        onOpenChange={p.onConfirmForgetChange}
      />
      <FileTreeConfirmDelete
        open={p.confirmErase}
        name={e.content}
        isDir={false}
        title="Erase this memory and its history?"
        body="It is forgotten, and every earlier wording is overwritten on disk. Use this for a secret that slipped into memory. This can't be undone. Recorded sessions in the Timeline keep their own copy of the conversation; this does not change them."
        confirmLabel="Erase"
        onConfirm={p.onErase}
        onOpenChange={p.onConfirmEraseChange}
      />
    </div>
  );
}

/** No recorded provenance: say who wrote it, from the entry itself. */
function Origin({ entry: e }: { entry: MemoryEntry }) {
  return (
    <RailRow
      first
      last
      node={
        <RailNode>
          {e.agent && e.agent !== "user" ? (
            <AgentGlyph agentType={pluginIdForSource(e.agent)} />
          ) : (
            <UserRound aria-hidden className="size-3.5" />
          )}
        </RailNode>
      }
    >
      <div className="flex min-h-8 flex-col justify-center text-xs">
        <span className="text-secondary-foreground">
          <EntryAuthor entry={e} strong />
        </span>
        <span className="mt-0.5 text-2xs text-muted-foreground">{fmtDateTime(e.createdAt)}</span>
      </div>
    </RailRow>
  );
}

function ProvenanceRow({
  provenance: prov,
  first,
  last,
  onOpen,
}: {
  provenance: Provenance;
  first: boolean;
  last: boolean;
  onOpen: () => void;
}) {
  const session = provenanceSession(prov);
  const byUser = prov.source === "atlas-user";
  return (
    <RailRow
      first={first}
      last={last}
      node={
        <RailNode>
          {byUser || !prov.agent ? (
            <UserRound aria-hidden className="size-3.5" />
          ) : (
            <AgentGlyph agentType={pluginIdForSource(prov.agent)} />
          )}
        </RailNode>
      }
    >
      <div className="flex min-h-8 flex-col justify-center gap-0.5 text-xs">
        <span className="text-secondary-foreground">
          {byUser ? (
            "Written by you"
          ) : prov.title ? (
            <>
              Learned in <span className="font-medium text-foreground">“{prov.title}”</span>
            </>
          ) : session ? (
            "Learned in a session"
          ) : (
            `From ${prov.source}`
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground">
          {!byUser && prov.agent ? <AgentName agent={prov.agent} /> : null}
          {prov.added ? <span>{addedLabel(prov.added)}</span> : null}
          {prov.commits.slice(0, 3).map((sha) => (
            <code
              key={sha}
              title={sha}
              className="inline-flex items-center gap-0.5 font-mono text-secondary-foreground"
            >
              <GitCommitHorizontal aria-hidden className="size-3" />
              {sha.slice(0, 7)}
            </code>
          ))}
        </span>
        {session ? (
          <Button size="xs" variant="ghost" className="-ml-1.5 mt-0.5 w-fit" onClick={onOpen}>
            <ExternalLink aria-hidden className="size-3" />
            Open the session
          </Button>
        ) : null}
      </div>
    </RailRow>
  );
}
