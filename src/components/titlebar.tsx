import { useState, useEffect, useRef, useCallback } from "react";
import { RailGlyph } from "@/ui/animated-icon";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { Popover } from "@base-ui/react/popover";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import {
  useNotificationsStore,
  hasUnread,
  isErrorKind,
} from "@/features/notifications/stores/notifications-store";
import {
  useTerminalAttention,
  anyTerminalNeedsAttention,
} from "@/features/terminal/lib/terminal-notifier";
import { useChatStore } from "@/features/chat/stores/chat-store";
import {
  PanelRight,
  Bell,
  Layers,
  ArrowDownToLine,
  Loader2,
  Hammer,
  Minus,
  Square,
  Copy,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppProfile } from "@/lib/app-profile";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { TitlebarDock, type DockItem } from "./titlebar-dock";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { Window as TauriWindow } from "@tauri-apps/api/window";
import { useUpdaterStore } from "@/features/updater/stores/updater-store";
import { updater } from "@/features/updater/lib/updater-api";
import { AccountButton } from "@/features/auth/components/account-button";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { CapturePopover } from "@/features/capture/components/capture-popover";
import { StatusDot } from "@/features/capture/components/capture-status";
import type { Binding, CaptureHealth } from "@/features/capture/types";
import { activeProjectId } from "@/features/projects/lib/active-project";
import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { isDev } from "@/lib/env";
import { isLinux, isMac, isWindows } from "@/lib/platform";

/**
 * A handle on the native window, for dragging and zooming.
 *
 * Fullscreen is **not** tracked here: it used to be, with its own copy of the
 * `onResized` + `await isFullscreen()` dance that `useFullscreen` already had.
 * Two copies of that logic is how the titlebar and the sidebar came to disagree
 * about where the traffic lights were, and the race that made it stick is
 * written up in `use-fullscreen.ts`.
 */
function useTauriWindow() {
  const windowRef = useRef<TauriWindow | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        windowRef.current = getCurrentWindow();
      } catch {
        // not in Tauri context
      }
    })();
  }, []);

  return { windowRef };
}

export function Titlebar() {
  const currentProject = useAppStore.use.currentProject();
  // The label name is read from the PROJECT store (matched by path), not from
  // `currentProject.name`. `currentProject` only re-syncs after a slow Rust
  // AppState round-trip, so a project rename took ~3-4s to show here; the
  // project store mutates synchronously on rename, so this updates instantly.
  const projects = useProjectStore.use.projects();
  // Owning organisation, for the `org / project` pill. Read live so an org
  // switch or rename re-labels immediately.
  const organisations = useOrgStore.use.organisations();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  const orgName = organisations.find((o) => o.id === activeOrganisationId)?.name ?? null;
  // Same path can be a project in several orgs — prefer the ACTIVE org's
  // twin so a rename in another org never re-labels this titlebar.
  // With no project open the label is the product: `Atlas`, or `Atlas Dev`
  // for a dev-profile build, so the two windows can be told apart.
  const { productName } = useAppProfile();
  const displayName =
    (currentProject
      ? projects.find((w) => w.path === currentProject.path && w.orgId === activeOrganisationId)
          ?.name
      : undefined) ??
    (currentProject ? projects.find((w) => w.path === currentProject.path)?.name : undefined) ??
    currentProject?.name ??
    productName;
  const { windowRef } = useTauriWindow();
  // The same hook the project sidebar reads, so the two cannot disagree about
  // whether the traffic lights are on screen.
  const isFullscreen = useFullscreen();
  // The titlebar reserves 72px for the OS window controls (traffic lights),
  // EXCEPT when the sidebar is DOCKED (pinned + open): the docked column then
  // sits under the lights and carries that gap itself, so the titlebar reclaims
  // the space. Fullscreen hides the lights entirely. (Unpinned overlay mode
  // doesn't occupy flow width, so it never affects this.) Only macOS has
  // traffic lights on the left; Windows and Linux get `WindowControls` on the right.
  const sidebarPinned = useProjectStore.use.sidebarPinned();
  const sidebarOpen = useProjectStore.use.sidebarOpen();
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
  // AppKit's zoom, so we call a native `performZoom:` command instead. It does
  // map to maximize on Windows and Linux, which is the convention there.
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!isTitlebarSurface(e.target)) return;
    if (isMac) void invoke("window_zoom").catch(() => {});
    else void windowRef.current?.toggleMaximize();
  };

  return (
    <div
      onMouseDown={handleDrag}
      onDoubleClick={handleDoubleClick}
      className={cn(
        "relative z-titlebar flex h-titlebar select-none items-center bg-[var(--background)] border-b border-border",
        isWindows || isLinux ? "pr-0" : "pr-3",
        isFullscreen || dockedSidebar || !isMac ? "pl-3" : "pl-[72px]",
      )}
    >
      <div className="flex h-titlebar min-w-0 flex-1 items-center gap-1.5">
        <HintGroup>
          <ProjectToggle />
          {currentProject && <LeftPanelToggle />}
        </HintGroup>
        {/* `org / project` pill — click to copy the project path. */}
        <ProjectLabel name={displayName} orgName={orgName} path={currentProject?.path} />
      </div>

      {/* Dev-mode flag — centered in the titlebar, outside both flex groups.
          It's a build/runtime indicator, not project-dependent, and it takes
          no pointer events so window dragging works straight through it. */}
      <DevModePill />

      {/* The account button sits OUTSIDE the `currentProject` guard on purpose:
          a fresh install has no project open, and sign-in must be reachable
          from that empty state rather than hidden behind opening a folder. */}
      {/* One dock, account included. Without a project there are no app-level
          actions to gather, so the account stands alone as it always has —
          signing in has to be reachable from an empty window. */}
      {currentProject ? (
        <ActionDock />
      ) : (
        <div className="flex items-center">
          <AccountButton />
        </div>
      )}

      {(isWindows || isLinux) && <WindowControls />}
    </div>
  );
}

/**
 * Minimize / maximize / close. Windows and Linux: the window there is undecorated
 * (`src-tauri/tauri.windows.conf.json`, `src-tauri/tauri.linux.conf.json`), so this
 * titlebar is the only chrome, whereas macOS keeps its native traffic lights in
 * the overlay title bar.
 */
function WindowControls() {
  const windowRef = useRef<TauriWindow | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        windowRef.current = win;
        setIsMaximized(await win.isMaximized());
        unlisten = await win.onResized(async () => {
          setIsMaximized(await win.isMaximized());
        });
      } catch {
        // not in Tauri context
      }
    })();

    return () => unlisten?.();
  }, []);

  const button =
    "flex h-[29px] w-[46px] items-center justify-center text-muted-foreground transition-colors duration-100";

  return (
    <HintGroup>
      <div className="ml-2 flex h-[29px] items-center self-start">
        <HintItem label="Minimize">
          <button
            onClick={() => void windowRef.current?.minimize()}
            className={cn(button, "hover:bg-element-hover hover:text-foreground")}
          >
            <Minus size={14} strokeWidth={1.25} />
          </button>
        </HintItem>
        <HintItem label={isMaximized ? "Restore" : "Maximize"}>
          <button
            onClick={() => void windowRef.current?.toggleMaximize()}
            className={cn(button, "hover:bg-element-hover hover:text-foreground")}
          >
            {isMaximized ? (
              <Copy size={11} strokeWidth={1.25} className="-scale-x-100" />
            ) : (
              <Square size={11} strokeWidth={1.25} />
            )}
          </button>
        </HintItem>
        <HintItem label="Close">
          <button
            onClick={() => void windowRef.current?.close()}
            // ratchet-allow: Windows' own close-button red, fixed by the platform.
            className={cn(button, "hover:bg-[#c42b1c] hover:text-white")}
          >
            <X size={15} strokeWidth={1.25} />
          </button>
        </HintItem>
      </div>
    </HintGroup>
  );
}

/**
 * The titlebar's action dock.
 *
 * A component rather than three inlined hook calls so the hooks' subscriptions
 * — updater phase, notification counts, right-panel visibility — re-render
 * this and nothing else. Put them in `Titlebar` itself and every notification
 * would re-render the project label and the org switcher beside it.
 */
function ActionDock() {
  const update = useUpdateItem();
  const notifications = useNotificationItem();
  const rightPanel = useRightPanelItem();
  return (
    <TitlebarDock
      items={[update, notifications, rightPanel]}
      trailing={{ label: "Account and settings", node: <AccountButton compact /> }}
    />
  );
}

/**
 * The titlebar project label — `org / project`, with the capture dot.
 *
 * Clicking it opens capture setup. It used to copy the project path and show
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
      workspaceId: activeProjectId(),
    })
      .then(setHealth)
      .catch(() => setHealth(null));
  }, [path]);

  useEffect(() => readCapture(), [readCapture]);

  // Fresh numbers whenever the popover is looked at. Health was otherwise read
  // on project switch and after a popover action only — so right after Promote
  // it captured the instant every row had just been queued, and "93 pending —
  // sends when online" stayed on screen long after the drain had sent them
  // all. While open, capture writes (sends included) re-read it too.
  useEffect(() => {
    if (!captureOpen || !isTauri()) return;
    readCapture();
    const unlisten = listen("atlas:capture-changed", () => readCapture());
    return () => void unlisten.then((stop) => stop());
  }, [captureOpen, readCapture]);

  // Command palette + ⌘⌥C both open this popover from outside the component
  // tree, since `captureOpen` is local state — see `atlas:open-capture`.
  useEffect(() => {
    const onOpenCapture = () => setCaptureOpen(true);
    window.addEventListener("atlas:open-capture", onOpenCapture);
    return () => window.removeEventListener("atlas:open-capture", onOpenCapture);
  }, []);

  return (
    <div className="relative min-w-0">
      {/* Pill: `org / project`. The org segment is de-emphasised so the project
          — the thing that changes most — still reads as the primary label.

          Clicking it opens capture setup. Capture is per project, and this is
          the one control in the app that always names the project it would
          apply to — which the Timeline board, spanning every project, cannot. */}
      <Popover.Root open={captureOpen} onOpenChange={setCaptureOpen}>
        <Popover.Trigger
          render={
            <button
              // `leading-none` is what actually centres the capture dot: with the
              // inherited line-height the label spans set a taller line box than
              // the dot, and `items-center` centred the dot against *that* — which
              // is why it sat visibly high.
              className="group flex h-[19px] max-w-[320px] min-w-0 cursor-pointer items-center gap-1 rounded-full border border-border-subtle bg-card px-2 text-xs leading-none font-medium transition-colors hover:bg-element-hover"
              title={health?.summary ?? "Session capture"}
              aria-label={health?.summary ?? "Session capture"}
            >
              {orgName && (
                <>
                  <span className="min-w-0 shrink truncate text-[var(--muted-foreground)]">
                    {orgName}
                  </span>
                  <span className="shrink-0 text-[var(--muted-foreground)] opacity-50">/</span>
                </>
              )}
              <span className="min-w-0 truncate text-[var(--secondary-foreground)] transition-colors group-hover:text-[var(--foreground)]">
                {name}
              </span>
              {/* Only once capture is on. An always-present grey dot on every
                project reads as a defect indicator rather than a state. */}
              {binding?.enabled && <StatusDot binding={binding} health={health} />}
            </button>
          }
        />
        {path && (
          <Popover.Portal>
            <Popover.Positioner className="z-popover" side="bottom" align="start" sideOffset={6}>
              <Popover.Popup
                // Enter is animated by the panel itself (`atlas-panel-in-tl`), not
                // here: this wrapper would hold a transform for the duration, and
                // a transformed ancestor becomes the backdrop root — which
                // flattens the panel's blur while it plays. Exit stays here
                // because Base UI holds the popup mounted through it.
                className="origin-[var(--transform-origin)] data-closed:animate-scale-out"
              >
                <CapturePopover
                  projectPath={path}
                  health={health}
                  onChanged={readCapture}
                  onClose={() => setCaptureOpen(false)}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        )}
      </Popover.Root>
    </div>
  );
}

/**
 * A glossy blue capsule, shown only when the app is running via
 * `bun run dev:app` specifically. `isDev` alone also matches `bun run dev`
 * (Vite-only, no Tauri shell, where `invoke()` doesn't work) — `isTauri()`
 * narrows to an actual Tauri window, so the two together are true only for
 * the real `tauri dev` session this pill is meant to flag.
 *
 * The one saturated element in a monochrome titlebar, which is the point: it
 * must be impossible to mistake a dev window for the shipped app. Blue rather
 * than the old purple because purple appears nowhere else in Atlas, while blue
 * is already the app's informational hue (`--atlas-status-info-foreground`).
 *
 * Built from three stacked layers rather than a flat fill — a vertical
 * gradient body, a blurred crown highlight, and an inset rim — so it reads as
 * a lit physical capsule at 20px instead of a coloured rectangle. All of it is
 * static paint: no transitions, no hover, no transform. It's an indicator, not
 * a control, so it takes no pointer events and never moves.
 */
/**
 * The dev-build badge's paint.
 *
 * Deliberately outside the theme: this capsule exists to say "you are not
 * looking at a release build", and a badge that took on the colours of
 * whatever theme is active would say it more quietly the better the theme
 * fits. It is also dev-only — `DevModePill` returns null in a release build —
 * so nothing a user sees depends on any of it.
 */
// ratchet-allow: the dev-build badge is meant to look alien to the theme.
const DEV_PILL_FILL = "linear-gradient(to bottom, #3b82f6, #2563eb)";
const DEV_PILL_GLOW =
  // ratchet-allow: the glow belongs to the dev-badge blue above it.
  "0 1px 5px 0 rgba(37,99,235,0.35), 0 1px 0 0 rgba(255,255,255,0.25) inset, 0 -2px 6px 0 rgba(37,99,235,0.5) inset";
const DEV_PILL_CROWN =
  // ratchet-allow: the crown highlight on that same capsule, not app chrome.
  "linear-gradient(180deg, rgba(255,255,255,0.25) 0%, rgba(255,255,255,0) 80%, transparent 100%)";
const DEV_PILL_RIM =
  // ratchet-allow: the rim on that same capsule, sized to the blue underneath.
  "0 0 0 1px rgba(255,255,255,0.10) inset, 0 1px 0 0 rgba(255,255,255,0.18) inset";

function DevModePill() {
  if (!isDev || !isTauri()) return null;
  return (
    // Dead-center of the titlebar, independent of how the left/right icon
    // groups grow. `pointer-events-none` keeps the strip fully draggable —
    // it's an indicator, not a control (which also retires its old divider).
    <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
      <div
        // ratchet-allow: the label on the dev-build capsule, whose fill is the
        // fixed blue above — it is an out-of-band marker that must look the same
        // in every theme, which is the whole point of it.
        className="relative flex h-5 shrink-0 items-center gap-1 overflow-hidden rounded-full px-2 text-xs leading-none font-medium text-white"
        style={{ background: DEV_PILL_FILL, boxShadow: DEV_PILL_GLOW }}
      >
        {/* Crown highlight — the light source. Blurred so its lower edge melts
          into the body instead of banding across the glyphs. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 z-0 h-2/5 w-4/5 -translate-x-1/2 rounded-t-full"
          style={{ background: DEV_PILL_CROWN, filter: "blur(1px)" }}
        />
        {/* Rim — keeps the capsule's edge legible against the black titlebar. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 rounded-full"
          style={{ boxShadow: DEV_PILL_RIM }}
        />
        <Hammer size={11} className="relative z-10" />
        <span className="relative z-10">Dev Mode</span>
      </div>
    </div>
  );
}

function ProjectToggle() {
  const hint = useActionShortcut("workspace.toggleSidebar")?.label;
  const suffix = hint ? ` (${hint})` : "";
  const sidebarOpen = useProjectStore.use.sidebarOpen();
  const { toggleSidebar } = useProjectStore.use.actions();
  // Badge counts only the active org's projects (matches what the sidebar
  // it toggles will actually show).
  const count = useActiveOrgProjects().length;

  return (
    <HintItem label={sidebarOpen ? `Hide projects${suffix}` : `Show projects${suffix}`}>
      <button
        onClick={toggleSidebar}
        className={cn(
          "relative flex items-center justify-center w-6 h-6 rounded hover:bg-element-hover transition-all duration-150",
          sidebarOpen ? "text-foreground" : "text-muted-foreground hover:text-secondary-foreground",
        )}
        aria-label={sidebarOpen ? "Hide projects" : "Show projects"}
      >
        <Layers size={14} />
        {count > 1 && (
          <span className="absolute -bottom-0.5 -right-0.5 text-3xs font-mono text-foreground">
            {count}
          </span>
        )}
      </button>
    </HintItem>
  );
}

function LeftPanelToggle() {
  const leftPanel = useLayoutStore.use.leftPanel();
  const { toggleLeftPanel } = useLayoutStore.use.actions();

  return (
    <HintItem label={leftPanel.visible ? "Hide left panel" : "Show left panel"}>
      <button
        onClick={toggleLeftPanel}
        className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-secondary-foreground hover:bg-element-hover transition-all duration-150"
      >
        <RailGlyph open={leftPanel.visible} size="md" />
      </button>
    </HintItem>
  );
}

/** Tiny determinate ring for the titlebar download indicator. */
function ArcProgress({ value }: { value: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(1, value)));
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" className="-rotate-90">
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
function useUpdateItem(): DockItem {
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

  const label = checking
    ? "Checking for updates…"
    : downloading
      ? progress != null
        ? `Downloading update… ${Math.round(progress * 100)}%`
        : "Preparing update…"
      : ready
        ? "Update ready — click to restart"
        : "Check for updates";

  return {
    label,
    onClick,
    disabled: checking || downloading,
    icon: checking ? (
      <Loader2 size={12} className="animate-spin" />
    ) : downloading ? (
      progress != null ? (
        <ArcProgress value={progress} />
      ) : (
        <Loader2 size={12} className="animate-spin" />
      )
    ) : (
      <ArrowDownToLine size={12} />
    ),
    badge: ready ? <DockBadge className="bg-[var(--primary)]" /> : undefined,
  };
}

function useNotificationItem(): DockItem {
  const { toggle } = useNotificationsStore.use.actions();
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  // Select PRIMITIVES (booleans) — returning a filtered array from the selector
  // would create a new reference every render and trigger an infinite loop.
  // Scoped to the active organisation: another org's unread items are its own.
  const unread = useNotificationsStore((s) => hasUnread(s.items, activeOrgId));
  const hasError = useNotificationsStore((s) => hasUnread(s.items, activeOrgId, isErrorKind));
  // LIVE attention state: any session (any project) blocked on a permission
  // decision, or any terminal waiting on input. Derived from live stores
  // rather than unread flags so it shows even after the panel was opened, and
  // clears itself the moment the prompt is answered.
  const chatAttention = useChatStore((s) =>
    Object.values(s.pendingPermissions).some((reqs) => reqs.length > 0),
  );
  const terminalAttention = useTerminalAttention(anyTerminalNeedsAttention);
  const needsAttention = chatAttention || terminalAttention;

  return {
    label: "Notifications",
    onClick: () => toggle(activeOrgId),
    icon: <Bell size={12} />,
    badge:
      unread || needsAttention ? (
        <DockBadge
          // Priority: error > needs-attention (green) > plain unread.
          className={cn(
            hasError
              ? "bg-[var(--atlas-status-error-foreground)]"
              : needsAttention
                ? "bg-[var(--atlas-status-success-foreground)] animate-pulse"
                : "bg-foreground",
          )}
          label={needsAttention ? "Something needs your attention" : "Unread notifications"}
        />
      ) : undefined,
  };
}

function useRightPanelItem(): DockItem {
  const rightPanel = useLayoutStore.use.rightPanel();
  const { toggleRightPanel } = useLayoutStore.use.actions();

  return {
    label: rightPanel.visible ? "Hide right panel" : "Show right panel",
    onClick: toggleRightPanel,
    icon: <PanelRight size={12} className={rightPanel.visible ? "" : "opacity-40"} />,
  };
}

/** The dock's corner dot. Its ring matches the dock fill, not the titlebar —
 *  the badge now sits on the pill, not on the window. */
function DockBadge({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute right-[3px] top-[3px] size-[6px] rounded-full",
        "ring-1 ring-[var(--card)]",
        className,
      )}
      aria-label={label}
    />
  );
}
