import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ScrollArea } from "@/ui/scroll-area";
import { KbdCombo } from "@/ui/kbd";
import { cn } from "@/lib/utils";
import {
  Settings,
  Palette,
  Keyboard,
  Info,
  FlaskConical,
  KeyRound,
  LayoutTemplate,
  Zap,
  Boxes,
  Plus,
  Minus,
  ChevronLeft,
  ChevronRight,
  DownloadCloud,
} from "lucide-react";
import {
  clampScale,
  SCALE_STEP,
  MIN_SCALE,
  MAX_SCALE,
  DEFAULT_SCALE,
} from "../lib/ui-scale";
import { AtlasIcon } from "@/components/atlas-icon";
import { ProvidersSettings } from "./providers-settings";
import { LayoutsSettings } from "./layouts-settings";
import { CodeEditorThemesSettings } from "./code-editor-themes-settings";
import { AtlasThemesSettings } from "./atlas-themes-settings";
import { SkillsAndPacks } from "./skills-and-packs";
import { ModelsManager } from "./models-manager";
import { useDevFlagsStore } from "../stores/dev-flags-store";
import { useModelPricingStore } from "../stores/model-pricing-store";
import { useClaudeSetupStore } from "@/features/claude-setup/stores/claude-setup-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { setEnabled as setTelemetryEnabled } from "@/features/telemetry/posthog-client";
import { useFeedbackStore } from "@/features/feedback/stores/feedback-store";
import { updater } from "@/features/updater/lib/updater-api";
import { useUpdaterStore } from "@/features/updater/stores/updater-store";
import {
  useSettingsNav,
  type SettingsSection,
} from "../stores/settings-nav-store";
import { isDev } from "@/lib/env";

// Developer section is dev-build only — production users never see the
// diagnostic toggles (they change app behavior and aren't useful outside
// UI testing). `isDev` is a Vite build constant, so the production bundle
// drops the entry entirely via dead-code elimination.
const SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  icon: typeof Settings;
}> = [
  { id: "general", label: "General", icon: Settings },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "layouts", label: "Layouts", icon: LayoutTemplate },
  { id: "providers", label: "API Keys", icon: KeyRound },
  { id: "skills", label: "Skills", icon: Zap },
  { id: "models", label: "Local Models", icon: Boxes },
  { id: "updates", label: "Updates", icon: DownloadCloud },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  ...(isDev
    ? [{ id: "developer" as const, label: "Developer", icon: FlaskConical }]
    : []),
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
          "shrink-0 border-r border-border-default bg-bg-primary pt-2 flex flex-col",
          navCollapsed ? "w-[44px]" : "w-[180px]",
        )}
      >
        <div className="flex-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              title={navCollapsed ? s.label : undefined}
              className={cn(
                "w-full flex items-center h-[32px] whitespace-nowrap text-[11px] font-medium transition-colors border-l-2 cursor-pointer",
                navCollapsed ? "justify-center px-0" : "gap-2 px-4",
                activeSection === s.id
                  ? "text-text-primary bg-bg-selected border-l-accent"
                  : "text-text-secondary hover:bg-bg-hover border-l-transparent",
              )}
            >
              <s.icon size={13} className="shrink-0" />
              {!navCollapsed && s.label}
            </button>
          ))}
        </div>

        {/* Hide / show toggle — divided from the section list. */}
        <button
          onClick={toggleNav}
          title={navCollapsed ? "Show sidebar" : "Hide sidebar"}
          className={cn(
            "mt-1 flex items-center h-[30px] whitespace-nowrap border-t border-border-default text-[11px] font-medium text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer",
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
      ) : activeSection === "models" ? (
        <div className="flex-1 min-w-0 min-h-0">
          <ModelsManager />
        </div>
      ) : activeSection === "appearance" ? (
        <div className="flex-1 min-w-0 min-h-0">
          <AppearanceSettings />
        </div>
      ) : (
        <ScrollArea className="flex-1 p-6">
          <div className="max-w-[500px]">
            {activeSection === "general" && <GeneralSettings />}
            {activeSection === "layouts" && <LayoutsSettings />}
            {activeSection === "updates" && <UpdatesSettings />}
            {activeSection === "keybindings" && <KeybindingsSettings />}
            {isDev && activeSection === "developer" && <DeveloperSettings />}
            {activeSection === "about" && <AboutSettings />}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

interface CliStatus {
  installed: boolean;
  path: string | null;
  installedVersion: string | null;
  currentVersion: string;
}

function GeneralSettings() {
  const settings = useProjectStore.use.settings();
  const { updateSettings } = useProjectStore.use.actions();
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [installing, setInstalling] = useState(false);

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
      <SettingRow
        label="Enter to send"
        description="Enter sends your message; Shift+Enter inserts a newline — the Slack/Discord/ChatGPT convention. Turn off to restore the old behavior, where only ⌘/Ctrl+Enter sends and Enter always inserts a newline. ⌘/Ctrl+Enter always sends either way."
      >
        <Toggle
          checked={settings.enterToSend}
          onChange={(next) => updateSettings({ enterToSend: next })}
        />
      </SettingRow>
      <SettingRow
        label="Auto-add .atlas to .gitignore"
        description="When you open a git-tracked project, Atlas adds `.atlas/` to the project's .gitignore (creating one if needed). Atlas keeps its caches and state in `.atlas/` — keeping it out of version control is almost always what you want. No-op on non-git projects."
      >
        <Toggle
          checked={settings.autoAddAtlasGitignore}
          onChange={(next) =>
            updateSettings({ autoAddAtlasGitignore: next })
          }
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
            updateSettings({ shareTelemetry: next });
            setTelemetryEnabled(next);
            void invoke("telemetry_set_enabled", { enabled: next }).catch(
              () => {},
            );
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
          onClick={() =>
            useFeedbackStore.getState().actions.openPanel("settings")
          }
          className={cn(
            "h-7 rounded-md px-2.5 text-[11px] font-medium border border-border-default bg-bg-elevated",
            "text-text-primary hover:bg-bg-hover transition-colors",
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
          onChange={(next) =>
            updateSettings({ adaptiveSuggestions: next ? "agent" : "off" })
          }
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
            "h-7 rounded-md px-2.5 text-[11px] font-medium border border-border-default bg-bg-elevated",
            "text-text-primary hover:bg-bg-hover transition-colors",
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
            "h-7 rounded-md px-2.5 text-[11px] font-medium border border-border-default bg-bg-elevated",
            "text-text-primary hover:bg-bg-hover transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {pricingLoading ? "Updating…" : "Update pricing"}
        </button>
      </SettingRow>
    </div>
  );
}

type AppearanceTab = "theme" | "accent";

const APPEARANCE_TABS: { id: AppearanceTab; label: string }[] = [
  { id: "accent", label: "Interface Theme" },
  { id: "theme", label: "Editor Theme" },
];

function AppearanceSettings() {
  const settings = useProjectStore.use.settings();
  const { updateSettings } = useProjectStore.use.actions();
  const [tab, setTab] = useState<AppearanceTab>("accent");

  const scalePct = Math.round(settings.uiScale * 100);
  const setScale = (next: number) => updateSettings({ uiScale: clampScale(next) });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — Skills-style underline tabs (no title), zoom on the right. */}
      <div className="flex h-[29px] shrink-0 items-center gap-1 border-b border-border-default px-2">
        {APPEARANCE_TABS.map((t) => (
          <UnderlineTab
            key={t.id}
            active={tab === t.id}
            onClick={() => setTab(t.id)}
            label={t.label}
          />
        ))}

        {/* Interface zoom — right-aligned control (like Skills' scope control). */}
        <div className="ml-auto flex items-center gap-1 pr-0.5" title="Interface zoom (⌘+ / ⌘- / ⌘0)">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => setScale(settings.uiScale - SCALE_STEP)}
            disabled={settings.uiScale <= MIN_SCALE}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full border border-border-default text-text-secondary",
              "hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer",
              "disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            onClick={() => setScale(DEFAULT_SCALE)}
            title="Reset to 100%"
            className="h-6 min-w-[44px] rounded-md px-1.5 text-[11px] font-medium tabular-nums text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
          >
            {scalePct}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => setScale(settings.uiScale + SCALE_STEP)}
            disabled={settings.uiScale >= MAX_SCALE}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full border border-border-default text-text-secondary",
              "hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer",
              "disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            <Plus size={12} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "theme" ? <CodeEditorThemesSettings /> : <AtlasThemesSettings />}
      </div>
    </div>
  );
}

/** Underline tab — copied from the Skills header (`skills-and-packs.tsx`). */
function UnderlineTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-[29px] items-center gap-1.5 px-2.5 text-[11px] font-medium transition-colors border-b-2 -mb-px cursor-pointer",
        active
          ? "text-text-primary border-b-[var(--accent-primary)]"
          : "text-text-secondary hover:text-text-primary border-b-transparent",
      )}
    >
      {label}
    </button>
  );
}

function UpdatesSettings() {
  const settings = useProjectStore.use.settings();
  const { updateSettings } = useProjectStore.use.actions();
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
        "h-7 rounded-md px-2.5 text-[11px] font-medium",
        "bg-[var(--text-primary)] text-[var(--bg-base)] hover:opacity-90 transition-opacity",
      )}
    >
      Restart to update
    </button>
  ) : downloading ? (
    <span className="text-[11px] text-text-tertiary tabular-nums">
      {progress != null ? `Downloading ${Math.round(progress * 100)}%` : "Preparing…"}
    </span>
  ) : (
    <button
      type="button"
      onClick={() => void checkNow()}
      disabled={checking}
      className={cn(
        "h-7 rounded-md px-2.5 text-[11px] font-medium border border-border-default bg-bg-elevated",
        "text-text-primary hover:bg-bg-hover transition-colors",
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
        description="Check for a newer version in the background and download it automatically. Updates are Apple-signed and notarized; Atlas verifies the signature before installing. Turn off to never check or download."
      >
        <Toggle
          checked={settings.autoUpdate}
          onChange={(next) => updateSettings({ autoUpdate: next })}
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

function KeybindingsSettings() {
  const settings = useProjectStore.use.settings();
  const groups: Array<{
    title: string;
    bindings: Array<{ action: string; keys: string }>;
  }> = [
    {
      title: "General",
      bindings: [
        { action: "Command Palette", keys: "⌘K" },
        { action: "Global Search", keys: "⌘⇧F" },
        { action: "Settings", keys: "⌘," },
        { action: "New Window", keys: "⌘⇧N" },
        { action: "Zoom in", keys: "⌘+" },
        { action: "Zoom out", keys: "⌘-" },
        { action: "Reset zoom", keys: "⌘0" },
      ],
    },
    {
      title: "Tabs",
      bindings: [
        { action: "New Chat tab", keys: "⌘T" },
        { action: "New Terminal tab", keys: "⌘⇧T" },
        { action: "Close current tab", keys: "⌘W" },
        { action: "Previous tab", keys: "⌘⇧[" },
        { action: "Next tab", keys: "⌘⇧]" },
        { action: "Switch to tab 1–9", keys: "⌘1…9" },
      ],
    },
    {
      title: "Split View",
      bindings: [
        { action: "Split right (new column)", keys: "⌘\\" },
        { action: "Focus split left", keys: "⌥;" },
        { action: "Focus split right", keys: "⌥'" },
        { action: "Close split", keys: "⌥W" },
        { action: "New tab in focused split", keys: "⌘⌥N" },
        { action: "Switch layout (templates)", keys: "⌘⌥L" },
        { action: "Zen mode (Knowledge │ Chat │ Browser)", keys: "⌥Z" },
      ],
    },
    {
      title: "Layout",
      bindings: [
        { action: "Toggle Left Panel", keys: "⌘B" },
        { action: "Toggle Right Panel", keys: "⌘⇧B" },
        { action: "Toggle Tab Bar", keys: "⌘⌥T" },
        { action: "Toggle Status Bar", keys: "⌘⌥B" },
        { action: "Toggle Agent Sidebar", keys: "⌘⌥J" },
        { action: "Toggle Terminal", keys: "⌘J" },
      ],
    },
    {
      title: "Chat",
      bindings: [
        { action: "Find in chat", keys: "⌘F" },
        { action: "Send message", keys: settings.enterToSend ? "↵" : "⌘↵" },
        { action: "Cycle permission mode", keys: "⇧⇥" },
      ],
    },
    {
      title: "Knowledge Base",
      bindings: [
        { action: "Toggle KB Sidebar", keys: "⌘;" },
        { action: "Toggle KB Inspector", keys: "⌘'" },
        { action: "Save note", keys: "⌘S" },
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <SectionTitle title="Keybindings" subtitle="Keyboard shortcuts" />
      {groups.map((g) => (
        <div key={g.title} className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary px-1">
            {g.title}
          </div>
          <div className="rounded-lg border border-border-default overflow-hidden">
            {g.bindings.map((b, i) => (
              <div
                key={b.action}
                className={cn(
                  "flex items-center justify-between px-3 h-[32px]",
                  i > 0 && "border-t border-border-subtle"
                )}
              >
                <span className="text-[11px] text-text-secondary">{b.action}</span>
                <KbdCombo combo={b.keys} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DeveloperSettings() {
  const triggerClaudeInstall = useDevFlagsStore.use.triggerClaudeInstall();
  const { setTriggerClaudeInstall } = useDevFlagsStore.use.actions();
  const { refreshStatus } = useClaudeSetupStore.use.actions();

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Developer"
        subtitle="Diagnostic toggles for UI testing — these change app behavior, leave off in normal use"
      />

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-text-tertiary px-1">
          Claude Code setup
        </div>
        <div className="rounded-lg border border-border-default bg-bg-secondary px-3 py-3 space-y-3">
          <SettingRow
            label="Trigger Claude Install"
            description="Force the install banner to appear regardless of whether the CLI is actually installed. The Install button and sign-in dialog run a simulated flow on this machine — no real curl, no real `claude /login`. Use this to UI-test the onboarding surface."
          >
            <Toggle
              checked={triggerClaudeInstall}
              onChange={(next) => {
                setTriggerClaudeInstall(next);
                // Re-run status so the banner reflects the new override
                // immediately (turning OFF probes the real CLI again).
                void refreshStatus();
              }}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function AboutSettings() {
  return (
    <div className="space-y-4">
      <SectionTitle title="About" subtitle="Atlas IDE" />
      <div className="rounded-lg border border-border-default bg-bg-secondary p-4 space-y-2">
        <div className="flex items-center gap-2">
          <AtlasIcon size={40} className="rounded-xl" />
          <div>
            <p className="text-sm font-semibold text-text-primary">Atlas</p>
            <p className="text-[10px] text-text-tertiary">v0.2.4 — The second brain IDE</p>
          </div>
        </div>
        <p className="text-[11px] text-text-secondary leading-relaxed pt-2">
          Built with Tauri, React, and Rust. An everything app for agentic development — from code analysis to task management, research, and AI orchestration.
        </p>
      </div>
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      <p className="text-[11px] text-text-tertiary mt-0.5">{subtitle}</p>
    </div>
  );
}

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[12px] font-medium text-text-primary">{label}</p>
        <p className="text-[10px] text-text-tertiary mt-0.5">{description}</p>
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
function Toggle({
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
        value
          ? "bg-[var(--accent-primary)]"
          : "bg-[var(--bg-elevated)]"
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.45)]",
          "transition-transform duration-150",
          value
            ? "translate-x-4 bg-[var(--bg-base)]"
            : "translate-x-0 bg-white"
        )}
      />
    </button>
  );
}

