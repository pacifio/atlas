import { useState, useEffect, useRef, useCallback } from "react";
import { RailGlyph } from "@/ui/animated-icon";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { Popover } from "@base-ui/react/popover";
import { useAppStore } from "@/features/app/stores/app-store";
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
import { Bell, ArrowDownToLine, Hammer, Loader2, Minus, Square, Copy, X } from "lucide-react";
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
import { HelpSubmenu } from "./help-submenu";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { CapturePopover } from "@/features/capture/components/capture-popover";
import { StatusDot } from "@/features/capture/components/capture-status";
import type { Binding, CaptureHealth } from "@/features/capture/types";
import { activeProjectId } from "@/features/projects/lib/active-project";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { isDev } from "@/lib/env";
import { isLinux, isMac, isWindows } from "@/lib/platform";
import { MenuBar } from "@/features/menu/components/menu-bar";
import { OrgSwitcher } from "@/features/organisations/components/org-switcher";
import { BreadcrumbButton } from "./breadcrumb-button";
import { OPEN_CAPTURE_EVENT } from "@/features/session-context/lib/open-capture";
import { RightPanelToggle } from "@/features/layout/components/right-panel-toggle";

/**
 * The native window, for dragging and zooming. Resolved once per module and
 * shared by every header: each column now draws its own slice of the bar, and
 * a per-header dynamic import would race the first drag.
 *
 * Fullscreen is **not** tracked here: `useFullscreen` owns that, and two copies
 * of its `onResized` + `await isFullscreen()` dance is how the titlebar and the
 * sidebar came to disagree about where the traffic lights were (the race is
 * written up in `use-fullscreen.ts`).
 */
let nativeWindow: TauriWindow | null = null;
if (isTauri()) {
  void import("@tauri-apps/api/window")
    .then((m) => {
      nativeWindow = m.getCurrentWindow();
    })
    .catch(() => {});
}

/** True when a press on `target` belongs to the window, not to a control. A
 *  tab is a control here: dragging a tab must never drag the window. */
function isWindowSurface(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !el?.closest(
    "button, a, input, select, textarea, [role='menuitem'], [role='tab'], [data-no-window-drag]",
  );
}

/**
 * Window dragging and double-click-to-zoom for any stretch of the bar.
 *
 * Manual, not `data-tauri-drag-region` (that CSS hook doesn't work in this
 * app). Calling `startDragging()` straight from mousedown hands the event
 * stream to the OS drag session and swallows the double-click, so the drag
 * only begins once the pointer moves past a small threshold; a stationary
 * click or double-click flows through to `onDoubleClick`.
 *
 * Double-click is AppKit's zoom on macOS — Tauri's `toggleMaximize()` doesn't
 * map to it, so a native `performZoom:` command does — and maximize on Windows
 * and Linux, which is the convention there.
 */
export function useWindowDrag() {
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !isWindowSurface(e.target)) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: MouseEvent) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) {
        cleanup();
        void nativeWindow?.startDragging();
      }
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", cleanup);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", cleanup);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!isWindowSurface(e.target)) return;
    if (isMac) void invoke("window_zoom").catch(() => {});
    else void nativeWindow?.toggleMaximize();
  };
  return { onMouseDown, onDoubleClick };
}

/**
 * One column's slice of the bar.
 *
 * Atlas has no full-width titlebar. Each column — every split column, the
 * project rail — draws its own header at `h-titlebar` with no bottom rule, so
 * side by side they read as one strip, broken only by the full-height column
 * borders running through it. The window's own controls then have to live in
 * whichever column is at the window's edge: `leading` (traffic-light inset,
 * the project rail toggle, the `org / project` label) goes in the leftmost
 * header and `trailing` (update, notifications, account, and the
 * Windows/Linux window buttons) in the rightmost. See `columnChrome` for which
 * column that is.
 *
 * Every stretch of it drags the window.
 */
export function PaneHeader({
  leading,
  breadcrumb,
  trailing,
  size = "bar",
  className,
  children,
}: {
  leading?: boolean;
  /** Whether `org / project` shows: inside the leading cluster when `leading`
   *  (default on), or alone at the start of the header when not. */
  breadcrumb?: boolean;
  trailing?: boolean;
  /** `bar` is a slice of the window's bar; `strip` a shorter tab strip that
   *  sits under a separate top bar. */
  size?: "bar" | "strip";
  className?: string;
  children?: React.ReactNode;
}) {
  const drag = useWindowDrag();
  return (
    <div
      {...drag}
      className={cn(
        "relative flex min-w-0 shrink-0 select-none items-center gap-1",
        size === "bar" ? "h-titlebar" : "h-9",
        !leading && "pl-2",
        !trailing && "pr-2",
        className,
      )}
    >
      {leading ? (
        <TopbarLeading breadcrumb={breadcrumb ?? true} />
      ) : (
        breadcrumb && <ProjectBreadcrumb />
      )}
      {children}
      {trailing && <TopbarTrailing />}
    </div>
  );
}

/**
 * The window's top bar: the leading cluster (traffic-light inset, the project
 * rail toggle, `org / project`), and the
 * trailing dock (update, notifications, account, and the
 * Windows/Linux window buttons). Every stretch of it drags the window.
 */
export function Titlebar() {
  const drag = useWindowDrag();
  return (
    <div
      {...drag}
      className="relative z-titlebar flex h-titlebar shrink-0 select-none items-center border-b border-border bg-background"
    >
      <TopbarLeading />
      <TopbarTrailing />
    </div>
  );
}

/**
 * The bar's left end: room for the traffic lights, then the sidebar toggle
 * and the `org / project` label.
 *
 * The 78pt inset is the traffic lights (`trafficLightPosition.x` 16 + three
 * buttons) plus a gap — divided by the interface zoom, like the bar's height,
 * because the lights do not scale with it. Vertically the lights are centred
 * by `trafficLightPosition.y` = bar height / 2 − 2 (see `--titlebar-height` in
 * `tokens.css`), re-applied after launch and title changes by
 * `commands::window::apply_traffic_light_inset`. It is dropped while the sidebar is open — the sidebar
 * then sits under the lights and carries that gap itself — and in fullscreen,
 * which hides the lights. Only macOS has them on the left; Windows and Linux get
 * the menu bar here and `WindowControls` at the other end.
 */
function TopbarLeading({ breadcrumb = true }: { breadcrumb?: boolean }) {
  const isFullscreen = useFullscreen();
  const sidebarOpen = useProjectStore.use.sidebarOpen();
  const inset = isMac && !isFullscreen && !sidebarOpen;

  return (
    <div
      className={cn(
        "flex min-w-0 shrink items-center gap-1",
        inset ? "pl-[calc(78px/var(--ui-zoom,1))]" : "pl-2",
      )}
    >
      {/* An open sidebar owns the corner then, and carries the badge. */}
      {!sidebarOpen && <DevBadge className="mr-1" />}
      {/* Windows and Linux: the menus macOS shows in the system menu bar. */}
      {!isMac && <MenuBar className="mr-1" />}
      {/* One sidebar toggle: the project rail's. The project tree is the
          Files surface (⌘B, the View menu, the palette). */}
      <HintGroup>
        <SidebarToggle />
      </HintGroup>
      {breadcrumb && <ProjectBreadcrumb />}
    </div>
  );
}

/**
 * `org / project`, named from the stores. Part of the leading cluster, at the
 * head of the first split column.
 */
export function ProjectBreadcrumb() {
  const currentProject = useAppStore.use.currentProject();
  // The label name is read from the PROJECT store (matched by path), not from
  // `currentProject.name`. `currentProject` only re-syncs after a slow Rust
  // AppState round-trip, so a project rename took ~3-4s to show here; the
  // project store mutates synchronously on rename, so this updates instantly.
  const projects = useProjectStore.use.projects();
  // Owning organisation, read live so an org switch or rename re-labels
  // immediately.
  const organisations = useOrgStore.use.organisations();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  const orgName = organisations.find((o) => o.id === activeOrganisationId)?.name ?? null;
  // Same path can be a project in several orgs — prefer the ACTIVE org's
  // twin so a rename in another org never re-labels this bar.
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
  return <ProjectLabel name={displayName} orgName={orgName} path={currentProject?.path} />;
}

/**
 * The bar's right end, the window's group: the dock while it has something to
 * say, then the right panel toggle while a project is open, then the account,
 * always. It is the one place the avatar lives (the sidebar footer has none).
 * The account sits outside the `currentProject` guard on purpose: a fresh
 * install has no project open, and sign-in must be reachable from that empty
 * state.
 *
 * This group never moves: it is drawn by whichever header is at the window's
 * right edge, so the panel toggle and the avatar keep their places whether
 * the panel is shown or not. A gap, nothing louder, sets it apart from the
 * session's own controls (`SessionHeaderControls`), which come and go with
 * the tab.
 */
function TopbarTrailing() {
  const currentProject = useAppStore.use.currentProject();
  return (
    <div
      data-window-controls
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1 pl-3",
        !(isWindows || isLinux) && "pr-2",
      )}
    >
      {currentProject ? <ActionDock /> : null}
      {currentProject ? (
        <HintGroup>
          <RightPanelToggle />
        </HintGroup>
      ) : null}
      <AccountButton menuExtra={<HelpSubmenu />} />
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
export function WindowControls() {
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
    "flex h-titlebar w-[46px] items-center justify-center text-muted-foreground transition-colors duration-100";

  return (
    <HintGroup>
      <div className="ml-2 flex h-titlebar items-center">
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
 * — updater phase, notification counts — re-render
 * this and nothing else. Put them in `Titlebar` itself and every notification
 * would re-render the project label and the org switcher beside it.
 */
function ActionDock() {
  const update = useUpdateItem();
  const notifications = useNotificationItem();
  // The bar's resting state is layout controls only. Update and notifications
  // step in only while they have something to say; the bell lives
  // permanently in the sidebar's footer.
  const items = [update, notifications].filter((i): i is DockItem => i !== null);
  return <TitlebarDock items={items} />;
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

  // ⌘⌥C and the palette open capture in the session's Details card; with no
  // session in the main column they land here (`openCapture`). Every mounted
  // project draws a label, and the background ones are `display:none`: only
  // the one on screen opens, or a popover would anchor to a hidden button.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onOpenCapture = () => {
      if (path && rootRef.current?.offsetParent) setCaptureOpen(true);
    };
    window.addEventListener(OPEN_CAPTURE_EVENT, onOpenCapture);
    return () => window.removeEventListener(OPEN_CAPTURE_EVENT, onOpenCapture);
  }, [path]);

  return (
    <div ref={rootRef} className="relative flex min-w-0 shrink items-center">
      {/* Breadcrumb: `org / project`, two controls. The org opens the org
          switcher — the same menu as the rail's org row. The project opens
          capture setup: capture is per project, and this is the one control in
          the app that always names the project it would apply to — which the
          Timeline board, spanning every project, cannot. Each segment carries
          its own chevron so the bar's text reads as something you can press. */}
      {orgName && (
        <>
          <OrgSwitcher />
          <span className="shrink-0 px-0.5 text-sm text-muted-foreground opacity-60">/</span>
        </>
      )}
      {!path ? (
        <span className="min-w-0 truncate px-1.5 text-sm text-foreground">{name}</span>
      ) : (
        <Popover.Root open={captureOpen} onOpenChange={setCaptureOpen}>
          <Popover.Trigger
            render={
              <BreadcrumbButton
                className="max-w-[240px] text-foreground"
                title={health?.summary ?? "Session capture"}
                aria-label={health?.summary ?? "Session capture"}
                // Only once capture is on. An always-present grey dot on every
                // project reads as a defect indicator rather than a state.
                trailing={binding?.enabled && <StatusDot binding={binding} health={health} />}
              >
                {name}
              </BreadcrumbButton>
            }
          />
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
        </Popover.Root>
      )}
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
 * fits. It is also dev-only — `DevBadge` returns null in a release build —
 * so nothing a user sees depends on any of it.
 */
// ratchet-allow: the dev-build badge is meant to look alien to the theme.
// ratchet-allow: the dev-build marker is out-of-band — it must look the same in
// every theme — and wears the cream of the Atlas mark (`assets/atlas-icon.svg`).
const DEV_PILL_CREAM = "#FFFFE2";
// ratchet-allow: ink on that fixed cream; a theme foreground could be pale on it.
const DEV_PILL_INK = "#1A1A14";

/**
 * The dev-build badge. It sits in flow, right of the macOS traffic lights, in
 * whichever bar owns the window's top-left corner: the project rail's band
 * when the rail is docked, else the workspace bar's leading cluster (and the
 * settings sidebar's band on that screen). It used to float, centred on the
 * session, and so moved every time a column opened, closed or resized, and
 * landed on whatever the bar held there. Here it is always in the same place
 * and the bar makes room for it.
 */
export function DevBadge({ className }: { className?: string }) {
  if (!isDev || !isTauri()) return null;
  return (
    <span
      // An indicator, not a control: no pointer events, so the bar under it
      // still drags the window.
      className={cn(
        "pointer-events-none flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-xs leading-none font-medium",
        className,
      )}
      style={{ backgroundColor: DEV_PILL_CREAM, color: DEV_PILL_INK }}
    >
      <Hammer size={11} />
      Dev
    </span>
  );
}

function SidebarToggle() {
  const hint = useActionShortcut("workspace.toggleSidebar")?.label;
  const sidebarOpen = useProjectStore.use.sidebarOpen();
  const { toggleSidebar } = useProjectStore.use.actions();
  const label = sidebarOpen ? "Hide sidebar" : "Show sidebar";

  return (
    <HintItem label={hint ? `${label} (${hint})` : label}>
      <button
        onClick={toggleSidebar}
        aria-label={label}
        aria-pressed={sidebarOpen}
        className={cn(
          "flex size-6 items-center justify-center rounded-md transition-colors duration-150 hover:bg-element-hover",
          sidebarOpen ? "text-foreground" : "text-muted-foreground hover:text-secondary-foreground",
        )}
      >
        <RailGlyph open={sidebarOpen} size="md" />
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
 * Titlebar auto-update indicator, shown only while there is something to see
 * (idle, it is null — "Check for updates" lives in the app menu and Settings ›
 * Updates). While the backend checks → spinner. While the update
 * downloads in the background → an arc showing progress. Once staged and ready
 * → a badge dot; clicking reopens the "Restart to update" prompt. All state is
 * driven by the `atlas:update-*` events → updater store (fully non-blocking).
 */
function useUpdateItem(): DockItem | null {
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

  if (!checking && !downloading && !ready) return null;

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
      <Loader2 size={14} className="animate-spin" />
    ) : downloading ? (
      progress != null ? (
        <ArcProgress value={progress} />
      ) : (
        <Loader2 size={14} className="animate-spin" />
      )
    ) : (
      <ArrowDownToLine size={14} />
    ),
    badge: ready ? <DockBadge className="bg-[var(--primary)]" /> : undefined,
  };
}

/** Notifications in the bar only while something is unread or waiting on you;
 *  the sidebar footer has the bell at all times. */
function useNotificationItem(): DockItem | null {
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
  if (!unread && !needsAttention) return null;

  return {
    label: "Notifications",
    onClick: () => toggle(activeOrgId),
    icon: <Bell size={14} />,
    badge: (
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
    ),
  };
}

/** The dock's corner dot, ringed in the bar's own colour so it reads as cut
 *  out of the button rather than stuck on it. */
function DockBadge({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute right-[3px] top-[3px] size-[6px] rounded-full",
        "ring-1 ring-[var(--background)]",
        className,
      )}
      aria-label={label}
    />
  );
}
