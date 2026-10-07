import { useEffect, useState, type RefObject } from "react";
import { RailGlyph } from "@/ui/animated-icon";
import { useReactFlow, useViewport } from "@xyflow/react";
import { Popover } from "@base-ui/react/popover";
import {
  ChevronDown,
  Crosshair,
  Download,
  ExternalLink,
  Eye,
  FileImage,
  FileText,
  FileType2,
  Loader2,
  Minus,
  Plus,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Hint, Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { CommsAvatar } from "@/features/comms/components/comms-avatar";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { exportCanvas, type ExportFormat } from "@/features/canvas/lib/canvas-export";
import type { SpacePage } from "../lib/spaces-api";
import type { SpaceActor } from "../lib/space-wire";

// The floating chrome over the realtime canvas — the local canvas's design:
// top-left page pill (pages toggle · page dropdown · fit), top-right a single
// pill carrying presence, the web link and export, divided rather than
// scattered. Both render INSIDE the ReactFlowProvider (fit + export need rf).

/** Where a Space lives in the web app: `/space/{conv}?org={org}`. */
const WEB_ORIGIN = "https://app.tryatlas.cc";

/** What the canvas is doing with the server, as one glyph. */
export type SyncState = "synced" | "syncing" | "offline";

/**
 * The sync indicator, where the page emoji used to be.
 *
 * This replaces a banner across the top of the tab: a reconnect is a
 * transient state of ONE pill, not news worth reflowing the canvas for, and
 * the edits are held and replayed either way.
 */
function SyncDot({ sync }: { sync: SyncState }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {sync === "syncing" ? (
              <Loader2 size={11} className="animate-spin text-muted-foreground" />
            ) : (
              <span
                className={cn(
                  "h-[7px] w-[7px] rounded-full",
                  sync === "synced" ? "bg-success" : "bg-error",
                )}
              />
            )}
          </span>
        }
      />
      <TooltipContent side="bottom" sideOffset={4}>
        {sync === "synced"
          ? "Live — every change is shared as you make it"
          : sync === "syncing"
            ? "Reconnecting… your edits are kept and sent when the Space is back"
            : "Not connected — this Space refused the connection"}
      </TooltipContent>
    </Tooltip>
  );
}

export function SpaceHeaderPill({
  pages,
  activePageId,
  onOpenPage,
  pagesOpen,
  onTogglePages,
  sync,
}: {
  pages: SpacePage[];
  activePageId: string | null;
  onOpenPage: (id: string) => void;
  pagesOpen: boolean;
  onTogglePages: () => void;
  sync: SyncState;
}) {
  const rf = useReactFlow();
  const [open, setOpen] = useState(false);
  const active = pages.find((p) => p.id === activePageId) ?? null;
  const selectable = pages.filter((p) => p.kind === "page");

  return (
    <div
      className={cn(
        "absolute left-3 top-3 z-panel flex items-center gap-1.5 py-1 pl-1 pr-1",
        "rounded-xl border border-border-subtle bg-[var(--card)]/70 shadow-md backdrop-blur-2xl",
      )}
    >
      <Hint label={pagesOpen ? "Hide pages" : "Show pages"}>
        <button
          type="button"
          onClick={onTogglePages}
          className={cn(
            "flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition-colors",
            pagesOpen
              ? "bg-element-selected text-foreground"
              : "text-muted-foreground hover:bg-element-hover hover:text-foreground",
          )}
        >
          <RailGlyph open={pagesOpen} size="md" />
        </button>
      </Hint>
      <div className="mx-0.5 h-4 w-px bg-border-subtle" />

      {/* The page name is the shorthand page selector — the dock is the long
          way round, and a canvas is usually two clicks from another page. */}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              title="Switch page"
              className="flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1 transition-colors hover:bg-element-hover"
            >
              <SyncDot sync={sync} />
              <span className="max-w-[180px] truncate text-sm font-semibold text-foreground">
                {active?.name || "Space"}
              </span>
              <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
            </button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner className="z-popover" align="start" sideOffset={6}>
            <Popover.Popup className="atlas-panel-in-tl inset-highlight shadow-md select-none overflow-hidden rounded-xl border border-border-subtle bg-[var(--card)]/95 backdrop-blur-2xl">
              <div className="flex max-h-[320px] w-[220px] flex-col overflow-y-auto py-1">
                {selectable.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onOpenPage(p.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--atlas-element-hover)]",
                      p.id === activePageId ? "text-foreground" : "text-secondary-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{p.name || "Untitled"}</span>
                    {p.id === activePageId && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--primary)]" />
                    )}
                  </button>
                ))}
                {selectable.length === 0 && (
                  <div className="px-3 py-2 text-2xs text-muted-foreground">No pages yet.</div>
                )}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      <div className="mx-0.5 h-4 w-px bg-border-subtle" />
      <ZoomReadout />
      <Hint label="Fit to view">
        <button
          type="button"
          onClick={() => rf.fitView({ duration: 350, padding: 0.2 })}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground"
        >
          <Crosshair size={12} />
        </button>
      </Hint>
    </div>
  );
}

/**
 * The zoom level, as a number — the one piece of viewport chrome the web
 * lacks. `useViewport` is reactive, so it ticks through a pinch; the
 * percentage is a button that snaps back to 100%, flanked by ± steps.
 */
function ZoomReadout() {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const pct = Math.round(zoom * 100);
  const step =
    "flex h-6 w-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground";
  return (
    <div className="flex items-center">
      <Hint label="Zoom out">
        <button type="button" onClick={() => void rf.zoomOut({ duration: 150 })} className={step}>
          <Minus size={11} />
        </button>
      </Hint>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => void rf.zoomTo(1, { duration: 200 })}
              className="flex h-6 min-w-[38px] cursor-pointer items-center justify-center rounded-md px-1 text-xs tabular-nums text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
            >
              {pct}%
            </button>
          }
        />
        <TooltipContent side="bottom" sideOffset={4}>
          Reset zoom to 100%
        </TooltipContent>
      </Tooltip>
      <Hint label="Zoom in">
        <button type="button" onClick={() => void rf.zoomIn({ duration: 150 })} className={step}>
          <Plus size={11} />
        </button>
      </Hint>
    </div>
  );
}

// ---------------------------------------------------------------------------

const FORMATS: Array<{
  format: ExportFormat;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = [
  { format: "png", label: "PNG", icon: FileImage },
  { format: "jpeg", label: "JPEG", icon: FileImage },
  { format: "svg", label: "SVG", icon: FileType2 },
  { format: "pdf", label: "PDF", icon: FileText },
];

/**
 * One pill: who is here, the web link, and export — divided rather than
 * scattered across the corner. You are always last in the avatar stack; an
 * empty corner reads as "nobody is here", which is never true while you are.
 * Export is desktop-only (the web app has none).
 */
export function SpaceActionPill({
  convId,
  actors,
  following,
  onFollow,
  onBeforeExport,
  containerRef,
}: {
  convId: string;
  actors: ReadonlyMap<string, SpaceActor>;
  /** Whose camera we ride; null when our own. */
  following: string | null;
  onFollow: (id: string | null) => void;
  onBeforeExport: () => void;
  /** This Space's own wrapper — scopes the export to its DOM subtree so the
   * local Canvas tab's `.react-flow__viewport` (or another Space) is never
   * picked up instead. */
  containerRef: RefObject<HTMLElement | null>;
}) {
  const rf = useReactFlow();
  const me = useCommsStore.use.me();
  const members = useCommsStore.use.members();
  const orgId = useCommsStore((s) => s.connection.orgId);
  const memberOf = (id: string) => members.find((m) => m.id === id) ?? null;

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const run = async (format: ExportFormat) => {
    setOpen(false);
    setBusy(format);
    // Deselect so outlines/resize handles don't bleed into the image.
    onBeforeExport();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const container = containerRef.current;
    if (!container) {
      setBusy(null);
      return;
    }
    try {
      const res = await exportCanvas(format, rf, container);
      if (res === "ok") toast.success(`Exported ${format.toUpperCase()}`);
      else if (res === "empty") toast("Nothing to export — the canvas is empty.");
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const openInWeb = () => {
    if (!orgId) {
      toast("Not connected to an organization yet.");
      return;
    }
    const url = `${WEB_ORIGIN}/space/${encodeURIComponent(convId)}?org=${encodeURIComponent(orgId)}`;
    void openUrl(url).catch(() => toast.error("Could not open your browser."));
  };

  const peers = [...actors.values()];
  // Who is riding OUR camera — the `following` field on their awareness.
  const followers = me ? peers.filter((a) => a.following === me) : [];
  const followed = following === null ? null : (actors.get(following) ?? null);
  const nameOf = (a: SpaceActor) => memberOf(a.id)?.name ?? a.name;

  // A one-shot toast the moment a follow begins — the pill is the persistent
  // signal, this is the acknowledgement.
  useEffect(() => {
    if (followed)
      toast(`Following ${nameOf(followed)} — pan or press Esc to stop`, { duration: 2200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following]);

  return (
    <div
      className={cn(
        "absolute right-3 top-3 z-panel flex h-8 items-center gap-1 rounded-xl border border-border-subtle px-1.5",
        "bg-[var(--card)]/70 shadow-md backdrop-blur-2xl",
      )}
    >
      {/* Presence */}
      <div className="flex items-center pr-0.5">
        <div className="flex items-center -space-x-1.5">
          {peers.slice(0, 4).map((a) => {
            const riding = following === a.id;
            return (
              <Tooltip key={a.id}>
                <TooltipTrigger
                  render={
                    /* The avatar IS the follow toggle (the web's roster): one
                      press rides their camera, another hands it back. */
                    <button
                      type="button"
                      aria-pressed={riding}
                      aria-label={`Follow ${nameOf(a)}`}
                      onClick={() => onFollow(riding ? null : a.id)}
                      className={cn(
                        "inline-flex cursor-pointer rounded-full ring-2 transition-transform hover:z-10 hover:scale-110",
                        riding &&
                          "z-10 scale-110 ring-2 ring-primary ring-offset-2 ring-offset-card",
                      )}
                      style={{ ["--tw-ring-color" as string]: a.colour }}
                    >
                      <CommsAvatar member={memberOf(a.id)} size={18} className="rounded-full" />
                    </button>
                  }
                />
                <TooltipContent side="bottom" sideOffset={4}>
                  {riding ? `Stop following ${nameOf(a)}` : `Follow ${nameOf(a)}`}
                </TooltipContent>
              </Tooltip>
            );
          })}
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex">
                  <CommsAvatar
                    member={me ? memberOf(me) : null}
                    size={18}
                    className="rounded-full ring-2 ring-[var(--card)]"
                  />
                </span>
              }
            />
            <TooltipContent side="bottom" sideOffset={4}>
              You
            </TooltipContent>
          </Tooltip>
        </div>
        {peers.length > 4 && (
          <span className="pl-1.5 text-2xs text-muted-foreground">+{peers.length - 4}</span>
        )}
        {followers.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="ml-1.5 flex h-[18px] items-center gap-1 rounded-full bg-[var(--primary)]/15 px-1.5 text-2xs font-medium text-[var(--primary)]">
                  <Eye size={10} />
                  {followers.length}
                </span>
              }
            />
            <TooltipContent side="bottom" sideOffset={4}>
              {followers.length === 1
                ? `${nameOf(followers[0])} is following you`
                : `${followers.length} people are following you`}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="mx-0.5 h-4 w-px bg-border-subtle" />

      <Hint label="Open in web">
        <button
          type="button"
          onClick={openInWeb}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground"
        >
          <ExternalLink size={12} />
        </button>
      </Hint>

      <div className="mx-0.5 h-4 w-px bg-border-subtle" />

      <Popover.Root open={open} onOpenChange={setOpen}>
        <Hint label="Export canvas">
          <Popover.Trigger
            render={
              <button
                type="button"
                disabled={!!busy}
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground disabled:opacity-60"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              </button>
            }
          />
        </Hint>
        <Popover.Portal>
          <Popover.Positioner className="z-popover" align="end" sideOffset={6}>
            <Popover.Popup className="atlas-panel-in-tl inset-highlight shadow-md select-none overflow-hidden rounded-xl border border-border-subtle bg-[var(--card)]/95 backdrop-blur-2xl">
              <div className="flex w-[140px] flex-col py-1">
                {FORMATS.map((f) => (
                  <button
                    key={f.format}
                    type="button"
                    onClick={() => void run(f.format)}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-secondary-foreground transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-foreground"
                  >
                    <f.icon size={12} className="shrink-0 text-muted-foreground" />
                    {f.label}
                  </button>
                ))}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
