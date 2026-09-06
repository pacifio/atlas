import { startTransition, useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppLayout } from "@/features/layout/components/app-layout";
import { AppContextMenu } from "@/components/app-context-menu";
import { TooltipProvider } from "@/ui/tooltip";
import { CommandPalette } from "@/components/command-palette";
import { NewTabPalette } from "@/components/new-tab-palette";
import { LayoutSwitcher } from "@/features/layout/components/layout-switcher";
import { SearchOverlay } from "@/components/search-overlay";
import { useActionHotkeys } from "@/hooks/use-hotkey";
import {
  useKeybindingsStore,
  watchKeybindingsOnFocus,
} from "@/features/keybindings/stores/keybindings-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useTerminalStore } from "@/features/terminal/stores/terminal-store";
import { useProjectStore, type AppStateWire } from "@/features/project/stores/project-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { listenAgents, resetAgentByAgentId } from "@/features/chat/lib/agents-api";
import type { PendingPermission } from "@/types/acp";
import type { AgentDelta } from "@/types/agents";
import { cycleChatAgent } from "@/features/chat/lib/switch-agent";
import { FilePicker } from "@/features/file-picker/components/file-picker";
import { HintOverlay } from "@/features/hint-nav/components/hint-overlay";
import { BrowserOverlayWatcher } from "@/features/browser/components/browser-overlay-watcher";
import {
  fileIndex,
  openFileIndex,
  markFileIndexClosed,
} from "@/features/file-picker/lib/file-picker-api";
import { activeWorkspaceId } from "@/features/workspaces/lib/active-workspace";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { pickAndAddWorkspace } from "@/features/workspaces/lib/pick-workspace";
import { flushAll } from "@/features/workspaces/lib/flush-registry";
import { captureSnapshot } from "@/features/workspaces/lib/workspace-snapshot";
import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useRecentFilesStore,
  ensureRecentFilesListener,
  type RecentFile,
} from "@/features/chat/stores/recent-files-store";
import { useRecentChatsStore } from "@/features/workspaces/stores/recent-chats-store";
import { stripInjectedContext } from "@/features/chat/lib/atlas-context";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { requestCloseTab } from "@/features/chat/lib/close-tab";
import { jumpToSession } from "@/features/chat/lib/tab-workspace";
import { pruneContextUsageCache } from "@/features/chat/lib/context-usage-cache";
import { isScrollHot } from "@/lib/scroll-hot";
import {
  hydrateAgentRegistry,
  startCatalogListener,
} from "@/features/agents/stores/agent-registry-store";
import { AgentOAuthModalHost } from "@/features/agents/components/agent-oauth-modal";
import { AgentElicitationHost } from "@/features/chat/components/agent-elicitation-host";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { logEvent } from "@/features/log/lib/log";
import { warmMarkdownWorker, primeMarkdownRenderer } from "@/lib/markdown-cache";
import { primeMarkdown } from "@/lib/markdown";
import { useNotificationsStore } from "@/features/notifications/stores/notifications-store";
import { NotificationPanel } from "@/features/notifications/components/notification-panel";
import { FeedbackPanel } from "@/features/feedback/components/feedback-panel";
import { UpdateAvailableModal } from "@/features/updater/components/update-available-modal";
import { LoadingOrganisationOverlay } from "@/features/organisations/components/loading-organisation-overlay";
import { StopAgentsDialog } from "@/features/workspaces/components/stop-agents-dialog";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import {
  isOrgReconciled,
  markOrgReconciled,
} from "@/features/organisations/lib/org-reconciliation";
import { comms, listenComms, type CommsEnvelope } from "@/features/comms/lib/comms-api";
import { commsActions, pruneTyping } from "@/features/comms/stores/comms-store";
import { useUpdaterStore } from "@/features/updater/stores/updater-store";
import {
  updater,
  listenUpdateProgress,
  listenUpdateReady,
  listenUpdateApplied,
  listenUpdateError,
  listenUpdateChecking,
} from "@/features/updater/lib/updater-api";
import { Toaster, toast } from "sonner";
import {
  listenAuthChanged,
  listenAuthError,
  listenAuthSignedOut,
} from "@/features/auth/lib/auth-api";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { ConnectDialog } from "@/features/auth/components/connect-dialog";
import { clampScale, SCALE_STEP, DEFAULT_SCALE } from "@/features/settings/lib/ui-scale";
import { useModelsStore } from "@/features/settings/stores/models-store";

// Interface-zoom helpers (⌘+/⌘-/⌘0). They read + write the persisted
// `uiScale` setting; `updateSettings` applies it to the native WebView zoom.
function stepZoom(delta: number) {
  const { settings, actions } = useProjectStore.getState();
  actions.updateSettings({ uiScale: clampScale(settings.uiScale + delta) });
}
const zoomIn = () => stepZoom(SCALE_STEP);
const zoomOut = () => stepZoom(-SCALE_STEP);
const zoomReset = () =>
  useProjectStore.getState().actions.updateSettings({ uiScale: DEFAULT_SCALE });

export function App() {
  // Own model download listeners at app scope so completion notifications are
  // delivered even when Settings is closed.
  useEffect(() => {
    void useModelsStore.getState().actions.init();
  }, []);

  // Keybinding profiles: load once, then pick up hand edits to
  // keybindings.json whenever the window regains focus.
  useEffect(() => {
    void useKeybindingsStore.getState().actions.load();
    return watchKeybindingsOnFocus();
  }, []);

  // No Claude probe here any more. It used to run at boot to drive a banner
  // above the composer and hard-disable the input; both are gone, and probing
  // meant a fresh install spawned subprocesses for an agent it does not have
  // (ADR-0002). The one caller that still needs the answer — the post-auth
  // re-check in `agent-auth-hooks` — asks for it itself.
  useEffect(() => {
    // Agent identity registry (the native agent + registry-installed
    // externals):
    // hydrate once so pickers/glyphs/memory dropdown resolve external
    // metadata; the marketplace re-hydrates after installs.
    void hydrateAgentRegistry();
    // …and stay current: discovery finishes after boot, and installs /
    // acquisitions / settings toggles all change how an agent launches.
    startCatalogListener();
  }, []);

  // Refresh the `atlas` CLI helper at `~/.local/bin/atlas` on every
  // launch. Fire-and-forget; an older or hand-edited copy gets
  // replaced with the current version. Failures are non-fatal — the
  // app still works without the helper, the user just can't type
  // `atlas ./` in their terminal until they hit the install button
  // in Settings → General.
  useEffect(() => {
    void invoke("cli_install_helper").catch((e) => {
      console.warn("atlas CLI helper refresh failed:", e);
    });
  }, []);

  // Warm-launch CLI: when `atlas <path>` runs while Atlas is already open, the
  // Rust single-instance callback forwards the folder here. The app is already
  // hydrated, so we just ADD it to the workspace list and switch to it (no race
  // with hydration). `openProject` → `addWorkspace` dedupes by path.
  useEffect(() => {
    const unlisten = listen<string>("atlas:cli-open-project", (event) => {
      const path = event.payload;
      if (!path) return;
      logEvent({
        source: "atlas",
        kind: "cli-launch-open-project",
        summary: `Adding workspace from CLI (warm launch): ${path}`,
        status: "success",
        payload: { path },
      });
      void useProjectStore.getState().actions.openProject(path);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Close-active-tab from the native menu (Cmd+W). The embedded browser is a
  // separate native webview, so its Cmd+W can't reach the React `useHotkeys`
  // handler — it falls through to the menu's "Close Tab" item, which emits this
  // event. Mirrors the Cmd+W hotkey: close whichever tab is active.
  useEffect(() => {
    const unlisten = listen("atlas:close-active-tab", () => {
      const current = useLayoutStore.getState().activeTabId;
      if (current) requestCloseTab(current);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Auto-update: route the Rust updater events into the updater store, which
  // drives the titlebar arc/badge and the <UpdateAvailableModal />. The
  // check/download/verify/stage all run in Rust; here we just reflect the phase.
  // See src/features/updater + commands::updater.
  useEffect(() => {
    const a = useUpdaterStore.getState().actions;
    const offs: Array<Promise<() => void>> = [
      listenUpdateProgress((e) => a.setDownloading(e.version, e.downloaded, e.total, e.phase)),
      listenUpdateReady((e) => a.setReady(e.version)),
      listenUpdateApplied((e) => {
        a.reset();
        toast.success(`Updated to Atlas ${e.version}.`);
      }),
      listenUpdateError((e) => a.setError(e.message)),
      listenUpdateChecking((e) => a.setChecking(e.checking)),
    ];
    // Hydrate from the current backend state (e.g. staged before this mount).
    // Show the titlebar badge but don't pop the modal on launch — the live
    // `atlas:update-ready` event opens it; hydration is badge-only.
    void updater.state().then((s) => {
      if (s.phase === "ready" && s.version) {
        a.setReady(s.version);
        a.dismissModal();
      }
    });
    return () => {
      for (const p of offs) void p.then((off) => off());
    };
  }, []);

  // Account auth (ATL-35). Rust owns the credential and every transition; this
  // only mirrors `atlas:auth-changed` into the store. Broadcast (not per-window)
  // so two open windows always agree on who is signed in.
  useEffect(() => {
    const a = useAuthStore.getState().actions;
    const offs: Array<Promise<() => void>> = [
      listenAuthChanged((snapshot) => {
        a.setSnapshot(snapshot);
        // Add-only merge of the server's org list into the local switcher.
        // Guarded on `orgs !== null` (three-state): `null` is "not known yet"
        // (offline), not "no orgs", and must never touch the local list.
        if (snapshot.status === "signed-in" && snapshot.orgs) {
          useOrgStore.getState().actions.mergeServerOrgs(snapshot.orgs);
        }
      }),
      listenAuthError((e) => a.setError(e.message)),
      // A revoked or expired session arrives with nothing on screen, so the
      // only place it can land is a toast — the title bar quietly reverting to
      // a signed-out icon reads as a bug rather than an explanation.
      listenAuthSignedOut((e) => toast.error(e.message)),
    ];
    void a.hydrate();
    return () => {
      for (const p of offs) void p.then((off) => off());
    };
  }, []);

  // Boot reconciliation of the ACTIVE org. Rust's stored value is seeded from
  // the web and historically fell back to the account's *first* organisation,
  // while the desktop's real choice lives in the local org store and is only
  // pushed on an explicit switch. Push it once at boot too, so the auth
  // snapshot — and everything keyed off it: the chat socket's target and the
  // gateway `atlas-org` billing header — follows the org actually on screen
  // rather than whichever one the server listed first.
  const orgReconciledRef = useRef(false);
  const bootAuthStatus = useAuthStore((s) => s.snapshot.status);
  const bootLocalActiveOrg = useOrgStore.use.activeOrganisationId();
  const bootOrganisations = useOrgStore.use.organisations();
  useEffect(() => {
    // `isOrgReconciled` covers the other pusher: an explicit `switchOrg` that
    // ran before sign-in settled has already told Rust, and this push landing
    // after it would drag the chat socket back to the org just left.
    if (orgReconciledRef.current || isOrgReconciled()) return;
    if (bootAuthStatus !== "signed-in" || !bootLocalActiveOrg) return;
    const active = bootOrganisations.find((o) => o.id === bootLocalActiveOrg);
    if (!active) return;
    orgReconciledRef.current = true;
    markOrgReconciled();
    void invoke("auth_set_active_org", { orgId: active.remoteId ?? null }).catch((e) => {
      console.warn("boot org reconciliation failed:", e);
    });
  }, [bootAuthStatus, bootLocalActiveOrg, bootOrganisations]);

  // Team chat: the renderer is a projection of Rust's chat state. The socket
  // lives in Rust for the app's lifetime (it is also the notification
  // transport), so this listener runs at app scope rather than with the panel —
  // a panel-scoped one would mean "panel closed, no notifications".
  useEffect(() => {
    // rAF-coalesced, the agent-delta batcher's shape: a burst of socket frames
    // (a backfill, a reaction flood, a presence storm) used to be one zustand
    // `set` — and one React commit — PER FRAME. Buffer and drain once per
    // animation frame; React 18 batches every `set` inside the synchronous
    // drain into a single commit. The timeout backstop drains while the
    // window is hidden, where rAF never fires (same trap as the delta path).
    let buffer: CommsEnvelope[] = [];
    let scheduled = 0;
    let backstop = 0;
    const drain = () => {
      scheduled = 0;
      if (backstop) {
        window.clearTimeout(backstop);
        backstop = 0;
      }
      const batch = buffer;
      buffer = [];
      const apply = commsActions().applyEnvelope;
      for (const envelope of batch) apply(envelope);
    };
    const off = listenComms((envelope) => {
      buffer.push(envelope);
      if (!scheduled) {
        scheduled = window.requestAnimationFrame(drain);
        backstop = window.setTimeout(drain, 120);
      }
    });
    // Subscribe FIRST, then ask Rust to re-announce. Tauri events are not
    // buffered and the socket opens seconds after launch — possibly before this
    // component mounts — so a `resync` emitted into a void was leaving the panel
    // empty until an org switch happened to fire another one.
    void off.then(() => comms.ready()).catch(() => {});
    // There is no "stopped typing" frame, so hints are aged out on a timer.
    const prune = window.setInterval(pruneTyping, 2_000);
    return () => {
      void off.then((fn) => fn());
      window.clearInterval(prune);
      if (scheduled) window.cancelAnimationFrame(scheduled);
      if (backstop) window.clearTimeout(backstop);
    };
  }, []);

  // Warm the member roster at APP scope, so the chat panel's first paint has
  // names — the panel used to be the only fetcher, which meant a boot with the
  // panel closed guaranteed an "Unknown"-titled DM list on first open. Guarded
  // AND keyed on the auth transition (the members-modal pattern): the org id
  // is persisted locally and ready long before the credential is.
  const bootRemoteOrgId =
    bootOrganisations.find((o) => o.id === bootLocalActiveOrg)?.remoteId ?? null;
  const bootSignedIn = bootAuthStatus === "signed-in";
  useEffect(() => {
    if (bootRemoteOrgId && bootSignedIn) {
      void useMembersStore.getState().actions.load(bootRemoteOrgId);
    }
  }, [bootRemoteOrgId, bootSignedIn]);

  // NOTE: we intentionally do NOT wipe localStorage on boot anymore. Several
  // stores legitimately persist there via zustand `persist` — the workspace
  // "Chats" list (`atlas-recent-chats`), layout prefs (`atlas-layout-prefs`),
  // the review provider/model selection — and a blanket clear was silently
  // dropping all of them on every restart. Each store carries its own
  // `version`/`migrate`, so stale keys from old builds are handled per-store.

  // One-shot bootstrap of the Rust-owned `AppState` (currentProject +
  // recentProjects). Replaces the zustand `persist` middleware that used
  // to hydrate from localStorage. The Tauri invoke is async but fast
  // (~5–20 ms warm); until it resolves the WelcomeScreen and project-aware
  // panels render their empty/loading states.
  //
  // `startTransition` marks the welcome → project layout swap as non-urgent
  // so React can pause reconciliation between component subtrees and keep
  // the welcome UI interactive while the project layout mounts.
  //
  // Once hydration is done (success or failure) we dispatch `atlas:app-ready`
  // — the inline script in `index.html` listens for it and removes the
  // boot skeleton.
  useEffect(() => {
    let cancelled = false;
    const signalReady = () => {
      const flag = window as unknown as { __atlasAppReady?: boolean };
      if (flag.__atlasAppReady) return;
      flag.__atlasAppReady = true;
      window.dispatchEvent(new CustomEvent("atlas:app-ready"));
    };

    (async () => {
      // A terminal `atlas <path>` launch stashes the path in Rust (single-shot,
      // so a window reload won't re-trigger). Consume it BEFORE hydrating: the
      // CLI project must be ADDED to the workspace list and switched to, but
      // hydrate replaces that list and fires its own `switchTo` — which would
      // both clobber the CLI workspace and swallow the CLI switch (`switching`
      // guard). So we suppress hydrate's auto-switch when a CLI path is present
      // and perform the CLI open as the sole, final switch.
      const cliPath = await invoke<string | null>("cli_take_initial_project_path").catch(
        () => null,
      );
      try {
        const payload = await invoke<AppStateWire>("bootstrap_app_state");
        if (cancelled) return;
        startTransition(() => {
          useProjectStore.getState().actions.hydrate(payload, { skipActiveSwitch: !!cliPath });
          // Hydration replaces the org list wholesale, so re-apply any server
          // orgs from a snapshot that may have already arrived — otherwise a
          // sign-in that landed before this bootstrap would be overwritten.
          const snap = useAuthStore.getState().snapshot;
          if (snap.status === "signed-in" && snap.orgs) {
            useOrgStore.getState().actions.mergeServerOrgs(snap.orgs);
          }
        });
      } catch (e) {
        console.warn("bootstrap_app_state failed; starting empty:", e);
        if (!cancelled) {
          startTransition(() => {
            useProjectStore.getState().actions.hydrate(
              {
                currentProject: null,
                recentProjects: [],
                version: 1,
              },
              { skipActiveSwitch: !!cliPath },
            );
          });
        }
      } finally {
        if (!cancelled) {
          if (cliPath) {
            logEvent({
              source: "atlas",
              kind: "cli-launch-open-project",
              summary: `Adding workspace from CLI argv: ${cliPath}`,
              status: "success",
              payload: { path: cliPath },
            });
            await useProjectStore
              .getState()
              .actions.openProject(cliPath)
              .catch((err) => {
                logEvent({
                  source: "atlas",
                  kind: "cli-launch-open-project-failed",
                  summary: `openProject failed: ${String(err)}`,
                  status: "failure",
                  payload: { error: String(err) },
                });
              });
          }
          signalReady();
          // First paint is done — pull in the main-thread markdown renderer
          // now so the first small chat block still parses synchronously. It
          // is deliberately NOT a static import (it would land in the eager
          // entry chunk); see `primeMarkdownRenderer`.
          primeMarkdownRenderer();
          primeMarkdown();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [newTabPaletteOpen, setNewTabPaletteOpen] = useState(false);
  const [layoutSwitcherOpen, setLayoutSwitcherOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const {
    toggleLeftPanel,
    toggleRightPanel,
    toggleRightChatPanel,
    toggleBottomPanel,
    toggleChatSidebar,
    toggleTabBar,
    addTab,
    setActiveTab,
    activateTabByIndex,
    cycleTab,
    addGroup,
    closeGroup,
    focusAdjacentGroup,
    toggleZenMode,
  } = useLayoutStore.use.actions();
  const tabs = useLayoutStore.use.tabs();
  const activeTabId = useLayoutStore.use.activeTabId();
  const groupOrder = useLayoutStore.use.groupOrder();
  const focusedGroupId = useLayoutStore.use.focusedGroupId();

  // ⌘J — toggle the terminal WITHIN the focused split column (not a global
  // instance), so it respects which pane you're working in.
  const toggleTerminal = () => {
    const st = useLayoutStore.getState();
    const g = st.focusedGroupId;
    const groupOf = (t: { groupId?: string }) => t.groupId ?? "main";
    const groupTabs = st.tabs.filter((t) => groupOf(t) === g);
    const activeTab = st.tabs.find((t) => t.id === st.activeByGroup[g]);

    const focusTerminalSoon = (tabId: string) => {
      useTerminalStore.getState().actions.requestTerminalFocus(tabId);
    };

    if (activeTab?.type === "terminal") {
      // Toggle away: the most-recent non-terminal tab in THIS column (history),
      // else the first non-terminal tab in the column.
      const back = [...st.tabHistory].reverse().find((id) => {
        const t = st.tabs.find((x) => x.id === id);
        return t && groupOf(t) === g && t.type !== "terminal";
      });
      const target = back ?? groupTabs.find((t) => t.type !== "terminal")?.id;
      if (target) setActiveTab(target);
      return;
    }

    const existing = groupTabs.find((t) => t.type === "terminal");
    if (existing) {
      setActiveTab(existing.id);
      focusTerminalSoon(existing.id);
    } else {
      const newTabId = `terminal-${Date.now()}`;
      addTab({
        id: newTabId,
        type: "terminal",
        title: "Terminal",
        closable: true,
        dirty: false,
        data: {},
      });
      focusTerminalSoon(newTabId);
    }
  };
  const currentProject = useProjectStore.use.currentProject();

  // Global agent event bus. One listener routes atlas-agents SessionDelta
  // events into the chat-store, queues permission requests for the
  // PermissionModal, and resets the lazy agent handle on disconnect.
  //
  // ACP events arrive at the rate the agent streams them — for a
  // tool-heavy turn (e.g. "read 30 files") that's ~60 `tool_call` /
  // `tool_call_update` events plus a continuous text chunk stream. Per
  // event without batching: 1 immer draft + 1 subscriber notification
  // + 1 `MessagesList` re-render (and the virtualizer's
  // `measureElement` runs). On a fast turn that pegs the main thread.
  //
  // Coalesce every frame via RAF and apply the whole batch in ONE
  // immer pass through `applyAgentBatch`. Dedup `tool_call_upserted`
  // by `(session, tool_call.id)` (last-write-wins, original position
  // preserved) so a tool that flips through pending → running →
  // completed in a single frame only contributes once. Other deltas
  // go in strict wire order — `message_appended` before subsequent
  // tool calls so a new assistant message anchors them correctly,
  // etc.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    // All deltas — text/thinking chunks INCLUDED — buffer here in strict wire
    // order. Consecutive same-session text (or thinking) chunks coalesce into
    // the trailing entry, but a `message_appended`/tool delta between two text
    // runs breaks the run so ordering is preserved. (Previously text was
    // bucketed separately and applied BEFORE other deltas, which reordered the
    // anchoring `message_appended` after its text — invisible for ACP agents
    // whose IPC latency spread deltas across frames, but the in-process Cersei
    // agent emits a whole turn in one frame and the text shattered into
    // mis-ordered fragments.)
    const pendingDeltas: AgentDelta[] = [];
    const toolDeltaPos = new Map<string, number>(); // dedup key → index in pendingDeltas
    const outputChunkPos = new Map<string, number>(); // live-output coalesce key → index
    let rafId: number | null = null;
    /** Timer drain that survives RAF being paused — see `schedule` below. */
    let backstopId: ReturnType<typeof setTimeout> | null = null;

    // "Is Atlas actually in front of the user?" — tracked via the NATIVE window
    // focus, NOT web focus/blur. The web events keep reporting "focused" when
    // Atlas is fullscreen on its own macOS Space and the user swipes to another
    // desktop (the webview never blurs), so notifications would wrongly stay
    // suppressed. The native key-window status flips correctly on a Space
    // switch / app deactivation, which is the signal we actually want.
    let windowFocused = true;
    let unlistenFocus: (() => void) | null = null;
    const appWindow = getCurrentWindow();
    void appWindow
      .isFocused()
      .then((f) => {
        windowFocused = f;
      })
      .catch(() => {});
    // Front-load the "cold wake" after the window has been idle/occluded: WebKit
    // throttles the WKWebView's main thread + rAF + layout while inactive, so the
    // first interaction (e.g. scrolling the chat) eats the catch-up. Firing this
    // on the focus/visibility RISING edge lets listeners (chat virtualizer,
    // markdown worker) warm the pipeline before the user touches anything.
    const signalActive = () => window.dispatchEvent(new CustomEvent("atlas:window-active"));
    void appWindow
      .onFocusChanged(({ payload: focused }) => {
        if (focused && !windowFocused) signalActive();
        windowFocused = focused;
      })
      .then((un) => {
        unlistenFocus = un;
      })
      .catch(() => {});
    // Space switches / occlusion don't always flip native key-window focus, so
    // also wake on the page becoming visible again.
    const onVisible = () => {
      if (document.visibilityState === "visible") signalActive();
    };
    document.addEventListener("visibilitychange", onVisible);

    // ── Idle-while-focused cold wake ─────────────────────────────────────────
    // The focus/visibility edges above never fire when Atlas stays the focused,
    // visible window through a long idle stretch (the user steps away without
    // switching apps or Spaces). WebKit still throttles the idle main thread and
    // the OS can reclaim JIT/worker pages, so the first interactions on return
    // are cold and recover only gradually (the "slow for ~10-15s" symptom). Two
    // mitigations:
    //   1. Fire the same warm-up on the FIRST real interaction after an idle gap
    //      so the whole pipeline (chat virtualizer, graphs, markdown worker)
    //      warms at once instead of path-by-path as each is lazily exercised.
    //   2. While focused+visible, ping the markdown worker on an idle cadence so
    //      WebKit doesn't suspend it out from under us (a suspended worker costs
    //      a 3s watchdog → main-thread sync fallback on the first big message).
    const IDLE_RETURN_MS = 30_000;
    const KEEP_WARM_MS = 20_000;
    let lastActivityAt = Date.now();
    const onUserActivity = () => {
      const now = Date.now();
      if (now - lastActivityAt > IDLE_RETURN_MS) signalActive();
      lastActivityAt = now;
    };
    // Discrete inputs only (not pointermove) to keep this effectively free.
    window.addEventListener("pointerdown", onUserActivity, { passive: true });
    window.addEventListener("keydown", onUserActivity, { passive: true });
    window.addEventListener("wheel", onUserActivity, { passive: true });
    const keepWarm = window.setInterval(() => {
      if (windowFocused && document.visibilityState === "visible") {
        warmMarkdownWorker();
      }
    }, KEEP_WARM_MS);

    // Housekeeping, well off the startup critical path: sweep stale
    // per-session context-usage gauges out of localStorage (they had no
    // other removal path and grew one key per session forever).
    const pruneTimer = window.setTimeout(() => pruneContextUsageCache(), 15_000);

    let permissionState: "unknown" | "granted" | "denied" = "unknown";
    // Establish notification permission EAGERLY at startup. The old lazy path
    // only asked the OS the first time a notification fired while unfocused —
    // so if every agent turn finished while Atlas was focused, permission was
    // never granted and the first real (background) notification was lost to
    // the permission prompt. Priming it here means later notifications just
    // fire. (Best-effort; macOS still needs the app code-signed to deliver.)
    void (async () => {
      try {
        permissionState = (await isPermissionGranted())
          ? "granted"
          : (await requestPermission()) === "granted"
            ? "granted"
            : "denied";
      } catch {
        /* permission unavailable — notifications silently no-op */
      }
    })();
    // Name the SESSION's workspace, not the active project — a finish in
    // workspace B while A is focused used to read "Atlas — A".
    const sessionProjectName = (acpSessionId: string): string => {
      const sess = Object.values(useChatStore.getState().sessions).find(
        (s) => s.acpSessionId === acpSessionId,
      );
      const byPath = useWorkspaceStore
        .getState()
        .workspaces.find((w) => w.path === sess?.workingDirectory)?.name;
      return byPath ?? useProjectStore.getState().currentProject?.name ?? "Atlas";
    };
    const notifyAgentDone = async (acpSessionId: string) => {
      if (windowFocused) return;
      try {
        if (permissionState === "unknown") {
          const granted = (await isPermissionGranted())
            ? true
            : (await requestPermission()) === "granted";
          permissionState = granted ? "granted" : "denied";
        }
        if (permissionState !== "granted") return;
        sendNotification({
          title: `Atlas: ${sessionProjectName(acpSessionId)}`,
          body: "Agent task finished.",
        });
      } catch (e) {
        console.warn("agent-done notification failed:", e);
      }
    };

    // Sibling of notifyAgentDone — fires when the agent issues a
    // permission_request and the window isn't focused. Shares the
    // permission state machine and focus tracker above so we never
    // double-prompt for OS notification access.
    const notifyPermissionRequested = async (toolTitle: string, acpSessionId: string) => {
      if (windowFocused) return;
      try {
        if (permissionState === "unknown") {
          const granted = (await isPermissionGranted())
            ? true
            : (await requestPermission()) === "granted";
          permissionState = granted ? "granted" : "denied";
        }
        if (permissionState !== "granted") return;
        sendNotification({
          title: `Atlas: ${sessionProjectName(acpSessionId)} needs permission`,
          body: `Approve "${toolTitle}" to continue.`,
        });
      } catch (e) {
        console.warn("permission-request notification failed:", e);
      }
    };

    /** Longest a batch may be held for an active scroll gesture. Bounded so a
     *  continuous fling can never starve the stream — worst case the reader
     *  sees updates land ~2-3× per second instead of per frame while flicking. */
    const SCROLL_HOLD_MAX_MS = 400;
    /** When the oldest un-flushed delta was buffered (null = buffer empty). */
    let oldestBufferedAt: number | null = null;

    const flush = (force = false) => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (backstopId !== null) {
        clearTimeout(backstopId);
        backstopId = null;
      }
      if (pendingDeltas.length === 0) {
        oldestBufferedAt = null;
        return;
      }
      // Mid-fling, hold the batch: applying it re-renders ChatPanel →
      // Transcript → a reconcile of every mounted row, and when that lands in
      // a momentum-scroll frame WKWebView misses tile deadlines — the
      // viewport blanks. Deltas keep buffering; they land the moment the
      // gesture goes quiet or the hold cap expires.
      if (
        !force &&
        isScrollHot() &&
        oldestBufferedAt !== null &&
        performance.now() - oldestBufferedAt < SCROLL_HOLD_MAX_MS
      ) {
        backstopId = setTimeout(flush, 100);
        return;
      }
      oldestBufferedAt = null;
      const deltas = pendingDeltas.slice();
      pendingDeltas.length = 0;
      toolDeltaPos.clear();
      outputChunkPos.clear();
      try {
        useChatStore.getState().actions.applyAgentBatch({ texts: [], thoughts: [], deltas });
      } catch (e) {
        // The batch is already out of the buffer, so it is lost either way —
        // re-queueing a batch that throws would just loop on it forever. What
        // must NOT happen is the exception escaping into the RAF/timer callback
        // and taking the scheduler down with it: every later delta would then
        // buffer against a drain that never runs again, which presents as the
        // thread freezing mid-turn.
        console.error("applyAgentBatch failed; dropped", deltas.length, "deltas:", e);
      }
    };
    // Coalesce a streaming text/thinking chunk into the trailing pendingDeltas
    // entry when it's the same kind + session; otherwise append in order. Keeps
    // the per-frame coalescing win without divorcing text from its wire order.
    const bufferChunk = (env: AgentDelta) => {
      const last = pendingDeltas[pendingDeltas.length - 1];
      if (
        last &&
        (last.kind === "text_chunk" || last.kind === "thinking_chunk") &&
        last.kind === env.kind &&
        last.session_id === env.session_id
      ) {
        pendingDeltas[pendingDeltas.length - 1] = {
          ...last,
          delta: last.delta + (env as typeof last).delta,
        };
      } else {
        pendingDeltas.push(env);
      }
    };
    // Two independent drains, because RAF alone is not a guarantee that the
    // buffer is ever emptied.
    //
    // WebKit pauses `requestAnimationFrame` whenever the WKWebView isn't
    // frontmost — not just when it's hidden. A user who leaves Atlas on screen
    // while working in another app is watching a window whose RAF queue is
    // stopped: deltas keep arriving over IPC and keep buffering, and NOTHING
    // renders. The whole turn then lands in one batch the instant something
    // wakes the webview, which reads as "it was stuck, then it caught up".
    // `atlas:window-active` covered part of this, but only on a focus/visibility
    // edge — it can't help a reader watching an unfocused window.
    //
    // `setTimeout` is throttled in that state (to roughly a second) but never
    // paused, so it is the drain that always eventually fires. When RAF is
    // healthy it wins every race and clears the backstop, so this costs one
    // cancelled timer per frame and changes nothing about normal streaming.
    const BACKSTOP_MS = 250;
    const schedule = () => {
      if (oldestBufferedAt === null) oldestBufferedAt = performance.now();
      if (rafId === null) rafId = requestAnimationFrame(() => flush());
      if (backstopId === null) backstopId = setTimeout(flush, BACKSTOP_MS);
    };

    // When the webview is hidden/throttled, requestAnimationFrame is paused, so
    // buffered deltas (incl. a turn's terminal + the next turn's "running") sit
    // unapplied until the next frame. Flush immediately on wake so status
    // ordering is applied promptly and a stale "done" can't visibly linger.
    const flushOnWake = () => flush();
    window.addEventListener("atlas:window-active", flushOnWake);

    // A turn_finished / turn_failed for a turn already superseded by a newer
    // send (parallel / queued / wake timing) must not fire a "done"
    // notification or a memory reindex — mirror the chat-store's stale-turn
    // guard here so side effects don't run for a turn the store will ignore.
    const isStaleAgentTurn = (sessionId: string, turnSeq?: number): boolean => {
      if (!turnSeq) return false;
      for (const sess of Object.values(useChatStore.getState().sessions)) {
        if (sess.acpSessionId === sessionId) return turnSeq < (sess.currentTurnSeq ?? 0);
      }
      return false;
    };

    const bufferDelta = (env: AgentDelta) => {
      // Coalesce same-id `tool_call_upserted` events: replace the
      // entry at the position the tool first appeared so the latest
      // state lands and ordering vs other events stays correct.
      if (env.kind === "tool_call_upserted") {
        const key = `${env.session_id}::${env.tool_call.id}`;
        const existing = toolDeltaPos.get(key);
        if (existing !== undefined) {
          pendingDeltas[existing] = env;
          return;
        }
        toolDeltaPos.set(key, pendingDeltas.length);
      }
      pendingDeltas.push(env);
    };

    // Coalesce incremental live tool output. Priority order matters for
    // correctness, not just batching:
    // 1. A full `tool_call_upserted` snapshot for this tool is already
    //    buffered — fold the delta into ITS `result`. A separate chunk entry
    //    would double-apply: a later snapshot replaces that buffer slot with
    //    a result that already contains every earlier chunk, and the stray
    //    chunk entry would then append the same bytes again.
    // 2. This tool's previous buffered entry is a chunk — concatenate.
    // 3. Fresh chunk entry. (Chunks buffered BEFORE a tool's first snapshot
    //    of the frame stay safe: they apply first and the later snapshot
    //    replaces the result wholesale.)
    const bufferOutputChunk = (env: Extract<AgentDelta, { kind: "tool_call_output_chunk" }>) => {
      const key = `${env.session_id}::${env.tool_call_id}`;
      const upsertAt = toolDeltaPos.get(key);
      if (upsertAt !== undefined) {
        const entry = pendingDeltas[upsertAt];
        if (entry?.kind === "tool_call_upserted") {
          pendingDeltas[upsertAt] = {
            ...entry,
            tool_call: {
              ...entry.tool_call,
              result: (entry.tool_call.result ?? "") + env.delta,
            },
          };
          return;
        }
      }
      const chunkAt = outputChunkPos.get(key);
      const prev = chunkAt !== undefined ? pendingDeltas[chunkAt] : undefined;
      if (prev?.kind === "tool_call_output_chunk" && chunkAt !== undefined) {
        pendingDeltas[chunkAt] = { ...prev, delta: prev.delta + env.delta };
        return;
      }
      outputChunkPos.set(key, pendingDeltas.length);
      pendingDeltas.push(env);
    };

    // Resolve the chat tab + title for an ACP session, for in-app notifications.
    const agentSessionInfo = (acpSessionId: string) => {
      const sessions = useChatStore.getState().sessions;
      for (const [tabId, s] of Object.entries(sessions)) {
        if (s.acpSessionId === acpSessionId) return { tabId, title: s.title };
      }
      return {
        tabId: undefined as string | undefined,
        title: undefined as string | undefined,
      };
    };
    const notify = () => useNotificationsStore.getState().actions;

    // In-app toast for events from a session the user ISN'T looking at (another
    // tab or another workspace) — the OS notification only fires when the whole
    // window is unfocused, so without this a background workspace's permission
    // prompt was invisible until the user happened to switch. Click jumps to
    // the owning workspace + tab.
    const toastBackgroundSession = (
      tabId: string | undefined,
      acpSessionId: string,
      title: string,
      body: string,
      kind: "attention" | "done" | "failed",
    ) => {
      if (!tabId) return;
      if (useLayoutStore.getState().activeTabId === tabId) return;
      const wsName = (() => {
        const path = useChatStore.getState().sessions[tabId]?.workingDirectory;
        if (!path) return null;
        const ws = useWorkspaceStore.getState();
        const w = ws.workspaces.find((x) => x.path === path);
        return w && w.id !== ws.activeWorkspaceId ? w.name : null;
      })();
      const fn = kind === "failed" ? toast.error : kind === "done" ? toast.success : toast;
      fn(wsName ? `${title} — ${wsName}` : title, {
        id: `bg-session-${kind}-${acpSessionId}`,
        description: body,
        duration: kind === "attention" ? 15000 : 5000,
        action: {
          label: "Open",
          onClick: () => void jumpToSession(tabId),
        },
      });
    };

    // After a native-agent turn that may have changed files, refresh the
    // project's codebase index (incremental + structural — cheap, no LLM) so
    // `search_memory` and the Memory tab stay current. Debounced per project so
    // a burst of turns triggers one rebuild.
    const indexTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const autoIndexAfterTurn = (acpSessionId: string) => {
      const sessions = useChatStore.getState().sessions;
      const sess = Object.values(sessions).find((s) => s.acpSessionId === acpSessionId);
      if (sess?.agentType !== "cersei") return;
      const path = sess.workingDirectory;
      if (!path) return;
      const existing = indexTimers.get(path);
      if (existing) clearTimeout(existing);
      indexTimers.set(
        path,
        setTimeout(() => {
          indexTimers.delete(path);
          // Broadcast index activity so the composer's memory pill can show
          // "Indexing…" then refresh its status.
          const emit = (active: boolean) =>
            window.dispatchEvent(
              new CustomEvent("atlas:cersei-index", {
                detail: { path, active },
              }),
            );
          emit(true);
          void invoke("codebase_index_build", {
            projectPath: path,
            opts: { mode: "incremental", backend: "structural" },
          })
            .catch((err) => console.warn("auto codebase index failed:", err))
            .finally(() => emit(false));
        }, 4000),
      );
    };

    // Record a chat into the sidebar "Chats" (recently-invoked) list whenever a
    // session sees meaningful activity. Resolves project + title from the chat
    // session that owns this acpSessionId.
    const recordRecentChat = (acpSessionId: string) => {
      const sessions = useChatStore.getState().sessions;
      for (const [tabId, s] of Object.entries(sessions)) {
        if (s.acpSessionId !== acpSessionId) continue;
        const path = s.workingDirectory;
        if (!path) return;
        useRecentChatsStore.getState().actions.record({
          tabId,
          projectPath: path,
          projectName: path.split("/").pop() || path,
          // Strip any Atlas-injected memory scaffolding the title may carry
          // (resumed sessions); a dirty fragment cleans to "" → fall back.
          title: stripInjectedContext(s.title) || "Chat",
          status: s.status,
          agentType: s.agentType,
          acpSessionId: s.acpSessionId,
          updatedAt: Date.now(),
        });
        return;
      }
    };

    listenAgents((env) => {
      if (cancelled) return;
      if (
        env.kind === "status" ||
        env.kind === "message_appended" ||
        env.kind === "turn_finished"
      ) {
        recordRecentChat(env.session_id);
      }
      const actions = useChatStore.getState().actions;
      switch (env.kind) {
        case "text_chunk":
          bufferChunk(env);
          schedule();
          return;
        case "thinking_chunk":
          bufferChunk(env);
          schedule();
          return;
        case "tool_call_output_chunk":
          bufferOutputChunk(env);
          schedule();
          return;
        case "permission_request": {
          // Permission requests block the agent waiting for the user
          // — apply synchronously so the modal opens on the very next
          // tick, not the next RAF (which can be ~16 ms away or more
          // if the frame is busy with a flush of accumulated chunks).
          actions.pushPermission({
            agentId: env.agent_id,
            acpSessionId: env.session_id,
            requestId: env.request_id,
            toolCall: env.tool_call as PendingPermission["toolCall"],
            options: env.options as PendingPermission["options"],
          });
          // OS notification so the user sees the request even with
          // Atlas in the background. Matches the PermissionModal's own
          // title-extraction logic.
          const tc = env.tool_call as Record<string, unknown> | undefined;
          const toolTitle =
            (typeof tc?.title === "string" && tc.title) ||
            (typeof tc?.kind === "string" && tc.kind) ||
            "tool call";
          void notifyPermissionRequested(toolTitle, env.session_id);
          {
            const info = agentSessionInfo(env.session_id);
            notify().add({
              kind: "permission",
              source: "agent",
              title: "Permission needed",
              body: `${info.title ? `${info.title} — ` : ""}approve "${toolTitle}" to continue.`,
              sessionId: env.session_id,
              tabId: info.tabId,
            });
            toastBackgroundSession(
              info.tabId,
              env.session_id,
              info.title || "Agent needs permission",
              `Approve "${toolTitle}" to continue.`,
              "attention",
            );
          }
          return;
        }
        case "permission_resolved":
          actions.popPermission(env.session_id, env.request_id);
          return;
        case "agent_disconnected":
          // Flush whatever's buffered before tearing the agent down
          // so we don't lose a final chunk to the post-disconnect
          // discard. `flush` cancels both pending drains itself.
          // Forced: teardown correctness outranks the scroll-hold.
          flush(true);
          actions.clearPermissionsForAgent(env.agent_id);
          // Reset the spawn cache for the plugin that actually died — the old
          // resetDefaultAgent() only ever cleared claude-code-ts, so a crashed
          // Codex adapter stayed cached-dead until app restart (H4).
          resetAgentByAgentId(env.agent_id);
          // Let the reducer flag the affected session (drives the Restart
          // affordance + rebind-on-next-send).
          bufferDelta(env);
          schedule();
          logEvent({
            source: "atlas",
            kind: "agent-disconnected",
            summary: "Agent process disconnected; its spawn cache was reset",
            status: "failure",
            payload: { agentId: env.agent_id, reason: env.reason },
          });
          return;
        case "turn_finished":
          // Still pass through to the chat-store so session.status
          // flips back to "idle" (see chat-store.ts:591).
          bufferDelta(env);
          schedule();
          // Superseded by a newer send → the store ignores the idle flip; skip
          // the "done" notification, memory reindex, and log too.
          if (isStaleAgentTurn(env.session_id, env.turn_seq)) return;
          // Keep the native agent's project memory fresh (debounced, cheap).
          if (env.stop_reason !== "cancelled") autoIndexAfterTurn(env.session_id);
          logEvent({
            source: "atlas",
            kind: "agent-turn-finished",
            summary: `Agent turn finished (${env.stop_reason})`,
            status: env.stop_reason === "cancelled" ? "failure" : "success",
            payload: {
              agentId: env.agent_id,
              sessionId: env.session_id,
              stopReason: env.stop_reason,
            },
          });
          // Fire OS notification if the window isn't focused. Skip
          // user-cancelled turns — that's a click the user just made,
          // they don't need to be told about it.
          if (env.stop_reason !== "cancelled") {
            void notifyAgentDone(env.session_id);
            const info = agentSessionInfo(env.session_id);
            notify().add({
              kind: "agent-done",
              source: "agent",
              title: info.title || "Agent",
              body: "Task finished.",
              sessionId: env.session_id,
              tabId: info.tabId,
            });
            toastBackgroundSession(
              info.tabId,
              env.session_id,
              info.title || "Agent",
              "Task finished.",
              "done",
            );
          }
          return;
        case "turn_failed": {
          bufferDelta(env);
          schedule();
          if (isStaleAgentTurn(env.session_id, env.turn_seq)) return;
          const info = agentSessionInfo(env.session_id);
          notify().add({
            kind: "agent-failed",
            source: "agent",
            title: info.title || "Agent failed",
            body: (env as { error?: string }).error || "The agent run failed.",
            sessionId: env.session_id,
            tabId: info.tabId,
          });
          toastBackgroundSession(
            info.tabId,
            env.session_id,
            info.title || "Agent failed",
            (env as { error?: string }).error || "The agent run failed.",
            "failed",
          );
          return;
        }
        default:
          bufferDelta(env);
          schedule();
          return;
      }
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });

    // Agent spawn is deferred until the user first focuses the message input
    // (see `MessageInput`'s focus handler). `npx -y @zed-industries/claude-code-acp`
    // can take 10–30s on a cold npm cache; doing it at app boot adds visible
    // latency to first paint and races the project-rehydration cascade. The
    // user is unlikely to send a prompt within the first few hundred ms of
    // focusing the composer, so the spawn finishes in the background while
    // they type.

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (backstopId !== null) clearTimeout(backstopId);
      window.removeEventListener("atlas:window-active", flushOnWake);
      unlistenFocus?.();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pointerdown", onUserActivity);
      window.removeEventListener("keydown", onUserActivity);
      window.removeEventListener("wheel", onUserActivity);
      window.clearInterval(keepWarm);
      window.clearTimeout(pruneTimer);
      indexTimers.forEach((t) => clearTimeout(t));
      unlisten?.();
    };
  }, []);

  // Live file-tree updates. The fileindex watcher (started in
  // `fileindex_open_project`) emits `atlas:explorer:changed` with the
  // set of parent directories touched in each debounced batch. We
  // reconcile each loaded directory in place — agent-side file writes
  // appear in the tree without the user touching a refresh button.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    type Payload = {
      workspaceId?: string;
      dirs: string[];
      fullRefresh: boolean;
    };
    listen<Payload>("atlas:explorer:changed", (e) => {
      if (cancelled) return;
      // Ignore changes from a backgrounded workspace's resident watcher —
      // only the active workspace's explorer should reconcile.
      const active = activeWorkspaceId();
      if (e.payload.workspaceId && active && e.payload.workspaceId !== active) {
        return;
      }
      const actions = useExplorerStore.getState().actions;
      const { dirs, fullRefresh } = e.payload;
      if (fullRefresh) {
        void actions.refresh();
        return;
      }
      for (const dir of dirs) {
        void actions.reconcileDirectory(dir);
      }
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Auto-save editor state when tabs change
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!currentProject) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      useLayoutStore.getState().actions.saveEditorState(currentProject.path);
    }, 1000);
    return () => clearTimeout(saveTimerRef.current);
  }, [tabs.length, activeTabId, groupOrder, focusedGroupId, currentProject]);

  // Maintain the chat-mention picker's "recent files" queue. Push whenever
  // an editor/media/unsupported tab appears whose data.filePath we haven't
  // seen yet in this session. Centralizing here means every call site that
  // opens a file (FilePicker, explorer, message-item link, analysis,
  // git diff, …) feeds the recents list without each having to remember to.
  const seenFileTabsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const projectPath = currentProject?.path ?? "";
    for (const t of tabs) {
      if (t.type !== "editor" && t.type !== "media" && t.type !== "unsupported") continue;
      const absPath = (t.data as Record<string, unknown> | undefined)?.filePath as
        | string
        | undefined;
      if (!absPath) continue;
      if (seenFileTabsRef.current.has(absPath)) continue;
      seenFileTabsRef.current.add(absPath);
      const rel =
        projectPath && absPath.startsWith(projectPath + "/")
          ? absPath.slice(projectPath.length + 1)
          : (absPath.split("/").pop() ?? absPath);
      useRecentFilesStore.getState().actions.push({ absPath, rel });
    }
  }, [tabs, currentProject?.path]);

  // FileIndex lifecycle: open the backend file index on project change,
  // close on project clear. The backend handles fs-watch and incremental
  // updates from that point — Cmd+P queries against the live index.
  useEffect(() => {
    if (!currentProject) {
      fileIndex.closeProject().catch(() => {});
      markFileIndexClosed();
      // Deliberately does NOT stop git watchers. This branch runs whenever the
      // *current* project becomes null, but watchers are per-workspace and a
      // backgrounded workspace must keep watching — its commits still need
      // linking to its Sessions. Tearing one down is `teardownHot`'s job, with
      // the workspace id it actually owns.
      void invoke("recent_files_close_project").catch(() => {});
      // Drop the mention cache so the @-picker doesn't briefly
      // surface the previous project's notes / symbols on a fresh
      // open. Replays land via knowledge/analysis store hydration.
      void invoke("mention_cache_clear").catch(() => {});
      return;
    }
    // Deliberately NOT `markFileIndexClosed()` here: switching projects keeps
    // every hot workspace's Rust index resident (`fileindex_open_project` is
    // idempotent for a live one), so previously-confirmed roots stay valid —
    // clearing them made the first Cmd+P/@ after every switch pay a status
    // round-trip. Roots are forgotten where indexes actually die: project
    // close (above) and workspace teardown (`markFileIndexClosedFor`).
    const workspaceId = activeWorkspaceId();
    void openFileIndex(currentProject.path);
    // Git watcher: emits `atlas:git-changed` on commit / checkout /
    // branch ops. Replaces the 3-second polling that git-graph-panel
    // used to do via `refetchInterval` on `git_graph_signature`.
    // Keyed by workspace so each open workspace keeps its own resident watcher.
    void invoke("git_watch_start", {
      projectPath: currentProject.path,
      workspaceId,
    }).catch((e) => console.warn("git watch start failed:", e));
    // Capture: a bound Workspace just became active — open its store (which
    // also heals a folder rename) and kick its transcript import and drain.
    // A no-op for Workspaces that never enabled capture.
    void invoke("capture_activate", { projectPath: currentProject.path }).catch((e) =>
      console.warn("capture activate failed:", e),
    );
    // Clear the global recents mirror SYNCHRONOUSLY before the async reload so
    // there's no window where it still shows the previous project's files
    // (the picker also filters by project as a belt-and-suspenders guard).
    useRecentFilesStore.getState().actions.hydrate([]);
    // Recent-files state: Rust loads `<project>/.atlas/recent-files.json`
    // and returns the list. We hydrate the JS mirror with it so the
    // mention picker's "Recent files" section is correct from the
    // first render of the new project.
    void invoke<RecentFile[]>("recent_files_open_project", {
      projectPath: currentProject.path,
      workspaceId,
    })
      .then((items) => {
        useRecentFilesStore.getState().actions.hydrate(items);
      })
      .catch((e) => console.warn("recent_files_open_project failed:", e));
  }, [currentProject?.path]);

  // Native window title: `projectName - Atlas` while a project is open,
  // plain `Atlas` otherwise. This is what macOS shows on the window-menu,
  // on minimize, and on title hover.
  useEffect(() => {
    const title = currentProject ? `${currentProject.name} - Atlas` : "Atlas";
    void invoke("set_window_title", { title }).catch(() => {});
  }, [currentProject?.name]);

  // Install the singleton listener for `atlas:recent-files-changed`
  // once — every push from Rust patches the mirror in place.
  useEffect(() => {
    ensureRecentFilesListener();
  }, []);

  // Quit durability: per-switch flushes are fire-and-forget, so on window
  // close flush the ACTIVE workspace's pending writes (background workspaces
  // were already flushed when we left them). beforeunload can't await, but it
  // cancels the debounce and kicks the write immediately.
  useEffect(() => {
    const onBeforeUnload = () => {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      const path = useProjectStore.getState().currentProject?.path ?? null;
      // Capture first so the flush dedup compares against the CURRENT state
      // (not a stale capture from the last switch-away).
      if (wsId) captureSnapshot(wsId);
      void flushAll({ workspaceId: wsId, path });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Chords live in the active keybinding profile (Settings → Keybindings);
  // this is only the action-id → behaviour map. See
  // `src/features/keybindings/lib/actions.ts` for the registry.
  useActionHotkeys({
    // ⌘⇧N — "new workspace": pick a folder and add it as a workspace in
    // this window (Atlas is single-window now; this replaces the old
    // "open a new native window" behaviour).
    "workspace.add": () => {
      void pickAndAddWorkspace();
    },
    // ⌘⇧. — toggle the Arc-like workspace sidebar. (⌘. alone is the macOS
    // system "Cancel" chord and gets swallowed before reaching the webview.)
    "workspace.toggleSidebar": () => useWorkspaceStore.getState().actions.toggleSidebar(),
    "nav.commandPalette": () => setCommandPaletteOpen(true),
    "nav.filePicker": () => setFilePickerOpen(true),
    "nav.search": () => setSearchOpen(true),
    "panels.left": toggleLeftPanel,
    "panels.right": toggleRightPanel,
    // ⌘⇧C — team chat. Shares the right slot with source control: pressing
    // this while source control is open swaps the occupant rather than
    // opening a second panel, and pressing it again closes the slot.
    "panels.teamChat": toggleRightChatPanel,
    "panels.terminal": toggleTerminal,
    "panels.bottom": toggleBottomPanel,
    "panels.agentSidebar": toggleChatSidebar,
    // ⌥J — open the Knowledge Base, or jump to it if already open, WITHIN
    // the focused split column.
    "panels.knowledge": () => {
      const st = useLayoutStore.getState();
      const g = st.focusedGroupId;
      const existing = st.tabs.find((t) => (t.groupId ?? "main") === g && t.type === "knowledge");
      if (existing) {
        setActiveTab(existing.id);
        return;
      }
      addTab({
        id: `knowledge-${Date.now()}`,
        type: "knowledge",
        title: "Knowledge",
        closable: true,
        dirty: false,
        data: {},
      });
    },
    "panels.tabBar": toggleTabBar,
    // ⌘1–8 select by index; ⌘9 always jumps to the LAST tab (browser
    // convention) — the store treats i<0 as "last".
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `tabs.focus${i + 1}`,
        i === 8 ? () => activateTabByIndex(-1) : () => activateTabByIndex(i),
      ]),
    ),
    "tabs.close": () => {
      const current = useLayoutStore.getState().activeTabId;
      if (current) requestCloseTab(current);
    },
    "tabs.prev": () => cycleTab(-1),
    "tabs.next": () => cycleTab(1),
    // ── Split view ──
    "split.new": () => addGroup(),
    "split.focusLeft": () => focusAdjacentGroup(-1),
    "split.focusRight": () => focusAdjacentGroup(1),
    // Close the focused split column (tabs move to the left neighbour).
    "split.close": () => closeGroup(useLayoutStore.getState().focusedGroupId),
    // Zen mode: Knowledge │ Chat │ Browser, side panels hidden. Again restores.
    "panels.zen": () => {
      if (currentProject) toggleZenMode();
    },
    // ⌥/ — cycle the coding agent (Claude Code → Codex → Atlas → …). A
    // session is paired to one agent: an empty chat flips in place; a started
    // chat opens a NEW chat bound to the next agent (per the pairing rule).
    "chat.cycleAgent": () => {
      const layout = useLayoutStore.getState();
      const tab = layout.tabs.find((t) => t.id === layout.activeTabId);
      if (!tab || tab.type !== "chat") return;
      cycleChatAgent(tab.id);
    },
    // ⌘T — new agent chat. Singleton: focuses the existing chat tab and resets
    // it to a fresh session rather than opening a second chat tab.
    "tabs.newChat": () => openNewAgentChat(),
    // ⌘N — new untitled editor. The synthetic `untitled:<ts>` path
    // tells the editor to start with an empty buffer and to fall
    // into the save-as flow on ⌘S (see `editor-panel.tsx`).
    "tabs.newUntitled": () => {
      const ts = Date.now();
      addTab({
        id: `editor-untitled-${ts}`,
        type: "editor",
        title: "Untitled",
        closable: true,
        dirty: false,
        data: { filePath: `untitled:${ts}` },
      });
    },
    // Keyboard-first equivalent of the `+` button's dropdown.
    "nav.newTabPalette": () => setNewTabPaletteOpen(true),
    "nav.layoutSwitcher": () => setLayoutSwitcherOpen(true),
    "tabs.newTerminal": () =>
      addTab({
        id: `terminal-${Date.now()}`,
        type: "terminal",
        title: "Terminal",
        closable: true,
        dirty: false,
        data: {},
      }),
    "app.settings": () =>
      addTab({
        id: "settings",
        type: "settings",
        title: "Settings",
        closable: true,
        dirty: false,
        data: {},
      }),
    // Session Capture (the popover behind the titlebar's project pill). Local
    // `captureOpen` state lives in `ProjectLabel`, so this reaches it via the
    // same `atlas:open-capture` event the command palette entry dispatches.
    "app.capture": () => window.dispatchEvent(new CustomEvent("atlas:open-capture")),
    // ── Interface zoom ──
    "view.zoomIn": zoomIn,
    "view.zoomOut": zoomOut,
    "view.zoomReset": zoomReset,
  });

  return (
    // One provider at the root so every tooltip in the app shares a delay and
    // a SKIP group: hovering along a facepile shows each name instantly after
    // the first, instead of re-waiting per avatar.
    <TooltipProvider>
      <AppContextMenu>
        <div className="h-screen w-screen" onContextMenu={(e) => e.preventDefault()}>
          <AppLayout />
        </div>
      </AppContextMenu>
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      <NewTabPalette open={newTabPaletteOpen} onOpenChange={setNewTabPaletteOpen} />
      <LayoutSwitcher open={layoutSwitcherOpen} onOpenChange={setLayoutSwitcherOpen} />
      <SearchOverlay open={searchOpen} onOpenChange={setSearchOpen} />
      <FilePicker open={filePickerOpen} onOpenChange={setFilePickerOpen} />
      <HintOverlay />
      <AgentOAuthModalHost />
      {/* Sign-in asks questions of its own (device codes, login URLs), and they
          arrive before the agent has any session to route them by. */}
      <AgentElicitationHost />
      <NotificationPanel />
      <FeedbackPanel />
      <UpdateAvailableModal />
      <ConnectDialog />
      <LoadingOrganisationOverlay />
      <StopAgentsDialog />
      <BrowserOverlayWatcher />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            fontSize: "var(--font-size-sm)",
          },
        }}
      />
    </TooltipProvider>
  );
}
