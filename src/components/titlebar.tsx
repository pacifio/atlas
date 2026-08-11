import { useState, useEffect, useRef, useCallback } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { useNotificationsStore } from "@/features/notifications/stores/notifications-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import {
  PanelLeft,
  PanelRight,
  Bell,
  Layers,
  ArrowDownToLine,
  Loader2,
  Hammer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { Window as TauriWindow } from "@tauri-apps/api/window";
import { useUpdaterStore } from "@/features/updater/stores/updater-store";
import { updater } from "@/features/updater/lib/updater-api";
import { AccountButton } from "@/features/auth/components/account-button";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { CapturePopover } from "@/features/capture/components/capture-popover";
import { StatusDot } from "@/features/capture/components/capture-status";
import type { Binding, CaptureHealth } from "@/features/capture/types";
import { activeWorkspaceId } from "@/features/workspaces/lib/active-workspace";
import { isDev } from "@/lib/env";

function useTauriWindow() {
  const windowRef = useRef<TauriWindow | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        windowRef.current = win;
        setIsFullscreen(await win.isFullscreen());
        unlisten = await win.onResized(async () => {
          setIsFullscreen(await win.isFullscreen());
        });
      } catch {
        // not in Tauri context
      }
    })();

    return () => unlisten?.();
  }, []);

  return { windowRef, isFullscreen };
}

export function Titlebar() {
  const currentProject = useProjectStore.use.currentProject();
  // The label name is read from the WORKSPACE store (matched by path), not from
  // `currentProject.name`. `currentProject` only re-syncs after a slow Rust
  // AppState round-trip, so a workspace rename took ~3-4s to show here; the
  // workspace store mutates synchronously on rename, so this updates instantly.
  const workspaces = useWorkspaceStore.use.workspaces();
  // Owning organisation, for the `org / project` pill. Read live so an org
  // switch or rename re-labels immediately.
  const organisations = useOrgStore.use.organisations();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  const orgName = organisations.find((o) => o.id === activeOrganisationId)?.name ?? null;
  const displayName =
    (currentProject ? workspaces.find((w) => w.path === currentProject.path)?.name : undefined) ??
    currentProject?.name ??
    "Atlas";
  const { windowRef, isFullscreen } = useTauriWindow();
  // The titlebar reserves 72px for the OS window controls (traffic lights),
  // EXCEPT when the sidebar is DOCKED (pinned + open): the docked column then
  // sits under the lights and carries that gap itself, so the titlebar reclaims
  // the space. Fullscreen hides the lights entirely. (Unpinned overlay mode
  // doesn't occupy flow width, so it never affects this.)
  const sidebarPinned = useWorkspaceStore.use.sidebarPinned();
  const sidebarOpen = useWorkspaceStore.use.sidebarOpen();
  const dockedSidebar = sidebarPinned && sidebarOpen;

  const isTitlebarSurface = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    return !el?.closest("button, a, input, select, textarea, [role='menuitem']");
  };

  // Drag the window manually (the `data-tauri-drag-region` CSS hook
  // doesn't work in this app — see memory). Calling `startDragging()`
  // straight from mousedown hands the event stream to the OS drag
  // session and swallows the double-click, so instead we only begin the
  // drag once the pointer actually moves past a small threshold. A
  // stationary click / double-click then flows through to onDoubleClick.
  const handleDrag = (e: React.MouseEvent) => {
    if (e.button !== 0 || !isTitlebarSurface(e.target)) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: MouseEvent) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) {
        cleanup();
        void windowRef.current?.startDragging();
      }
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", cleanup);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", cleanup);
  };

  // macOS double-click-to-zoom. Tauri's `toggleMaximize()` doesn't map to
  // AppKit's zoom, so we call a native `performZoom:` command instead.
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!isTitlebarSurface(e.target)) return;
    void invoke("window_zoom").catch(() => {});
  };

  return (
    <div
      onMouseDown={handleDrag}
      onDoubleClick={handleDoubleClick}
      className={`relative z-50 flex h-[30px] select-none items-center pr-3 bg-[var(--bg-base)] border-b border-border-default ${isFullscreen || dockedSidebar ? "pl-3" : "pl-[72px]"}`}
    >
      <div className="flex h-[30px] min-w-0 flex-1 items-center gap-1.5">
        <WorkspaceToggle />
        {currentProject && <LeftPanelToggle />}
        {/* `org / project` pill — click to copy the workspace path. */}
        <ProjectLabel name={displayName} orgName={orgName} path={currentProject?.path} />
      </div>

      {/* The account button sits OUTSIDE the `currentProject` guard on purpose:
          a fresh install has no project open, and sign-in must be reachable
          from that empty state rather than hidden behind opening a folder. */}
      <div className="flex items-center gap-1.5">
        {/* Dev-mode flag lives outside the `currentProject` guard too — it's
            a build/runtime indicator, not project-dependent. */}
        <DevModePill />
        {currentProject && (
          <>
            <UpdateButton />
            <NotificationButton />
            <RightPanelToggle />
            {/* Separates the app-level actions from the account. Lives inside
                the same guard so it never floats alone with no icons beside
                it (empty state = account button only). */}
            <div className="mx-0.5 h-4 w-px bg-border-default" aria-hidden />
          </>
        )}
        <AccountButton />
      </div>
    </div>
  );
}

/**
 * The titlebar project label — `org / project`, with the capture dot.
 *
 * Clicking it opens capture setup. It used to copy the workspace path and show
 * a hover tooltip of that path; both are gone, because the click now opens a
 * panel and a tooltip that fires every time you approach that panel is noise in
 * front of it. It stays a <button> (not a span) so the titlebar's
 * drag/double-click-zoom handlers skip it — see `isTitlebarSurface`.
 */
function ProjectLabel({
  name,
  orgName,
  path,
}: {
  name: string;
  orgName?: string | null;
  path?: string;
}) {
  const [captureOpen, setCaptureOpen] = useState(false);
  const [binding, setBinding] = useState<Binding | null>(null);
  const [health, setHealth] = useState<CaptureHealth | null>(null);

  // Capture state for the dot, re-read when the popover changes something.
  const readCapture = useCallback(() => {
    if (!path) {
      setBinding(null);
      setHealth(null);
      return;
    }
    void invoke<Binding | null>("capture_binding", { projectPath: path })
      .then(setBinding)
      .catch(() => setBinding(null));
    void invoke<CaptureHealth>("capture_health", {
      projectPath: path,
      workspaceId: activeWorkspaceId(),
    })
      .then(setHealth)
      .catch(() => setHealth(null));
  }, [path]);

  useEffect(() => readCapture(), [readCapture]);

  return (
    <div className="relative min-w-0">
      {/* Pill: `org / project`. The org segment is de-emphasised so the project
          — the thing that changes most — still reads as the primary label.

          Clicking it opens capture setup. Capture is per project, and this is
          the one control in the app that always names the project it would
          apply to — which the Timeline board, spanning every project, cannot. */}
      <Popover.Root open={captureOpen} onOpenChange={setCaptureOpen}>
        <Popover.Trigger asChild>
          <button
            // `leading-none` is what actually centres the capture dot: with the
            // inherited line-height the label spans set a taller line box than
            // the dot, and `items-center` centred the dot against *that* — which
            // is why it sat visibly high.
            className="group flex h-[19px] max-w-[320px] min-w-0 cursor-pointer items-center gap-1 rounded-full border border-[#303030] bg-[#0C0C0C] px-2 text-[11px] leading-none font-medium transition-colors hover:bg-[#1f1f1f]"
            title={health?.summary ?? "Session capture"}
          >
            {orgName && (
              <>
                <span className="min-w-0 shrink truncate text-[var(--text-tertiary)]">
                  {orgName}
                </span>
                <span className="shrink-0 text-[var(--text-tertiary)] opacity-50">/</span>
              </>
            )}
            <span className="min-w-0 truncate text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text-primary)]">
              {name}
            </span>
            {/* Only once capture is on. An always-present grey dot on every
                project reads as a defect indicator rather than a state. */}
            {binding?.enabled && <StatusDot binding={binding} health={health} />}
          </button>
        </Popover.Trigger>
        {path && (
          <Popover.Portal>
            <Popover.Content
              side="bottom"
              align="start"
              sideOffset={6}
              // Enter is animated by the panel itself (`atlas-panel-in-tl`), not
              // here: this wrapper would hold a transform for the duration, and
              // a transformed ancestor becomes the backdrop root — which
              // flattens the panel's blur while it plays. Exit stays here
              // because Radix needs the animation on the element it unmounts.
              className="z-[var(--z-max)] origin-[var(--radix-popover-content-transform-origin)] data-[state=closed]:animate-scale-out"
            >
              <CapturePopover
                projectPath={path}
                health={health}
                onChanged={readCapture}
                onClose={() => setCaptureOpen(false)}
              />
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>
    </div>
  );
}

/**
 * Same pill shape and fill as `ProjectLabel`, just with a deep-purple border
 * instead of the neutral one, shown only when the app is running via
 * `bun run dev:app` specifically. `isDev` alone also matches `bun run dev`
 * (Vite-only, no Tauri shell, where `invoke()` doesn't work) — `isTauri()`
 * narrows to an actual Tauri window, so the two together are true only for
 * the real `tauri dev` session this pill is meant to flag.
 */
function DevModePill() {
  if (!isDev || !isTauri()) return null;
  return (
    <div
      className="flex h-[19px] shrink-0 items-center gap-1 rounded-full border border-[#5b21b6] bg-[#0C0C0C] px-2 text-[11px] leading-none font-medium text-[var(--text-secondary)]"
      title="Running via `bun run dev:app`"
    >
      <Hammer size={11} />
      Dev Mode
    </div>
  );
}

function WorkspaceToggle() {
  const sidebarOpen = useWorkspaceStore.use.sidebarOpen();
  const { toggleSidebar } = useWorkspaceStore.use.actions();
  const count = useWorkspaceStore.use.workspaces().length;

  return (
    <button
      onClick={toggleSidebar}
      className={cn(
        "relative flex items-center justify-center w-6 h-6 rounded hover:bg-[#ffffff08] transition-all duration-150",
        sidebarOpen ? "text-[#ccc]" : "text-[#555] hover:text-[#aaa]",
      )}
      title={sidebarOpen ? "Hide workspaces (⌘⇧.)" : "Show workspaces (⌘⇧.)"}
    >
      <Layers size={14} />
      {count > 1 && (
        <span className="absolute -bottom-0.5 -right-0.5 text-[7px] font-mono text-white">
          {count}
        </span>
      )}
    </button>
  );
}

function LeftPanelToggle() {
  const leftPanel = useLayoutStore.use.leftPanel();
  const { toggleLeftPanel } = useLayoutStore.use.actions();

  return (
    <button
      onClick={toggleLeftPanel}
      className="flex items-center justify-center w-6 h-6 rounded text-[#555] hover:text-[#aaa] hover:bg-[#ffffff08] transition-all duration-150"
      title={leftPanel.visible ? "Hide left panel" : "Show left panel"}
    >
      <PanelLeft size={14} className={leftPanel.visible ? "" : "opacity-40"} />
    </button>
  );
}

/** Tiny determinate ring for the titlebar download indicator. */
function ArcProgress({ value }: { value: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(1, value)));
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" className="-rotate-90">
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeWidth={2}
      />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeDasharray={c}
        strokeDashoffset={off}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Titlebar auto-update indicator. Idle → a down-arrow that triggers a manual
 * "check for updates". While the backend checks → spinner. While the update
 * downloads in the background → an arc showing progress. Once staged and ready
 * → a badge dot; clicking reopens the "Restart to update" prompt. All state is
 * driven by the `atlas:update-*` events → updater store (fully non-blocking).
 */
function UpdateButton() {
  const checking = useUpdaterStore.use.checking();
  const phase = useUpdaterStore.use.phase();
  const progress = useUpdaterStore.use.progress();
  const { openModal } = useUpdaterStore.use.actions();

  const downloading = phase === "downloading";
  const ready = phase === "ready" || phase === "applying";

  const onClick = () => {
    if (checking || downloading) return;
    if (ready) {
      openModal();
      return;
    }
    void updater
      .checkNow()
      .then((status) => {
        if (!status.available) {
          toast.success(`You're on the latest version (${status.currentVersion}).`);
        }
      })
      .catch((e) =>
        toast.error(`Update check failed: ${e instanceof Error ? e.message : String(e)}`),
      );
  };

  const title = checking
    ? "Checking for updates…"
    : downloading
      ? progress != null
        ? `Downloading update… ${Math.round(progress * 100)}%`
        : "Preparing update…"
      : ready
        ? "Update ready — click to restart"
        : "Check for updates";

  return (
    <button
      onClick={onClick}
      disabled={checking || downloading}
      className={cn(
        "relative flex items-center justify-center w-6 h-6 rounded hover:bg-[#ffffff08] transition-all duration-150 outline-none focus:outline-none",
        ready || downloading ? "text-[#ccc]" : "text-[#555] hover:text-[#aaa]",
      )}
      title={title}
    >
      {checking ? (
        <Loader2 size={14} className="animate-spin" />
      ) : downloading ? (
        progress != null ? (
          <ArcProgress value={progress} />
        ) : (
          <Loader2 size={14} className="animate-spin" />
        )
      ) : (
        <ArrowDownToLine size={14} />
      )}
      {ready && (
        <span
          className="absolute -top-[1px] -right-[1px] w-[7px] h-[7px] rounded-full bg-[var(--accent-primary)] ring-1 ring-[var(--bg-base)] pointer-events-none"
          aria-label="Update ready"
        />
      )}
    </button>
  );
}

function NotificationButton() {
  const { toggle } = useNotificationsStore.use.actions();
  // Select PRIMITIVES (booleans) — returning a filtered array from the selector
  // would create a new reference every render and trigger an infinite loop.
  const hasUnread = useNotificationsStore((s) => s.items.some((i) => !i.read));
  const hasError = useNotificationsStore((s) =>
    s.items.some((i) => !i.read && (i.kind === "agent-failed" || i.kind === "chat-error")),
  );
  // LIVE attention state: any session (any workspace) blocked on a permission
  // decision. Derived from the chat store rather than unread flags so it shows
  // even after the panel was opened, and clears itself the moment the prompt
  // is answered.
  const needsAttention = useChatStore((s) =>
    Object.values(s.pendingPermissions).some((reqs) => reqs.length > 0),
  );

  return (
    <button
      onClick={toggle}
      className="relative flex items-center justify-center w-6 h-6 rounded text-[#555] hover:text-[#aaa] hover:bg-[#ffffff08] transition-all duration-150 outline-none focus:outline-none"
      title="Notifications"
    >
      <Bell size={14} />
      {(hasUnread || needsAttention) && (
        <span
          className={cn(
            "absolute -top-[1px] -right-[1px] w-[7px] h-[7px] rounded-full ring-1 ring-[var(--bg-base)] pointer-events-none",
            // Priority: error > needs-attention (green) > plain unread.
            hasError
              ? "bg-[var(--status-error)]"
              : needsAttention
                ? "bg-[var(--status-success)] animate-pulse"
                : "bg-white",
          )}
          aria-label={needsAttention ? "An agent needs your attention" : "Unread notifications"}
        />
      )}
    </button>
  );
}

function RightPanelToggle() {
  const rightPanel = useLayoutStore.use.rightPanel();
  const { toggleRightPanel } = useLayoutStore.use.actions();

  return (
    <button
      onClick={toggleRightPanel}
      className="flex items-center justify-center w-6 h-6 rounded text-[#555] hover:text-[#aaa] hover:bg-[#ffffff08] transition-all duration-150"
      title={rightPanel.visible ? "Hide right panel" : "Show right panel"}
    >
      <PanelRight size={14} className={rightPanel.visible ? "" : "opacity-40"} />
    </button>
  );
}
