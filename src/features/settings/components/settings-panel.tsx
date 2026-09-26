import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ScrollArea } from "@/ui/scroll-area";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { Hint } from "@/ui/tooltip";
import {
  Settings,
  Palette,
  Shapes,
  Keyboard,
  Info,
  KeyRound,
  LayoutTemplate,
  Zap,
  WandSparkles,
  Boxes,
  Plus,
  Minus,
  ChevronLeft,
  ChevronRight,
  DownloadCloud,
} from "lucide-react";
import { clampScale, SCALE_STEP, MIN_SCALE, MAX_SCALE, DEFAULT_SCALE } from "../lib/ui-scale";
import { APP_ICONS } from "../lib/app-icons";
import { AtlasIcon } from "@/components/atlas-icon";
import { ProvidersSettings } from "./providers-settings";
import { LayoutsSettings } from "./layouts-settings";
import { AtlasThemesSettings } from "./atlas-themes-settings";
import { IconThemesSettings } from "./icon-themes-settings";
import { SkillsAndPacks } from "./skills-and-packs";
import { AgentsMarketplace } from "./agents-marketplace/agents-marketplace";
import { ModelsManager } from "./models-manager";
import { KeybindingsSettings } from "./keybindings-settings";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useModelPricingStore } from "../stores/model-pricing-store";
import { setEnabled as setTelemetryEnabled } from "@/features/telemetry/posthog-client";
import { useFeedbackStore } from "@/features/feedback/stores/feedback-store";
import { updater } from "@/features/updater/lib/updater-api";
import { useUpdaterStore } from "@/features/updater/stores/updater-store";
import { isLinux, isWindows } from "@/lib/platform";
import { useSettingsNav, type SettingsSection } from "../stores/settings-nav-store";
import { openConfigFile } from "../lib/atlas-config-api";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";

const SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  icon: typeof Settings;
}> = [
  { id: "general", label: "General", icon: Settings },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "icons", label: "Icons", icon: Shapes },
  { id: "layouts", label: "Layouts", icon: LayoutTemplate },
  { id: "providers", label: "API Keys", icon: KeyRound },
  { id: "skills", label: "Skills", icon: Zap },
  { id: "agents", label: "Agents", icon: WandSparkles },
  { id: "models", label: "Local Models", icon: Boxes },
  { id: "updates", label: "Updates", icon: DownloadCloud },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
];

const NAV_COLLAPSED_KEY = "atlas:settings:navCollapsed";

export function SettingsPanel({ initialSection }: { initialSection?: string } = {}) {
  const [activeSection, setActiveSection] = useState(initialSection ?? "general");

  // Honor cross-component "open Settings → <section>" requests (e.g. the
  // sidebar's Skills button), whether this panel is fresh or already mounted.
  const navSection = useSettingsNav((s) => s.section);
  const clearNav = useSettingsNav((s) => s.clear);
  useEffect(() => {
    if (navSection) {
      setActiveSection(navSection);
      clearNav();
    }
  }, [navSection, clearNav]);
  // Installed agents whose copy on disk is behind the registry. Background
  // prefetch clears most of these on its own; what is left (offline, npm
  // failing) is what needs the user's hand, so the nav says so.
  const agentUpdates = useAgentRegistryStore(
    (s) => s.registryEntries.filter((e) => e.installed && e.updateAvailable).length,
  );
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleNav = () =>
    setNavCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  return (
    <div className="h-full flex">
      {/* Settings nav — collapses to an icon rail (labels become tooltips). */}
      <div
        className={cn(
          "shrink-0 border-r border-border bg-background pt-2 flex flex-col",
          navCollapsed ? "w-[44px]" : "w-[180px]",
        )}
      >
        <div className="flex-1">
          {SECTIONS.map((s) => {
            const badge = s.id === "agents" ? agentUpdates : 0;
            const item = (
              <button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                className={cn(
                  "w-full flex items-center h-[32px] whitespace-nowrap text-xs font-medium transition-colors border-l-2 cursor-pointer",
                  navCollapsed ? "justify-center px-0" : "gap-2 px-4",
                  activeSection === s.id
                    ? "text-foreground bg-element-selected border-l-primary"
                    : "text-secondary-foreground hover:bg-element-hover border-l-transparent",
                )}
              >
                <span className="relative shrink-0 flex">
                  <s.icon size={13} />
                  {navCollapsed && badge > 0 && (
                    <span className="pointer-events-none absolute -right-1 -top-1 size-1.5 rounded-full bg-[var(--primary)]" />
                  )}
                </span>
                {!navCollapsed && s.label}
                {!navCollapsed && badge > 0 && (
                  <span className="ml-auto min-w-4 h-4 px-1 rounded-full bg-[var(--primary)] text-primary-foreground text-3xs leading-4 text-center tabular-nums">
                    {badge}
                  </span>
                )}
              </button>
            );
            const label =
              badge > 0 ? `${s.label} — ${badge} update${badge === 1 ? "" : "s"} waiting` : s.label;
            return navCollapsed ? (
              <Hint key={s.id} label={label} side="right">
                {item}
              </Hint>
            ) : (
              item
            );
          })}
        </div>

        {/* Hide / show toggle — divided from the section list. */}
        <Hint label={navCollapsed ? "Show sidebar" : "Hide sidebar"} side="right">
          <button
            onClick={toggleNav}
            className={cn(
              "mt-1 flex items-center h-[30px] whitespace-nowrap border-t border-border text-xs font-medium text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer",
              navCollapsed ? "justify-center px-0" : "gap-2 px-4",
            )}
          >
            {navCollapsed ? (
              <ChevronRight size={14} className="shrink-0" />
            ) : (
              <>
                <ChevronLeft size={14} className="shrink-0" />
                <span>Hide</span>
              </>
            )}
          </button>
        </Hint>
      </div>

      {/* Settings content. The providers ("API Keys") and skills sections are
          full-bleed — each owns its own toolbar + scrolling layout and fills
          the area edge to edge, so they render outside the padded/max-width
          wrapper. (Skills uses a list + right-hand detail pane that needs the
          room.) */}
      {activeSection === "providers" ? (
        <div className="flex-1 min-w-0 min-h-0">
          <ProvidersSettings />
        </div>
      ) : activeSection === "skills" ? (
        <div className="flex-1 min-w-0 min-h-0">
          <SkillsAndPacks />
        </div>
      ) : activeSection === "agents" ? (
        <div className="flex-1 min-w-0 min-h-0">
          <AgentsMarketplace />
        </div>
      ) : activeSection === "models" ? (
        <div className="flex-1 min-w-0 min-h-0">
          <ModelsManager />
        </div>
      ) : activeSection === "appearance" ? (
        <div className="flex-1 min-w-0 min-h-0">
          {/* Interface zoom lives in General, so this pane is the theme picker alone. */}
          <AtlasThemesSettings />
        </div>
      ) : activeSection === "icons" ? (
        <div className="flex-1 min-w-0 min-h-0">
          <IconThemesSettings />
        </div>
      ) : activeSection === "keybindings" ? (
        <div className="flex-1 min-w-0 min-h-0">
          <KeybindingsSettings />
        </div>
      ) : (
        <ScrollArea className="flex-1 p-6">
          <div className="max-w-[500px]">
            {activeSection === "general" && <GeneralSettings />}
            {activeSection === "layouts" && <LayoutsSettings />}
            {activeSection === "updates" && <UpdatesSettings />}
            {activeSection === "about" && <AboutSettings />}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

export interface CliStatus {
  installed: boolean;
  path: string | null;
  installedVersion: string | null;
  currentVersion: string;
}

function GeneralSettings() {
  const settings = useSettingsStore.use.settings();
  const configError = useSettingsStore.use.configError();
  const { updateSettings, clearConfigError, resetConfig } = useSettingsStore.use.actions();
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [resettingConfig, setResettingConfig] = useState(false);

  const recreateConfigDefaults = async () => {
    setResettingConfig(true);
    try {
      // The store action owns both the state write and the resulting side
      // effects (theme, zoom). Doing it here with `setState` raced the
      // `atlas:config-changed` listener and skipped those side effects
      // whenever this path won.
      await resetConfig();
      toast.success("config.toml reset to defaults (previous file backed up alongside it)");
    } catch (e) {
      toast.error(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResettingConfig(false);
    }
  };

  // Model pricing (models.dev) — manual refresh + count for the picker.
  const pricingPrices = useModelPricingStore.use.prices();
  const pricingLoading = useModelPricingStore.use.loading();
  const { load: loadPricing, refresh: refreshPricing } = useModelPricingStore.use.actions();
  useEffect(() => {
    void loadPricing();
  }, [loadPricing]);
  const pricedModelCount = Object.keys(pricingPrices).filter((k) => k.includes("/")).length;
  const updatePricing = async () => {
    await refreshPricing();
    const n = Object.keys(useModelPricingStore.getState().prices).filter((k) =>
      k.includes("/"),
    ).length;
    toast.success(`Model pricing updated — ${n} models`);
  };

  useEffect(() => {
    let cancelled = false;
    void invoke<CliStatus>("cli_status")
      .then((s) => {
        if (!cancelled) setCli(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const installCli = async () => {
    setInstalling(true);
    try {
      const next = await invoke<CliStatus>("cli_install_helper");
      setCli(next);
      toast.success("Installed atlas tools");
    } catch (e) {
      toast.error(`Install failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(false);
    }
  };

  const cliInstalledLine = cli?.installed
    ? cli.installedVersion === cli.currentVersion
      ? `Installed at ${cli.path}`
      : `Installed at ${cli.path}${
          cli.installedVersion
            ? ` (version ${cli.installedVersion}, current ${cli.currentVersion})`
            : ` (version unknown, current ${cli.currentVersion})`
        }`
    : `Will install to ${cli?.path ?? "~/.local/bin/atlas"}`;

  return (
    <div className="space-y-6">
      <SectionTitle title="General" subtitle="Application preferences" />
      {configError && (
        <div className="rounded-md border border-warning/40 bg-warning-muted p-3 space-y-2">
          <p className="text-sm font-medium text-foreground">
            Atlas is using the last valid settings — config.toml has a problem
          </p>
          <p className="text-xs text-secondary-foreground font-mono break-all">{configError}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void openConfigFile()}
              className={cn(
                "h-7 rounded-md px-2.5 text-xs font-medium border border-border bg-card",
                "text-foreground hover:bg-element-hover transition-colors",
              )}
            >
              Open config
            </button>
            <button
              type="button"
              onClick={() => void recreateConfigDefaults()}
              disabled={resettingConfig}
              className={cn(
                "h-7 rounded-md px-2.5 text-xs font-medium border border-border bg-card",
                "text-foreground hover:bg-element-hover transition-colors",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {resettingConfig ? "Resetting…" : "Recreate defaults"}
            </button>
            <button
              type="button"
              onClick={clearConfigError}
              className="h-7 rounded-md px-2.5 text-xs font-medium text-secondary-foreground hover:text-foreground transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <SettingRow
        label="Interface zoom"
        description="Scales the whole interface — text, icons and spacing together."
      >
        <ZoomControl />
      </SettingRow>
      {isMac && (
        <SettingRow
          label="App icon"
          description="Changes the icon in the Dock, Finder and Launchpad. Only the default is live Liquid Glass; the others are fixed renders of theirs."
        >
          <select
            value={settings.appIcon}
            onChange={(e) => updateSettings({ appIcon: e.target.value })}
            className="h-7 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none"
          >
            {APP_ICONS.map((icon) => (
              <option key={icon.id} value={icon.id}>
                {icon.label}
              </option>
            ))}
          </select>
        </SettingRow>
      )}
      <SettingRow
        label="Enter to send"
        description="Enter sends your message; Shift+Enter inserts a newline — the Slack/Discord/ChatGPT convention. Turn off to restore the old behavior, where only ⌘/Ctrl+Enter sends and Enter always inserts a newline. ⌘/Ctrl+Enter always sends either way."
      >
        <Toggle
          checked={settings.enterToSend}
          onChange={(next) => updateSettings({ enterToSend: next })}
        />
      </SettingRow>
      <SectionTitle
        title="Terminal notifications"
        subtitle="Be told when a command finishes or wants input, wherever you are in Atlas"
      />
      <SettingRow
        label="Terminal notifications"
        description="A command that fails, runs longer than the threshold, or asks for input raises an item in the notification center, a toast when its terminal is off screen, and a macOS notification when Atlas is in the background. Nothing fires while you are looking at that terminal."
      >
        <Toggle
          checked={settings.terminalNotifications}
          onChange={(next) => updateSettings({ terminalNotifications: next })}
        />
      </SettingRow>
      <SettingRow
        label="Notify on success after"
        description="A command that succeeds faster than this stays quiet. Failures always notify (below)."
      >
        <select
          value={String(settings.terminalNotifyMinDurationMs)}
          disabled={!settings.terminalNotifications}
          onChange={(e) => updateSettings({ terminalNotifyMinDurationMs: Number(e.target.value) })}
          className="h-7 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none disabled:opacity-40"
        >
          <option value="5000">5 seconds</option>
          <option value="10000">10 seconds</option>
          <option value="30000">30 seconds</option>
          <option value="60000">1 minute</option>
          <option value="300000">5 minutes</option>
        </select>
      </SettingRow>
      <SettingRow
        label="Notify on failure"
        description="A non-zero exit code notifies regardless of how long the command ran. Ctrl-C is not a failure."
      >
        <Toggle
          checked={settings.terminalNotifyOnFailure}
          disabled={!settings.terminalNotifications}
          onChange={(next) => updateSettings({ terminalNotifyOnFailure: next })}
        />
      </SettingRow>
      <SettingRow
        label="Notify when input is needed"
        description="A password prompt, a terminal bell, or a program's own notification (OSC 9 / 777) while the terminal is not on screen."
      >
        <Toggle
          checked={settings.terminalNotifyOnAttention}
          disabled={!settings.terminalNotifications}
          onChange={(next) => updateSettings({ terminalNotifyOnAttention: next })}
        />
      </SettingRow>
      <SettingRow
        label="macOS notifications"
        description="Also raise a system notification when the Atlas window is not focused."
      >
        <Toggle
          checked={settings.terminalNotifyNative}
          disabled={!settings.terminalNotifications}
          onChange={(next) => updateSettings({ terminalNotifyNative: next })}
        />
      </SettingRow>
      <SettingRow label="Sound" description="Play a short chime with terminal notifications.">
        <Toggle
          checked={settings.terminalNotifySound}
          disabled={!settings.terminalNotifications}
          onChange={(next) => updateSettings({ terminalNotifySound: next })}
        />
      </SettingRow>

      <SectionTitle title="Behaviour" subtitle="Files, logs and the editor" />
      <SettingRow
        label="Auto-add .atlas to .gitignore"
        description="When you open a git-tracked project, Atlas adds `.atlas/` to the project's .gitignore (creating one if needed). Atlas keeps its caches and state in `.atlas/` — keeping it out of version control is almost always what you want. No-op on non-git projects."
      >
        <Toggle
          checked={settings.autoAddAtlasGitignore}
          onChange={(next) => updateSettings({ autoAddAtlasGitignore: next })}
        />
      </SettingRow>
      <SettingRow
        label="Show hidden files"
        description="Show dotfiles and dot-directories (e.g. `.git`, `.atlas`, `.env`) in the file tree. Default ON so nothing is silently hidden. Turn off for a cleaner tree that only lists your project's visible files."
      >
        <Toggle
          checked={settings.showHiddenFiles}
          onChange={(next) => updateSettings({ showHiddenFiles: next })}
        />
      </SettingRow>
      <SettingRow
        label="Inline Git blame"
        description="Show who last changed the current line, when, and the commit summary as a dim annotation at the end of the line — following your cursor. Only for files inside a git repository."
      >
        <Toggle
          checked={settings.gitBlameInline}
          onChange={(next) => updateSettings({ gitBlameInline: next })}
        />
      </SettingRow>
      <SettingRow
        label="Enable Atlas Logs"
        description="Record Atlas-internal events (sign-in, agent start/finish, browser/file open, etc.) into the Logs tab under the `atlas` source. Default ON so when something goes wrong you can open the Logs tab, filter by `atlas`, and share a timeline. Turn off if the noise bothers you."
      >
        <Toggle
          checked={settings.enableAtlasLogs}
          onChange={(next) => updateSettings({ enableAtlasLogs: next })}
        />
      </SettingRow>
      <SettingRow
        label="Share usage data"
        description="Privacy-preserving usage data (app launches, which agents and tools you use, how many files a turn touched, token counts, crashes) to help improve Atlas. Never your prompts, code, file paths, or keys. See TELEMETRY.md."
      >
        <Toggle
          checked={settings.shareTelemetry}
          onChange={(next) => {
            // Rust re-syncs the live gate itself on every settings commit
            // (`notify_settings_changed`) — this only needs to flip the
            // frontend-only `posthog-js` crash reporter, which Rust can't
            // reach.
            updateSettings({ shareTelemetry: next });
            setTelemetryEnabled(next);
          }}
        />
      </SettingRow>
      <SettingRow
        label="Link usage data to my account"
        description="While signed in, attribute usage data to your Atlas account instead of an anonymous per-device id. Turn this off to stay anonymous even when signed in — already-linked history stays linked."
      >
        <Toggle
          checked={settings.linkTelemetryToAccount}
          disabled={!settings.shareTelemetry}
          onChange={(next) => updateSettings({ linkTelemetryToAccount: next })}
        />
      </SettingRow>
      <SettingRow
        label="Send feedback"
        description="Report a bug, request a feature, or tell us what feels clumsy — with an optional screenshot. Opens a panel in the bottom-right corner."
      >
        <button
          type="button"
          onClick={() => useFeedbackStore.getState().actions.openPanel("settings")}
          className={cn(
            "h-7 rounded-md px-2.5 text-xs font-medium border border-border bg-card",
            "text-foreground hover:bg-element-hover transition-colors",
          )}
        >
          Send feedback
        </button>
      </SettingRow>
      <SettingRow
        label="Next-step suggestions"
        description="After each turn, the coding agent suggests 2-3 follow-up actions as clickable chips (click = send). It uses the agent's own live session context — no extra API key — and the request/suggestions are hidden from the thread."
      >
        <Toggle
          checked={settings.adaptiveSuggestions !== "off"}
          onChange={(next) => updateSettings({ adaptiveSuggestions: next ? "agent" : "off" })}
        />
      </SettingRow>
      <SettingRow
        label="Let Atlas Agent navigate the app"
        description="Atlas Agent can open files at a line, switch tabs and panels, fill in a chat message and type a command into a terminal for you to run. It never switches projects, sends a message for you or presses Enter. Each action shows in the chat and the Logs panel."
      >
        <Toggle
          checked={settings.agentUiNavigation}
          onChange={(next) => updateSettings({ agentUiNavigation: next })}
        />
      </SettingRow>
      <SettingRow
        label="Let Atlas Agent act in your organisation"
        description="In a Project bound to the cloud, Atlas Agent can read your organisation's recorded sessions, comments, members and conversations, and act there as you. Anything that reaches another person asks you first. Each action shows in the chat and the Logs panel."
      >
        <Toggle
          checked={settings.agentOrgAccess}
          onChange={(next) => updateSettings({ agentOrgAccess: next })}
        />
      </SettingRow>
      <SettingRow
        label="Atlas CLI"
        description={`Adds an \`atlas\` command to your shell — type \`atlas .\` in any terminal to open the current folder as a project. Refreshed automatically on every launch so an older copy never lingers. ${cliInstalledLine}.`}
      >
        <button
          type="button"
          onClick={() => void installCli()}
          disabled={installing}
          className={cn(
            "h-7 rounded-md px-2.5 text-xs font-medium border border-border bg-card",
            "text-foreground hover:bg-element-hover transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {installing ? "Installing…" : cli?.installed ? "Reinstall" : "Install"}
        </button>
      </SettingRow>
      <SettingRow
        label="Model pricing"
        description={`Per-model prices (USD / 1M tokens) from models.dev, shown in the model picker. Refreshed automatically on launch and updated only when prices change. ${pricedModelCount > 0 ? `${pricedModelCount} models priced.` : "Not yet fetched."}`}
      >
        <button
          type="button"
          onClick={() => void updatePricing()}
          disabled={pricingLoading}
          className={cn(
            "h-7 rounded-md px-2.5 text-xs font-medium border border-border bg-card",
            "text-foreground hover:bg-element-hover transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {pricingLoading ? "Updating…" : "Update pricing"}
        </button>
      </SettingRow>
    </div>
  );
}

/** Interface zoom stepper. Also reachable anywhere via the view.zoom* shortcuts. */
function ZoomControl() {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();

  const scalePct = Math.round(settings.uiScale * 100);
  const setScale = (next: number) => updateSettings({ uiScale: clampScale(next) });
  const zoomInKeys = useActionShortcut("view.zoomIn")?.label;
  const zoomOutKeys = useActionShortcut("view.zoomOut")?.label;
  const zoomResetKeys = useActionShortcut("view.zoomReset")?.label;

  return (
    <div className="flex items-center gap-1">
      <Hint label="Zoom out" shortcut={zoomOutKeys}>
        <button
          type="button"
          onClick={() => setScale(settings.uiScale - SCALE_STEP)}
          disabled={settings.uiScale <= MIN_SCALE}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full border border-border text-secondary-foreground",
            "hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          <Minus size={12} />
        </button>
      </Hint>
      <Hint label="Reset to 100%" shortcut={zoomResetKeys}>
        <button
          type="button"
          onClick={() => setScale(DEFAULT_SCALE)}
          className="h-6 min-w-[44px] rounded-md px-1.5 text-xs font-medium tabular-nums text-secondary-foreground hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer"
        >
          {scalePct}%
        </button>
      </Hint>
      <Hint label="Zoom in" shortcut={zoomInKeys}>
        <button
          type="button"
          onClick={() => setScale(settings.uiScale + SCALE_STEP)}
          disabled={settings.uiScale >= MAX_SCALE}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full border border-border text-secondary-foreground",
            "hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          <Plus size={12} />
        </button>
      </Hint>
    </div>
  );
}

function UpdatesSettings() {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const phase = useUpdaterStore.use.phase();
  const version = useUpdaterStore.use.version();
  const progress = useUpdaterStore.use.progress();
  const { beginApply, setError } = useUpdaterStore.use.actions();
  const [checking, setChecking] = useState(false);

  const downloading = phase === "downloading";
  const ready = phase === "ready" || phase === "applying";

  const checkNow = async () => {
    setChecking(true);
    try {
      const status = await updater.checkNow();
      // When an update exists, the background download starts and the store
      // reflects it below; only surface the "up to date" case here.
      if (!status.available) {
        toast.success(`You're on the latest version (${status.currentVersion}).`);
      }
    } catch (e) {
      toast.error(`Update check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  const restart = () => {
    beginApply();
    void updater.apply().catch((e) => setError(String(e)));
  };

  // The "Check for updates" row swaps its control based on the live phase:
  // downloading → progress; ready → Restart button; else → Check now.
  const control = ready ? (
    <button
      type="button"
      onClick={restart}
      className={cn(
        "h-7 rounded-md px-2.5 text-xs font-medium",
        "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 transition-opacity",
      )}
    >
      Restart to update
    </button>
  ) : downloading ? (
    <span className="text-xs text-muted-foreground tabular-nums">
      {progress != null ? `Downloading ${Math.round(progress * 100)}%` : "Preparing…"}
    </span>
  ) : (
    <button
      type="button"
      onClick={() => void checkNow()}
      disabled={checking}
      className={cn(
        "h-7 rounded-md px-2.5 text-xs font-medium border border-border bg-card",
        "text-foreground hover:bg-element-hover transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      )}
    >
      {checking ? "Checking…" : "Check now"}
    </button>
  );

  return (
    <div className="space-y-6">
      <SectionTitle title="Updates" subtitle="How Atlas keeps itself up to date" />
      <SettingRow
        label="Automatic updates"
        description={
          isWindows
            ? "Check for a newer version in the background and download the installer automatically. Windows asks for permission before it is installed. Turn off to never check or download."
            : isLinux
              ? "Check for a newer version in the background. On Linux, update via your package manager (AUR, deb, rpm) or download the latest release asset. Turn off to never check."
              : "Check for a newer version in the background and download it automatically. Updates are Apple-signed and notarized; Atlas verifies the signature before installing. Turn off to never check or download."
        }
      >
        <Toggle
          checked={settings.autoUpdate}
          onChange={(next) => updateSettings({ autoUpdate: next })}
        />
      </SettingRow>
      <SettingRow
        label="Sync the Atlas Agent's plugin catalogue"
        description="Let the agent engine fetch OpenAI's curated plugin catalogue (github.com/openai/plugins) when it starts. Off by default — it is a network request at every launch. Applies the next time the agent starts."
      >
        <Toggle
          checked={settings.curatedPluginSync}
          onChange={(next) => updateSettings({ curatedPluginSync: next })}
        />
      </SettingRow>
      <SettingRow
        label={ready ? `Update ready${version ? ` (${version})` : ""}` : "Check for updates"}
        description={
          ready
            ? "A new version has been downloaded and verified. Restart now, or it'll be applied automatically the next time you quit Atlas."
            : "Check now regardless of the automatic-update setting. Newer versions download in the background; you'll be prompted to restart when ready."
        }
      >
        {control}
      </SettingRow>
    </div>
  );
}

function AboutSettings() {
  return (
    <div className="space-y-4">
      <SectionTitle title="About" subtitle="Atlas IDE" />
      <div className="rounded-lg border border-border bg-card p-4 space-y-2">
        <div className="flex items-center gap-2">
          <AtlasIcon size={40} className="rounded-xl" />
          <div>
            <p className="text-sm font-semibold text-foreground">Atlas</p>
            <p className="text-2xs text-muted-foreground">v0.3.3 — The second brain IDE</p>
          </div>
        </div>
        <p className="text-xs text-secondary-foreground leading-relaxed pt-2">
          Built with Tauri, React, and Rust. An everything app for agentic development — from code
          analysis to task management, research, and AI orchestration.
        </p>
      </div>
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-2xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * Toggle — controlled OR uncontrolled. If `checked` is provided the parent
 * owns the state and `onChange` is fired on click; otherwise we keep
 * internal state seeded by `defaultChecked` (original behavior).
 */
export function Toggle({
  defaultChecked = false,
  checked,
  onChange,
  disabled = false,
}: {
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (next: boolean) => void;
  /** For a sub-setting whose parent is off — dimmed and inert, but still
   *  showing its own stored value rather than lying about it. */
  disabled?: boolean;
}) {
  const [internal, setInternal] = useState(defaultChecked);
  const isControlled = checked !== undefined;
  const value = isControlled ? checked : internal;
  const apply = (next: boolean) => {
    if (disabled) return;
    if (!isControlled) setInternal(next);
    onChange?.(next);
  };
  // shadcn/Radix switch proportions: the track has a 2px transparent
  // border so its inner content area is exactly the thumb's size,
  // making the thumb fill vertically and animate translate-x-0 → -x-4
  // edge to edge. The thumb flips color when ON because Atlas's accent
  // is pure white — a white-on-white thumb would disappear.
  return (
    <button
      onClick={() => apply(!value)}
      role="switch"
      aria-checked={value}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center",
        "rounded-full border-2 border-transparent transition-colors",
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
        value ? "bg-[var(--primary)]" : "bg-[var(--card)]",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full shadow-sm",
          "transition-transform duration-150",
          value ? "translate-x-4 bg-[var(--background)]" : "translate-x-0 bg-card-foreground",
        )}
      />
    </button>
  );
}
