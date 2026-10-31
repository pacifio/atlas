// Generated from src-tauri/settings-registry.toml — do not edit. Run `bun run settings:gen` after editing that file.

import type { ThemeOverride } from "@/features/theme/resolve-theme";

/**
 * Every key under `[settings]` in `config.toml`, typed. The Rust side is
 * `AppSettings` in `src-tauri/src/state/atlas_config.rs`; a Rust test holds
 * that struct to the same source this file is generated from.
 */
export interface AppSettings {
  /**
   * Keep Atlas's directory in each opened git project out of version control: `.atlas/` goes
   * into the project's .gitignore (created if needed); a dev build's `.atlas-dev/` goes into
   * .git/info/exclude. No-op on non-git projects.
   */
  autoAddAtlasGitignore: boolean;
  /**
   * Record Atlas-internal events (sign-in, agent lifecycle, file and browser opens) into the
   * Logs panel.
   */
  enableAtlasLogs: boolean;
  /** Show dotfiles and dot-directories in the explorer file tree. */
  showHiddenFiles: boolean;
  /**
   * The external editor that "Open in <editor>" uses for a file or the project: an id such as
   * "vscode", "cursor", "zed", "windsurf", "sublime", "xcode" or a JetBrains IDE ("idea",
   * "webstorm", "pycharm"…), or "system" for the app your system opens the file with. Empty
   * uses the first editor Atlas finds installed. An id that isn't installed falls back to that
   * same choice. Files outside the project open in the system's app unless this names an
   * editor.
   */
  preferredEditor: string;
  /**
   * Interface zoom, where 1.0 is 100%. Also driven by Cmd +/-/0. Must be a number between 0.5
   * and 2.0.
   */
  uiScale: number;
  /**
   * Anonymous product telemetry. Opt-OUT: on by default, coarse metadata only, never file
   * contents or prompts. See TELEMETRY.md.
   */
  shareTelemetry: boolean;
  /**
   * Attribute telemetry to your signed-in Atlas account instead of the anonymous per-device id.
   * Irrelevant while signed out, or while shareTelemetry is false — both gate it.
   */
  linkTelemetryToAccount: boolean;
  /**
   * On-device embedding model, named by its directory. Normally managed for you by the Local
   * Model Manager. Must not be empty.
   */
  embeddingModelId: string;
  /**
   * Theme id used while Atlas is light, for the whole app: chrome, editor, terminal, diffs and
   * syntax. A theme with no light variant shows its dark one. Unknown ids fall back to "atlas"
   * with a warning.
   */
  themeLight: string;
  /**
   * Theme id used while Atlas is dark, for the whole app. A theme with no dark variant shows
   * its light one. Unknown ids fall back to "atlas" with a warning.
   */
  themeDark: string;
  /**
   * Exactly "system", "dark" or "light": whether Atlas is light or dark, and so which of
   * themeLight and themeDark it uses.
   */
  themeMode: "system" | "dark" | "light";
  /**
   * Optional user-local patch with base, palette and keys tables, applied after the active
   * theme variant. Omitted when empty.
   */
  themeOverrides: ThemeOverride;
  /**
   * File and folder icons, on their own track from the color theme. "minimal" keeps Atlas's own
   * lucide icons; anything else names a VS Code icon theme, bundled or installed from Open VSX.
   */
  iconTheme: string;
  /**
   * macOS app icon, by id: "dark" (the icon Atlas ships with) or "light". Any other than dark
   * replaces the Dock and Finder icon. An id this Atlas does not know shows the default.
   */
  appIcon: string;
  /**
   * Next-step suggestion chips in the session's per-turn card. Exactly "agent" or "off",
   * nothing else.
   */
  adaptiveSuggestions: "agent" | "off";
  /**
   * What picking another agent does to a session that has a conversation: "new-tab" keeps it
   * and opens the new agent in a new tab, "handoff" switches in place and attaches it to the
   * next message, "reset" switches in place and starts over.
   */
  agentSwitchBehavior: "reset" | "new-tab" | "handoff";
  /**
   * Before switching agents on a chat with a conversation, send the agent being left /remember
   * (when it offers that command) and wait for it to save what it learned to shared memory.
   * Costs one turn per switch.
   */
  rememberBeforeSwitch: boolean;
  /**
   * Inline git blame — a dim author/age/summary annotation trailing the active line in the
   * editor.
   */
  gitBlameInline: boolean;
  /**
   * Quietly `git fetch` the open project when it opens, when Atlas regains focus, and every few
   * minutes, so the Pull badge shows what the remote has. Never pulls or touches your files.
   */
  gitAutoFetch: boolean;
  /**
   * Keep the computer awake while an Atlas agent is actively running. Prevents idle system
   * sleep; display can still turn off. No effect on Windows.
   */
  keepAwakeWhileRunning: boolean;
  /** Check for a newer signed Atlas release on startup and prompt when one is available. */
  autoUpdate: boolean;
  /**
   * Let Atlas Agent download the latest curated plugin catalog when it starts — a network
   * request at every launch. Applies the next time the agent starts.
   */
  curatedPluginSync: boolean;
  /**
   * Mirror CLAUDE.md and .claude/rules/ into a marked block of the active project's AGENTS.md,
   * kept current as they change, for any agent that reads AGENTS.md. Writes into the
   * repository; text outside the block is never changed. Off: the block is taken back out.
   */
  instructionSync: boolean;
  /**
   * A release you chose to skip in the update prompt. Absent unless one was ignored — TOML has
   * no null, so "unset" means the key simply isn't here. Delete the line to clear it; never
   * write an empty string.
   */
  updaterIgnoredVersion: string | null;
  /**
   * Chat composer send gesture. true = Enter sends and Shift+Enter inserts a newline; false =
   * only Cmd/Ctrl+Enter sends. Cmd/Ctrl+Enter sends either way.
   */
  enterToSend: boolean;
  /**
   * Let Atlas Agent act on the window: open files at a line, switch tabs and panels, fill in a
   * chat message, type a command for you to run. It never switches projects, sends for you or
   * presses Enter. Off: its UI tools are withdrawn and every call is refused.
   */
  agentUiNavigation: boolean;
  /**
   * Let Atlas Agent act in your organization, as you: read the recorded sessions, comments,
   * members and conversations of the organization a cloud-bound Project belongs to. Anything
   * that reaches another person asks you first. Off: its organization tools are withdrawn and
   * every call is refused.
   */
  agentOrgAccess: boolean;
  /**
   * Let agents search this project's code through Atlas: grep for text and find files by name,
   * in-process, respecting .gitignore and never reading secret files such as .env. Off: the
   * code tools are withdrawn and every call is refused; agents use their own shell instead.
   */
  agentCodeTools: boolean;
  /**
   * Once a day, when there are new sessions, ask the memory model to propose changes to shared
   * memory (add, merge, archive, rewrite, link). Proposals wait in Memory > Review; nothing is
   * applied without you. Uses the same model and consent as extraction.
   */
  memoryDreams: boolean;
  /**
   * Keep a read-only Agent Memory Repo mirror of each project's active memory, as a local git
   * repository outside the project. No remote, nothing is pushed.
   */
  memoryRepoMirror: boolean;
  /**
   * Atlas's shared memory is the only memory in Atlas sessions: agents that keep their own
   * memory, such as Claude Code's auto memory, start with it turned off. Off: each agent also
   * keeps its own memory files.
   */
  atlasOnlyMemory: boolean;
  /**
   * A successful command shorter than this many milliseconds never notifies. Must be between 0
   * and 3600000.
   */
  terminalNotifyMinDurationMs: number;
  /**
   * Notifications master switch. Off silences every notification except sign-in problems, which
   * always show.
   */
  notificationsEnabled: boolean;
  /**
   * OS banner for notifications that need you — a permission request, a question, a terminal
   * asking for input. Shown only when you are away.
   */
  notifyNeedsYouNative: boolean;
  /** Sound for notifications that need you. */
  notifyNeedsYouSound: boolean;
  /**
   * OS banner when an agent turn or terminal command finishes or fails. Shown only when you are
   * away.
   */
  notifyOutcomeNative: boolean;
  /** Sound for finished / failed notifications. */
  notifyOutcomeSound: boolean;
  /** OS banner for warnings — context nearly full, rate limited, retrying, agent stopped. */
  notifyWarningNative: boolean;
  /** Sound for warnings. */
  notifyWarningSound: boolean;
  /** OS banner for Chat direct messages and @mentions. Shown only when you are away. */
  notifyTeamNative: boolean;
  /** Sound for Chat notifications. */
  notifyTeamSound: boolean;
  /**
   * Show Allow once / Deny buttons on permission banners. Off: the banner only opens the
   * session.
   */
  notifyPermissionActions: boolean;
  /**
   * Notification kinds you switched off in Settings > Notifications, by id, e.g.
   * ["terminal-done", "git-behind"]. Unknown ids are ignored; a kind that must always show
   * (sign-in lost) cannot be silenced.
   */
  notifyDisabledKinds: string[];
  /**
   * An agent turn that finished faster than this many milliseconds stays quiet; failures and
   * requests for you are never held back. 0 turns it off. Must be between 0 and 3600000.
   */
  notifyAgentMinDurationMs: number;
  /**
   * Models you starred in the composer's model picker, as "agentType:modelId", e.g.
   * ["claude-code:opus"]. Starred models open the picker on Favorites. Unknown entries are
   * ignored.
   */
  favoriteModels: string[];
  /**
   * Ask before deleting a session from the sidebar or the history. A deleted session's
   * transcript stays with its agent, but Atlas forgets the session. Settling never asks,
   * because it can be undone.
   */
  confirmDeleteChat: boolean;
  /**
   * Ask before quitting while an agent is in the middle of a turn, since quitting stops it.
   * Quitting again while the question is open quits anyway.
   */
  confirmQuitWhileRunning: boolean;
  /**
   * When Atlas quits, crashes or restarts to update while an agent is in the middle of a turn,
   * the next launch opens that session and tells the agent to continue where it left off, with
   * a row in the transcript saying so. Settled and snoozed sessions are left alone, and a turn
   * that keeps getting cut short is let go after three tries in a row.
   */
  continueSessionsAfterRestart: boolean;
  /**
   * A new session starts on the agent you last picked in a composer, by switching or with the
   * agent shortcut, as long as it is still installed. Off, or before you have picked one, new
   * sessions start on defaultAgent.
   */
  newSessionUsesLastAgent: boolean;
  /**
   * The agent a new session starts with: "atlas-agent" for Atlas Agent, or the id of an
   * installed ACP agent, such as "claude-code". An agent that isn't installed falls back to
   * Atlas Agent.
   */
  defaultAgent: string;
  /**
   * How wide the conversation and the composer may grow: "normal" (760 pixels), "wide" (1080
   * pixels) or "full" (the whole panel).
   */
  chatWidth: "normal" | "wide" | "full";
  /**
   * Wrap long lines in file tabs, diffs and a session's code blocks. Off: lines keep their
   * shape and scroll sideways. The wrap button in a file's or the review diff's header flips
   * this same setting.
   */
  wordWrap: boolean;
  /**
   * The order of sessions in the sidebar: "recent" puts the session with the latest activity
   * first, "created" the one started most recently.
   */
  sidebarSort: "recent" | "created";
  /**
   * Days a session may sit idle before Atlas settles it: moves it to the Settled shelf at the
   * bottom of the session sidebar, where it stays listed and resumable. A session that is
   * running, waiting for you, pinned, snoozed, or that you un-settled since its last activity
   * is left alone, and sending to a settled session brings it back. 0 turns auto-settling off;
   * settling by hand still works. Must be between 0 and 90.
   */
  autoSettleAfterDays: number;
  /**
   * The clock for every time of day Atlas shows: "12h", "24h", or "system" to follow your
   * system's region settings.
   */
  timeFormat: "system" | "12h" | "24h";
  /**
   * The font for Atlas's interface and chats, as a CSS font-family list such as "Inter,
   * sans-serif". Empty uses the theme's font-sans if it sets one, else the system font. A font
   * that isn't installed falls through to the next one in the list.
   */
  uiFontFamily: string;
  /**
   * The font for the editor, diffs and code in chats, as a CSS font-family list such as
   * "JetBrains Mono, monospace". Empty uses the theme's font-mono if it sets one, else the
   * platform's monospace font. The terminal uses it too unless terminalFontFamily is set.
   */
  codeFontFamily: string;
  /** The font for the chat composer, as a CSS font-family list. Empty uses the interface font. */
  composerFontFamily: string;
  /**
   * The terminal's font, as a CSS font-family list. Empty uses the code font. A font that isn't
   * fixed-width misaligns columns.
   */
  terminalFontFamily: string;
  /**
   * The code editor's font size, in pixels. The interface zoom scales it along with everything
   * else.
   */
  editorFontSize: number;
  /**
   * The terminal's font size, in pixels. The interface zoom scales it along with everything
   * else.
   */
  terminalFontSize: number;
  /**
   * Leave out changes that are only whitespace in diffs you read: a file's diff, a commit, and
   * a chat's changes. Diffs you stage from always show every change, since a patch without the
   * whitespace no longer applies.
   */
  diffIgnoreWhitespace: boolean;
  /**
   * Open a diff, such as your changes or a commit, as a list of its files, each collapsed to
   * its header; click a file to expand it. Off: every file starts expanded.
   */
  diffFilesCollapsed: boolean;
  /**
   * The colours for added and removed lines: "theme" uses the theme's green and red,
   * "blue-orange" uses its blue and orange, which stay distinct with red-green colour
   * blindness.
   */
  diffPalette: "theme" | "blue-orange";
  /**
   * Contrast of borders and secondary text, in percent of what the theme draws. Above 100 moves
   * them toward the text colour, below 100 toward the background. Applies to every theme, the
   * terminal and charts included.
   */
  interfaceContrast: number;
  /**
   * The turn rail: a column of short ticks down the left edge of a session's transcript, one
   * per turn. Hovering a tick previews the prompt and the start of the reply; clicking it jumps
   * to that turn. Off hides the rail.
   */
  showTurnRail: boolean;
  /**
   * Settle a session once its linked pull request merges, when the merge came after you last
   * worked in the session. A pull request that is closed without merging always settles its
   * session. Settled sessions stay listed and resumable.
   */
  autoSettleOnMerge: boolean;
  /**
   * Auto-settling after days of inactivity (autoSettleAfterDays) leaves a session alone while
   * it has a linked pull request. Merging or closing it can still settle the session
   * (autoSettleOnMerge).
   */
  autoSettleKeepPullRequests: boolean;
  /**
   * When a session watches its pull request (the agent asked to, or you turned the watch on), a
   * failing check, a new review or comment, or a conflict with the base sends the session's
   * agent an update so it can act. Off: watches still track the pull request but never prompt
   * an agent.
   */
  pullRequestWatchWakes: boolean;
  /**
   * Open a pull request link from a session, the sidebar or a transcript in Atlas's pull
   * request tab when it belongs to the project's repository. Off, or a pull request of another
   * repository: it opens in the browser.
   */
  pullRequestLinksOpenInApp: boolean;
  /**
   * The method a pull request's Merge button starts on: "merge", "squash" or "rebase", or
   * "last" for whichever you picked most recently on this device. A method the repository
   * doesn't allow falls back to one it does.
   */
  pullRequestMergeMethod: "last" | "merge" | "squash" | "rebase";
  /**
   * Remove recognized agent credit lines (an agent's Co-Authored-By trailer, a "Generated with"
   * footer) from the message of a merge or squash Atlas performs, auto-merge included. Human
   * co-authors are kept. Commits already on the branch are not rewritten.
   */
  removeAgentCreditsOnMerge: boolean;
  /**
   * Show the Guide tab on pull requests, where an agent writes a tour of the change in reading
   * order, with the calls a maintainer should make. The agent reads a checkout of the pull
   * request's head and changes nothing.
   */
  pullRequestGuideEnabled: boolean;
  /**
   * The agent that writes review guides: "atlas-agent" or an installed ACP agent's id, such as
   * "claude-code". Empty uses defaultAgent. An agent that isn't installed falls back to Atlas
   * Agent.
   */
  pullRequestGuideAgent: string;
  /**
   * The model the guide's agent runs on, as that agent names it (the id after the colon in
   * favoriteModels). The guide reads the change over many steps, so a stronger model helps.
   * Empty keeps the agent's default; a model the agent doesn't offer is ignored.
   */
  pullRequestGuideModel: string;
  /**
   * Your preferences for review guides, added to the guide's prompt: what to show first, dwell
   * on or skip, and how long summaries should be. The guide's format and its coverage of every
   * changed file stay the same.
   */
  pullRequestGuideInstructions: string;
}

export type SettingKey = keyof AppSettings;

export const DEFAULT_SETTINGS: AppSettings = {
  autoAddAtlasGitignore: true,
  enableAtlasLogs: true,
  showHiddenFiles: true,
  preferredEditor: "",
  uiScale: 1,
  shareTelemetry: true,
  linkTelemetryToAccount: true,
  embeddingModelId: "all-MiniLM-L6-v2",
  themeLight: "atlas",
  themeDark: "atlas",
  themeMode: "system",
  themeOverrides: {},
  iconTheme: "material-icon-theme",
  appIcon: "dark",
  adaptiveSuggestions: "agent",
  agentSwitchBehavior: "reset",
  rememberBeforeSwitch: false,
  gitBlameInline: true,
  gitAutoFetch: true,
  keepAwakeWhileRunning: false,
  autoUpdate: true,
  curatedPluginSync: false,
  instructionSync: false,
  updaterIgnoredVersion: null,
  enterToSend: true,
  agentUiNavigation: true,
  agentOrgAccess: true,
  agentCodeTools: true,
  memoryDreams: false,
  memoryRepoMirror: false,
  atlasOnlyMemory: true,
  terminalNotifyMinDurationMs: 10000,
  notificationsEnabled: true,
  notifyNeedsYouNative: true,
  notifyNeedsYouSound: true,
  notifyOutcomeNative: true,
  notifyOutcomeSound: true,
  notifyWarningNative: false,
  notifyWarningSound: false,
  notifyTeamNative: true,
  notifyTeamSound: true,
  notifyPermissionActions: true,
  notifyDisabledKinds: [],
  notifyAgentMinDurationMs: 0,
  favoriteModels: [],
  confirmDeleteChat: true,
  confirmQuitWhileRunning: true,
  continueSessionsAfterRestart: true,
  newSessionUsesLastAgent: true,
  defaultAgent: "atlas-agent",
  chatWidth: "normal",
  wordWrap: true,
  sidebarSort: "recent",
  autoSettleAfterDays: 3,
  timeFormat: "system",
  uiFontFamily: "",
  codeFontFamily: "",
  composerFontFamily: "",
  terminalFontFamily: "",
  editorFontSize: 13,
  terminalFontSize: 13,
  diffIgnoreWhitespace: false,
  diffFilesCollapsed: true,
  diffPalette: "theme",
  interfaceContrast: 100,
  showTurnRail: true,
  autoSettleOnMerge: true,
  autoSettleKeepPullRequests: true,
  pullRequestWatchWakes: true,
  pullRequestLinksOpenInApp: true,
  pullRequestMergeMethod: "last",
  removeAgentCreditsOnMerge: false,
  pullRequestGuideEnabled: true,
  pullRequestGuideAgent: "",
  pullRequestGuideModel: "",
  pullRequestGuideInstructions: "",
};

export type SettingType =
  | "boolean"
  | "integer"
  | "number"
  | "string"
  | "enum"
  | "string-list"
  | "optional-string"
  | "table";

/**
 * Where a setting is changed: a Settings row (`live`), another part of the app
 * (`elsewhere`), only by editing the file (`file-only`),
 * or by Atlas itself (`internal`).
 */
export type SettingStatus = "live" | "elsewhere" | "file-only" | "internal";

export const SETTINGS_PAGES = [
  {
    id: "general",
    title: "General",
    description: "Confirmations, the clock, and how Atlas treats your project's files.",
  },
  {
    id: "appearance",
    title: "Appearance",
    description: "Themes, icons, fonts, and how the interface is drawn.",
  },
  {
    id: "chat",
    title: "Sessions",
    description: "New sessions, the composer, layout, and switching agents.",
  },
  {
    id: "agents",
    title: "Agents",
    description:
      "Atlas Agent, and the ACP agents you add from the registry or already have on your PATH.",
  },
  {
    id: "memory",
    title: "Memory",
    description:
      "Shared memory across agents, instructions mirrored for them, and the model memory search runs on.",
  },
  {
    id: "notifications",
    title: "Notifications",
    description: "What notifies you, how, and after how long.",
  },
  {
    id: "source-control",
    title: "Source Control",
    description: "Git in the editor, diffs, and in the background.",
  },
  {
    id: "pull-requests",
    title: "Pull Requests",
    description: "Merging, sessions with a pull request, links, and review guides.",
  },
  {
    id: "privacy",
    title: "Privacy",
    description: "Usage data, Atlas's own logs, and the settings file itself.",
  },
  {
    id: "updates",
    title: "Updates",
    description: "Atlas releases and Atlas Agent's plugin catalog.",
  },
] as const;

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]["id"];

export interface SettingMeta {
  key: SettingKey;
  type: SettingType;
  status: SettingStatus;
  page: SettingsPageId;
  section: string;
  title: string;
  summary: string;
  values?: readonly string[];
  min?: number;
  max?: number;
  platforms?: readonly ("macos" | "windows" | "linux")[];
  /** When a change takes effect, if not immediately. */
  applies?: string;
  /** For `elsewhere`: where in the app it is changed. */
  setIn?: string;
  /** A project's `.atlas/config.toml` can override it — `"tighten"`: only
   *  turn it off. */
  project?: true | "tighten";
}

export const SETTINGS_REGISTRY: readonly SettingMeta[] = [
  {
    key: "autoAddAtlasGitignore",
    type: "boolean",
    status: "live",
    page: "general",
    section: "Files",
    title: "Keep .atlas out of git",
    summary: "Add Atlas's per-project directory to each git project's .gitignore when it opens.",
  },
  {
    key: "enableAtlasLogs",
    type: "boolean",
    status: "live",
    page: "privacy",
    section: "Diagnostics",
    title: "Atlas logs",
    summary: "Record sign-in, agent lifecycle, and file and browser opens into the Logs panel.",
  },
  {
    key: "showHiddenFiles",
    type: "boolean",
    status: "live",
    page: "general",
    section: "Files",
    title: "Show hidden files",
    summary: "Show dotfiles and dot-directories in the explorer file tree.",
  },
  {
    key: "preferredEditor",
    type: "string",
    status: "live",
    page: "general",
    section: "Files",
    title: "Preferred editor",
    summary: "The external editor that Open in Editor uses for files and projects.",
  },
  {
    key: "uiScale",
    type: "number",
    status: "live",
    page: "appearance",
    section: "Interface",
    title: "Interface zoom",
    summary: "Scale the whole interface: text, icons and spacing together.",
    min: 0.5,
    max: 2,
  },
  {
    key: "shareTelemetry",
    type: "boolean",
    status: "live",
    page: "privacy",
    section: "Usage data",
    title: "Share usage data",
    summary:
      "Send privacy-preserving usage data to help improve Atlas. Never prompts, code, paths or keys.",
  },
  {
    key: "linkTelemetryToAccount",
    type: "boolean",
    status: "live",
    page: "privacy",
    section: "Usage data",
    title: "Link usage data to my account",
    summary:
      "While signed in, attribute usage data to your account instead of an anonymous device id.",
  },
  {
    key: "embeddingModelId",
    type: "string",
    status: "elsewhere",
    page: "memory",
    section: "Embedding model",
    title: "Embedding model",
    summary: "The on-device model that embeds memory for search by meaning.",
    setIn: "Settings → Memory → Embedding model",
  },
  {
    key: "themeLight",
    type: "string",
    status: "live",
    page: "appearance",
    section: "Themes",
    title: "Light theme",
    summary: "The theme Atlas uses while it's light: chrome, editor, terminal, diffs and syntax.",
  },
  {
    key: "themeDark",
    type: "string",
    status: "live",
    page: "appearance",
    section: "Themes",
    title: "Dark theme",
    summary: "The theme Atlas uses while it's dark: chrome, editor, terminal, diffs and syntax.",
  },
  {
    key: "themeMode",
    type: "enum",
    status: "live",
    page: "appearance",
    section: "Colour scheme",
    title: "Colour scheme",
    summary: "Follow the system, or always be light or dark.",
    values: ["system", "dark", "light"],
  },
  {
    key: "themeOverrides",
    type: "table",
    status: "file-only",
    page: "appearance",
    section: "Themes",
    title: "Theme overrides",
    summary:
      "A personal patch of base, palette and key colours applied on top of the active theme.",
  },
  {
    key: "iconTheme",
    type: "string",
    status: "live",
    page: "appearance",
    section: "File icons",
    title: "File icon theme",
    summary: "File and folder icons, chosen separately from the colour theme.",
  },
  {
    key: "appIcon",
    type: "string",
    status: "live",
    page: "appearance",
    section: "Interface",
    title: "App icon",
    summary: "The icon in the Dock, Finder and Launchpad.",
    platforms: ["macos"],
  },
  {
    key: "adaptiveSuggestions",
    type: "enum",
    status: "live",
    page: "chat",
    section: "Conversation",
    title: "Next-step suggestions",
    summary: "After each turn, the agent suggests two or three follow-ups as clickable chips.",
    values: ["agent", "off"],
  },
  {
    key: "agentSwitchBehavior",
    type: "enum",
    status: "live",
    page: "chat",
    section: "Switching agents",
    title: "Switching agents in a session",
    summary: "What picking another agent does once a session has a conversation.",
    values: ["reset", "new-tab", "handoff"],
  },
  {
    key: "rememberBeforeSwitch",
    type: "boolean",
    status: "live",
    page: "chat",
    section: "Switching agents",
    title: "Save to memory before switching agents",
    summary: "Ask the agent you are leaving to save what it learned to shared memory first.",
  },
  {
    key: "gitBlameInline",
    type: "boolean",
    status: "live",
    page: "source-control",
    section: "Editor",
    title: "Inline Git blame",
    summary: "Show who last changed the current line, and when, at the end of the line.",
    project: true,
  },
  {
    key: "gitAutoFetch",
    type: "boolean",
    status: "live",
    page: "source-control",
    section: "Repositories",
    title: "Auto-fetch from remote",
    summary:
      "Quietly fetch the open project so the Pull badge shows what the remote has. Never pulls.",
    project: "tighten",
  },
  {
    key: "keepAwakeWhileRunning",
    type: "boolean",
    status: "live",
    page: "general",
    section: "System",
    title: "Keep awake while an agent is working",
    summary: "Prevent idle system sleep while an agent is running. The display can still turn off.",
    platforms: ["macos", "linux"],
  },
  {
    key: "autoUpdate",
    type: "boolean",
    status: "live",
    page: "updates",
    section: "Atlas",
    title: "Automatic updates",
    summary: "Check for a newer signed release on startup and prompt when one is available.",
  },
  {
    key: "curatedPluginSync",
    type: "boolean",
    status: "live",
    page: "updates",
    section: "Atlas Agent",
    title: "Keep Atlas Agent's plugin catalog up to date",
    summary: "Download the latest curated plugin catalog when Atlas Agent starts.",
    applies: "the next time Atlas Agent starts",
  },
  {
    key: "instructionSync",
    type: "boolean",
    status: "live",
    page: "memory",
    section: "Instructions",
    title: "Mirror CLAUDE.md and .claude/rules into AGENTS.md",
    summary:
      "Keep a marked block of the project's AGENTS.md in step with CLAUDE.md and .claude/rules.",
  },
  {
    key: "updaterIgnoredVersion",
    type: "optional-string",
    status: "internal",
    page: "updates",
    section: "Atlas",
    title: "Skipped release",
    summary: "A release you chose to skip in the update prompt.",
  },
  {
    key: "enterToSend",
    type: "boolean",
    status: "live",
    page: "chat",
    section: "Composer",
    title: "Enter to send",
    summary: "Enter sends and Shift+Enter inserts a newline. Off: only ⌘/Ctrl+Enter sends.",
  },
  {
    key: "agentUiNavigation",
    type: "boolean",
    status: "live",
    page: "agents",
    section: "Atlas Agent permissions",
    title: "Let Atlas Agent navigate the app",
    summary:
      "Open files at a line, switch tabs and panels, and fill in a message or command for you.",
    project: "tighten",
  },
  {
    key: "agentOrgAccess",
    type: "boolean",
    status: "live",
    page: "agents",
    section: "Atlas Agent permissions",
    title: "Let Atlas Agent act in your organization",
    summary: "Read your organization's sessions, comments and conversations, and act there as you.",
    project: "tighten",
  },
  {
    key: "agentCodeTools",
    type: "boolean",
    status: "live",
    page: "agents",
    section: "All agents",
    title: "Let agents search code with Atlas",
    summary:
      "Give agents Atlas's in-process grep and find-files, which respect .gitignore and skip secrets.",
    project: "tighten",
  },
  {
    key: "memoryDreams",
    type: "boolean",
    status: "live",
    page: "memory",
    section: "Shared memory",
    title: "Nightly memory review",
    summary:
      "Once a day, propose changes to shared memory for you to review. Nothing applies without you.",
    project: "tighten",
  },
  {
    key: "memoryRepoMirror",
    type: "boolean",
    status: "live",
    page: "memory",
    section: "Shared memory",
    title: "Mirror memory as an Agent Memory Repo",
    summary: "Keep a read-only local git copy of each project's memory, outside the project.",
    project: "tighten",
  },
  {
    key: "atlasOnlyMemory",
    type: "boolean",
    status: "live",
    page: "memory",
    section: "Shared memory",
    title: "Atlas is the only memory in Atlas sessions",
    summary:
      "Turn off each agent's own memory so every agent reads and writes the one shared memory.",
  },
  {
    key: "terminalNotifyMinDurationMs",
    type: "integer",
    status: "live",
    page: "notifications",
    section: "Notifications",
    title: "Notify on command success after",
    summary:
      "A terminal command that succeeds faster than this stays quiet. Failures always notify.",
    min: 0,
    max: 3600000,
  },
  {
    key: "notificationsEnabled",
    type: "boolean",
    status: "live",
    page: "notifications",
    section: "Notifications",
    title: "Notifications",
    summary: "Every notification below. Sign-in problems always show.",
  },
  {
    key: "notifyNeedsYouNative",
    type: "boolean",
    status: "live",
    page: "notifications",
    section: "Needs you",
    title: "System notification",
    summary: "An OS banner for a permission request, a question, or a terminal asking for input.",
  },
  {
    key: "notifyNeedsYouSound",
    type: "boolean",
    status: "live",
    page: "notifications",
    section: "Needs you",
    title: "Sound",
    summary: "A short sound with notifications that need you.",
  },
  {
    key: "notifyOutcomeNative",
    type: "boolean",
    status: "live",
    page: "notifications",
    section: "Outcomes",
    title: "System notification",
    summary: "An OS banner when an agent turn or terminal command finishes or fails.",
  },
  {
    key: "notifyOutcomeSound",
    type: "boolean",
    status: "live",
    page: "notifications",
    section: "Outcomes",
    title: "Sound",
    summary: "A short sound when something finishes or fails.",
  },
  {
    key: "notifyWarningNative",
    type: "boolean",
    status: "live",
    page: "notifications",
    section: "Warnings",
    title: "System notification",
    summary: "An OS banner for context nearly full, rate limits, retries and stopped agents.",
  },
  {
    key: "notifyWarningSound",
    type: "boolean",
    status: "live",
    page: "notifications",
    section: "Warnings",
    title: "Sound",
    summary: "A short sound with warnings.",
  },
  {
    key: "notifyTeamNative",
    type: "boolean",
    status: "live",
    page: "notifications",
    section: "Team",
    title: "System notification",
    summary: "An OS banner for Chat direct messages and @mentions.",
  },
  {
    key: "notifyTeamSound",
    type: "boolean",
    status: "live",
    page: "notifications",
    section: "Team",
    title: "Sound",
    summary: "A short sound with Chat notifications.",
  },
  {
    key: "notifyPermissionActions",
    type: "boolean",
    status: "live",
    page: "notifications",
    section: "Needs you",
    title: "Banner actions on permission requests",
    summary:
      "Show Allow once and Deny on a permission banner, so you can answer without opening Atlas.",
  },
  {
    key: "notifyDisabledKinds",
    type: "string-list",
    status: "live",
    page: "notifications",
    section: "Kinds",
    title: "Notification kinds",
    summary: "One switch per kind of notification, from command finished to Git behind.",
  },
  {
    key: "notifyAgentMinDurationMs",
    type: "integer",
    status: "live",
    page: "notifications",
    section: "Notifications",
    title: "Notify on agent finish after",
    summary:
      "An agent turn that finishes faster than this stays quiet. Failures and requests always notify.",
    min: 0,
    max: 3600000,
  },
  {
    key: "favoriteModels",
    type: "string-list",
    status: "elsewhere",
    page: "agents",
    section: "All agents",
    title: "Favorite models",
    summary: "Models you starred in the composer's model picker.",
    setIn: "the star in the composer's model picker",
  },
  {
    key: "confirmDeleteChat",
    type: "boolean",
    status: "live",
    page: "general",
    section: "Confirmations",
    title: "Confirm before deleting a session",
    summary: "Ask first when you delete a session from the sidebar or history.",
  },
  {
    key: "confirmQuitWhileRunning",
    type: "boolean",
    status: "live",
    page: "general",
    section: "Confirmations",
    title: "Confirm before quitting while an agent is running",
    summary: "Ask first when you quit Atlas with an agent in the middle of a turn.",
  },
  {
    key: "continueSessionsAfterRestart",
    type: "boolean",
    status: "live",
    page: "chat",
    section: "Running sessions",
    title: "Continue sessions after a restart",
    summary:
      "A turn cut short when Atlas quits, crashes or updates carries on when Atlas opens again.",
  },
  {
    key: "newSessionUsesLastAgent",
    type: "boolean",
    status: "live",
    page: "chat",
    section: "New sessions",
    title: "Start with the last agent you picked",
    summary:
      "A new session starts on the agent you last chose in a composer, instead of the default agent.",
  },
  {
    key: "defaultAgent",
    type: "string",
    status: "live",
    page: "chat",
    section: "New sessions",
    title: "Default agent",
    summary: "The agent a new session starts with.",
    project: true,
  },
  {
    key: "chatWidth",
    type: "enum",
    status: "live",
    page: "appearance",
    section: "Interface",
    title: "Session width",
    summary: "How wide the conversation and the composer may grow.",
    values: ["normal", "wide", "full"],
  },
  {
    key: "wordWrap",
    type: "boolean",
    status: "live",
    page: "appearance",
    section: "Interface",
    title: "Word wrap",
    summary:
      "Wrap long lines in files, diffs and a session's code blocks instead of scrolling sideways.",
  },
  {
    key: "sidebarSort",
    type: "enum",
    status: "live",
    page: "chat",
    section: "Layout",
    title: "Sort sessions by",
    summary: "Order the sidebar's sessions by their latest activity or by when they started.",
    values: ["recent", "created"],
  },
  {
    key: "autoSettleAfterDays",
    type: "integer",
    status: "live",
    page: "chat",
    section: "Layout",
    title: "Settle idle sessions after",
    summary:
      "A session with no activity for this many days moves to the sidebar's Settled shelf. 0 turns this off.",
    min: 0,
    max: 90,
  },
  {
    key: "timeFormat",
    type: "enum",
    status: "live",
    page: "general",
    section: "System",
    title: "Time format",
    summary: "Show times on a 12-hour or 24-hour clock, or as your system does.",
    values: ["system", "12h", "24h"],
  },
  {
    key: "uiFontFamily",
    type: "string",
    status: "live",
    page: "appearance",
    section: "Typography",
    title: "Interface font",
    summary:
      "The font for everything outside code and the terminal. Empty follows the theme, else the system font.",
  },
  {
    key: "codeFontFamily",
    type: "string",
    status: "live",
    page: "appearance",
    section: "Typography",
    title: "Code font",
    summary:
      "The font for the editor, diffs and code in chats. Empty follows the theme, else the default.",
  },
  {
    key: "composerFontFamily",
    type: "string",
    status: "live",
    page: "appearance",
    section: "Typography",
    title: "Composer font",
    summary: "The font you type prompts in. Empty uses the interface font.",
  },
  {
    key: "terminalFontFamily",
    type: "string",
    status: "live",
    page: "appearance",
    section: "Typography",
    title: "Terminal font",
    summary: "The terminal's font. Empty uses the code font.",
  },
  {
    key: "editorFontSize",
    type: "integer",
    status: "live",
    page: "appearance",
    section: "Typography",
    title: "Editor font size",
    summary: "The code editor's font size, in pixels.",
    min: 8,
    max: 32,
  },
  {
    key: "terminalFontSize",
    type: "integer",
    status: "live",
    page: "appearance",
    section: "Typography",
    title: "Terminal font size",
    summary: "The terminal's font size, in pixels.",
    min: 8,
    max: 32,
  },
  {
    key: "diffIgnoreWhitespace",
    type: "boolean",
    status: "live",
    page: "source-control",
    section: "Diffs",
    title: "Hide whitespace changes",
    summary: "Leave out lines that only changed whitespace when you review a diff.",
  },
  {
    key: "diffFilesCollapsed",
    type: "boolean",
    status: "live",
    page: "source-control",
    section: "Diffs",
    title: "Start files collapsed",
    summary: "Open a diff with each file collapsed to its header.",
  },
  {
    key: "diffPalette",
    type: "enum",
    status: "live",
    page: "appearance",
    section: "Interface",
    title: "Diff colours",
    summary: "Use the theme's green and red for changes, or blue and orange.",
    values: ["theme", "blue-orange"],
  },
  {
    key: "interfaceContrast",
    type: "integer",
    status: "live",
    page: "appearance",
    section: "Interface",
    title: "Contrast",
    summary: "Strengthen or soften borders and secondary text across the interface.",
    min: 50,
    max: 200,
  },
  {
    key: "showTurnRail",
    type: "boolean",
    status: "live",
    page: "appearance",
    section: "Interface",
    title: "Turn rail",
    summary:
      "Show a tick for each turn down the left edge of a session. Hover one to preview it, click it to jump there.",
  },
  {
    key: "autoSettleOnMerge",
    type: "boolean",
    status: "live",
    page: "pull-requests",
    section: "Sessions",
    title: "Settle sessions when their pull request merges",
    summary: "Move a session to Settled once its pull request merges or closes.",
  },
  {
    key: "autoSettleKeepPullRequests",
    type: "boolean",
    status: "live",
    page: "pull-requests",
    section: "Sessions",
    title: "Keep sessions with a pull request from settling",
    summary: "Idle auto-settling leaves a session with a linked pull request alone.",
  },
  {
    key: "pullRequestWatchWakes",
    type: "boolean",
    status: "live",
    page: "pull-requests",
    section: "Sessions",
    title: "Let agents act on watched pull requests",
    summary:
      "A watched pull request can prompt its session's agent when checks fail, reviews arrive or it conflicts.",
  },
  {
    key: "pullRequestLinksOpenInApp",
    type: "boolean",
    status: "live",
    page: "pull-requests",
    section: "Links",
    title: "Open pull request links in Atlas",
    summary: "Open a pull request of the project's repository in a tab instead of the browser.",
  },
  {
    key: "pullRequestMergeMethod",
    type: "enum",
    status: "live",
    page: "pull-requests",
    section: "Merging",
    title: "Default merge method",
    summary:
      "The method a pull request's Merge button starts on. Last used reuses your latest pick.",
    values: ["last", "merge", "squash", "rebase"],
    project: true,
  },
  {
    key: "removeAgentCreditsOnMerge",
    type: "boolean",
    status: "live",
    page: "pull-requests",
    section: "Merging",
    title: "Remove agent credits when merging",
    summary:
      "Drop agent co-author and attribution lines from merge and squash messages, keeping human co-authors.",
    project: true,
  },
  {
    key: "pullRequestGuideEnabled",
    type: "boolean",
    status: "live",
    page: "pull-requests",
    section: "Review guide",
    title: "Review guides",
    summary: "A Guide tab on pull requests: an agent writes a tour of the change, stop by stop.",
    project: true,
  },
  {
    key: "pullRequestGuideAgent",
    type: "string",
    status: "live",
    page: "pull-requests",
    section: "Review guide",
    title: "Guide agent",
    summary: "The agent that writes review guides. Empty uses the default agent for new sessions.",
    project: true,
  },
  {
    key: "pullRequestGuideModel",
    type: "string",
    status: "live",
    page: "pull-requests",
    section: "Review guide",
    title: "Guide model",
    summary: "The model the guide's agent runs on. Empty keeps the agent's own default.",
    project: true,
  },
  {
    key: "pullRequestGuideInstructions",
    type: "string",
    status: "live",
    page: "pull-requests",
    section: "Review guide",
    title: "Guide instructions",
    summary: "Your preferences for review guides: what to show first, dwell on, or skip.",
    project: true,
  },
];
