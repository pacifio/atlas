import { useState } from "react";
import { useReactFlow } from "@xyflow/react";
import * as Popover from "@radix-ui/react-popover";
import {
  ChevronDown,
  Crosshair,
  Download,
  ExternalLink,
  FileImage,
  FileText,
  FileType2,
  Loader2,
  PanelLeft,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
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
      <TooltipTrigger asChild>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {sync === "syncing" ? (
            <Loader2 size={11} className="animate-spin text-text-tertiary" />
          ) : (
            <span
              className={cn(
                "h-[7px] w-[7px] rounded-full",
                sync === "synced" ? "bg-[#22c55e]" : "bg-[var(--status-error,#f66)]",
              )}
            />
          )}
        </span>
      </TooltipTrigger>
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
        "absolute left-3 top-3 z-20 flex items-center gap-1.5 py-1 pl-1 pr-1",
        "rounded-xl border border-white/10 bg-[var(--bg-secondary)]/70 shadow-[var(--shadow-overlay)] backdrop-blur-2xl",
      )}
    >
      <button
        type="button"
        onClick={onTogglePages}
        title={pagesOpen ? "Hide pages" : "Show pages"}
        className={cn(
          "flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition-colors",
          pagesOpen
            ? "bg-bg-selected text-text-primary"
            : "text-text-tertiary hover:bg-bg-hover hover:text-text-primary",
        )}
      >
        <PanelLeft size={13} />
      </button>
      <div className="mx-0.5 h-4 w-px bg-white/10" />

      {/* The page name is the shorthand page selector — the dock is the long
          way round, and a canvas is usually two clicks from another page. */}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            title="Switch page"
            className="flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1 transition-colors hover:bg-bg-hover"
          >
            <SyncDot sync={sync} />
            <span className="max-w-[180px] truncate text-[12px] font-semibold text-text-primary">
              {active?.name || "Space"}
            </span>
            <ChevronDown size={11} className="shrink-0 text-text-tertiary" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            style={{
              zIndex: 9999,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.95)",
            }}
            className="atlas-panel-in-tl select-none overflow-hidden rounded-xl border border-white/10 bg-[var(--bg-elevated)]/85 backdrop-blur-2xl"
          >
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
                    "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-[var(--bg-hover)]",
                    p.id === activePageId ? "text-text-primary" : "text-text-secondary",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{p.name || "Untitled"}</span>
                  {p.id === activePageId && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent-primary)]" />
                  )}
                </button>
              ))}
              {selectable.length === 0 && (
                <div className="px-3 py-2 text-[10px] text-text-tertiary">No pages yet.</div>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <div className="mx-0.5 h-4 w-px bg-white/10" />
      <button
        type="button"
        onClick={() => rf.fitView({ duration: 350, padding: 0.2 })}
        title="Fit to view"
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        <Crosshair size={12} />
      </button>
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
  onBeforeExport,
}: {
  convId: string;
  actors: ReadonlyMap<string, SpaceActor>;
  onBeforeExport: () => void;
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
    try {
      const res = await exportCanvas(format, rf);
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
      toast("Not connected to an organisation yet.");
      return;
    }
    const url = `${WEB_ORIGIN}/space/${encodeURIComponent(convId)}?org=${encodeURIComponent(orgId)}`;
    void openUrl(url).catch(() => toast.error("Could not open your browser."));
  };

  const peers = [...actors.values()];

  return (
    <div
      className={cn(
        "absolute right-3 top-3 z-40 flex h-8 items-center gap-1 rounded-xl border border-white/10 px-1.5",
        "bg-[var(--bg-secondary)]/70 shadow-[var(--shadow-overlay)] backdrop-blur-2xl",
      )}
    >
      {/* Presence */}
      <div className="flex items-center pr-0.5">
        <div className="flex items-center -space-x-1.5">
          {peers.slice(0, 4).map((a) => (
            <Tooltip key={a.id}>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex rounded-full ring-2"
                  style={{ ["--tw-ring-color" as string]: a.colour }}
                >
                  <CommsAvatar member={memberOf(a.id)} size={18} className="rounded-full" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {memberOf(a.id)?.name ?? a.name} · here
              </TooltipContent>
            </Tooltip>
          ))}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <CommsAvatar
                  member={me ? memberOf(me) : null}
                  size={18}
                  className="rounded-full ring-2 ring-[var(--bg-secondary)]"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              You
            </TooltipContent>
          </Tooltip>
        </div>
        {peers.length > 4 && (
          <span className="pl-1.5 text-[9.5px] text-text-tertiary">+{peers.length - 4}</span>
        )}
      </div>

      <div className="mx-0.5 h-4 w-px bg-white/10" />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={openInWeb}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <ExternalLink size={12} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          Open in web
        </TooltipContent>
      </Tooltip>

      <div className="mx-0.5 h-4 w-px bg-white/10" />

      <Popover.Root open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Popover.Trigger asChild>
              <button
                type="button"
                disabled={!!busy}
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-60"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              </button>
            </Popover.Trigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            Export canvas
          </TooltipContent>
        </Tooltip>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            style={{
              zIndex: 9999,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.95)",
            }}
            className="atlas-panel-in-tl select-none overflow-hidden rounded-xl border border-white/10 bg-[var(--bg-elevated)]/85 backdrop-blur-2xl"
          >
            <div className="flex w-[140px] flex-col py-1">
              {FORMATS.map((f) => (
                <button
                  key={f.format}
                  type="button"
                  onClick={() => void run(f.format)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[11px] text-text-secondary transition-colors hover:bg-[var(--bg-hover)] hover:text-text-primary"
                >
                  <f.icon size={12} className="shrink-0 text-text-tertiary" />
                  {f.label}
                </button>
              ))}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
