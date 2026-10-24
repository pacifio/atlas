// Generated from src-tauri/settings-registry.toml — do not edit. Run `bun run settings:gen` after editing that file.
//
// camelCase key → the comment written directly above it in a generated
// `config.toml`, in `AppSettings` field order. `include!`d by
// `state/atlas_config.rs`; see `SETTINGS_DOCS` there.

const SETTINGS_DOCS: &[(&str, &str)] = &[
    (
        "autoAddAtlasGitignore",
        "# Keep Atlas's directory in each opened git project out of version control:\n# `.atlas/` goes into the project's .gitignore (created if needed); a dev\n# build's `.atlas-dev/` goes into .git/info/exclude. No-op on non-git\n# projects. (default: true)",
    ),
    (
        "enableAtlasLogs",
        "# Record Atlas-internal events (sign-in, agent lifecycle, file and browser\n# opens) into the Logs panel. (default: true)",
    ),
    (
        "showHiddenFiles",
        "# Show dotfiles and dot-directories in the explorer file tree. (default: true)",
    ),
    (
        "preferredEditor",
        "# The external editor that \"Open in <editor>\" uses for a file or the project:\n# an id such as \"vscode\", \"cursor\", \"zed\", \"windsurf\", \"sublime\", \"xcode\" or a\n# JetBrains IDE (\"idea\", \"webstorm\", \"pycharm\"…), or \"system\" for the app your\n# system opens the file with. Empty uses the first editor Atlas finds\n# installed. An id that isn't installed falls back to that same choice. Files\n# outside the project open in the system's app unless this names an editor.\n# (default: \"\")",
    ),
    (
        "uiScale",
        "# Interface zoom, where 1.0 is 100%. Also driven by Cmd +/-/0. Must be a\n# number between 0.5 and 2.0. (default: 1.0)",
    ),
    (
        "shareTelemetry",
        "# Anonymous product telemetry. Opt-OUT: on by default, coarse metadata only,\n# never file contents or prompts. See TELEMETRY.md. (default: true)",
    ),
    (
        "linkTelemetryToAccount",
        "# Attribute telemetry to your signed-in Atlas account instead of the anonymous\n# per-device id. Irrelevant while signed out, or while shareTelemetry is false\n# — both gate it. (default: true)",
    ),
    (
        "embeddingModelId",
        "# On-device embedding model, named by its directory. Normally managed for you\n# by the Local Model Manager. Must not be empty. (default: \"all-MiniLM-L6-v2\")",
    ),
    (
        "themeLight",
        "# Theme id used while Atlas is light, for the whole app: chrome, editor,\n# terminal, diffs and syntax. A theme with no light variant shows its dark\n# one. Unknown ids fall back to \"atlas\" with a warning. (default: \"atlas\")",
    ),
    (
        "themeDark",
        "# Theme id used while Atlas is dark, for the whole app. A theme with no dark\n# variant shows its light one. Unknown ids fall back to \"atlas\" with a\n# warning. (default: \"atlas\")",
    ),
    (
        "themeMode",
        "# Exactly \"system\", \"dark\" or \"light\": whether Atlas is light or dark, and so\n# which of themeLight and themeDark it uses. (default: \"system\")",
    ),
    (
        "themeOverrides",
        "# themeOverrides: Optional user-local patch with base, palette and keys\n# tables, applied after the active theme variant. Omitted when empty.",
    ),
    (
        "iconTheme",
        "# File and folder icons, on their own track from the color theme. \"minimal\"\n# keeps Atlas's own lucide icons; anything else names a VS Code icon theme,\n# bundled or installed from Open VSX. (default: \"material-icon-theme\")",
    ),
    (
        "appIcon",
        "# macOS app icon, by id: \"dark\" (the icon Atlas ships with) or \"light\". Any\n# other than dark replaces the Dock and Finder icon. An id this Atlas does not\n# know shows the default. (default: \"dark\")",
    ),
    (
        "adaptiveSuggestions",
        "# Next-step suggestion chips in the session's per-turn card. Exactly \"agent\"\n# or \"off\", nothing else. (default: \"agent\")",
    ),
    (
        "agentSwitchBehavior",
        "# What picking another agent does to a session that has a conversation:\n# \"new-tab\" keeps it and opens the new agent in a new tab, \"handoff\" switches\n# in place and attaches it to the next message, \"reset\" switches in place and\n# starts over. (default: \"reset\")",
    ),
    (
        "rememberBeforeSwitch",
        "# Before switching agents on a chat with a conversation, send the agent being\n# left /remember (when it offers that command) and wait for it to save what it\n# learned to shared memory. Costs one turn per switch. (default: false)",
    ),
    (
        "gitBlameInline",
        "# Inline git blame — a dim author/age/summary annotation trailing the active\n# line in the editor. (default: true) A project can override it in its own\n# .atlas/config.toml.",
    ),
    (
        "gitAutoFetch",
        "# Quietly `git fetch` the open project when it opens, when Atlas regains\n# focus, and every few minutes, so the Pull badge shows what the remote has.\n# Never pulls or touches your files. (default: true) A project can turn it\n# off, never on, in its own .atlas/config.toml.",
    ),
    (
        "keepAwakeWhileRunning",
        "# Keep the computer awake while an Atlas agent is actively running. Prevents\n# idle system sleep; display can still turn off. No effect on Windows.\n# (default: false)",
    ),
    (
        "autoUpdate",
        "# Check for a newer signed Atlas release on startup and prompt when one is\n# available. (default: true)",
    ),
    (
        "curatedPluginSync",
        "# Let Atlas Agent download the latest curated plugin catalog when it starts —\n# a network request at every launch. Applies the next time the agent starts.\n# (default: false)",
    ),
    (
        "instructionSync",
        "# Mirror CLAUDE.md and .claude/rules/ into a marked block of the active\n# project's AGENTS.md, kept current as they change, for any agent that reads\n# AGENTS.md. Writes into the repository; text outside the block is never\n# changed. Off: the block is taken back out. (default: false)",
    ),
    (
        "updaterIgnoredVersion",
        "# updaterIgnoredVersion: A release you chose to skip in the update prompt.\n# Absent unless one was ignored — TOML has no null, so \"unset\" means the key\n# simply isn't here. Delete the line to clear it; never write an empty string.",
    ),
    (
        "enterToSend",
        "# Chat composer send gesture. true = Enter sends and Shift+Enter inserts a\n# newline; false = only Cmd/Ctrl+Enter sends. Cmd/Ctrl+Enter sends either way.\n# (default: true)",
    ),
    (
        "agentUiNavigation",
        "# Let Atlas Agent act on the window: open files at a line, switch tabs and\n# panels, fill in a chat message, type a command for you to run. It never\n# switches projects, sends for you or presses Enter. Off: its UI tools are\n# withdrawn and every call is refused. (default: true) A project can turn it\n# off, never on, in its own .atlas/config.toml.",
    ),
    (
        "agentOrgAccess",
        "# Let Atlas Agent act in your organization, as you: read the recorded\n# sessions, comments, members and conversations of the organization a\n# cloud-bound Project belongs to. Anything that reaches another person asks\n# you first. Off: its organization tools are withdrawn and every call is\n# refused. (default: true) A project can turn it off, never on, in its own\n# .atlas/config.toml.",
    ),
    (
        "agentCodeTools",
        "# Let agents search this project's code through Atlas: grep for text and find\n# files by name, in-process, respecting .gitignore and never reading secret\n# files such as .env. Off: the code tools are withdrawn and every call is\n# refused; agents use their own shell instead. (default: true) A project can\n# turn it off, never on, in its own .atlas/config.toml.",
    ),
    (
        "memoryDreams",
        "# Once a day, when there are new sessions, ask the memory model to propose\n# changes to shared memory (add, merge, archive, rewrite, link). Proposals\n# wait in Memory > Review; nothing is applied without you. Uses the same model\n# and consent as extraction. (default: false) A project can turn it off, never\n# on, in its own .atlas/config.toml.",
    ),
    (
        "memoryRepoMirror",
        "# Keep a read-only Agent Memory Repo mirror of each project's active memory,\n# as a local git repository outside the project. No remote, nothing is pushed.\n# (default: false) A project can turn it off, never on, in its own\n# .atlas/config.toml.",
    ),
    (
        "atlasOnlyMemory",
        "# Atlas's shared memory is the only memory in Atlas sessions: agents that keep\n# their own memory, such as Claude Code's auto memory, start with it turned\n# off. Off: each agent also keeps its own memory files. (default: true)",
    ),
    (
        "terminalNotifyMinDurationMs",
        "# A successful command shorter than this many milliseconds never notifies.\n# Must be between 0 and 3600000. (default: 10000)",
    ),
    (
        "notificationsEnabled",
        "# Notifications master switch. Off silences every notification except sign-in\n# problems, which always show. (default: true)",
    ),
    (
        "notifyNeedsYouNative",
        "# OS banner for notifications that need you — a permission request, a\n# question, a terminal asking for input. Shown only when you are away.\n# (default: true)",
    ),
    (
        "notifyNeedsYouSound",
        "# Sound for notifications that need you. (default: true)",
    ),
    (
        "notifyOutcomeNative",
        "# OS banner when an agent turn or terminal command finishes or fails. Shown\n# only when you are away. (default: true)",
    ),
    (
        "notifyOutcomeSound",
        "# Sound for finished / failed notifications. (default: true)",
    ),
    (
        "notifyWarningNative",
        "# OS banner for warnings — context nearly full, rate limited, retrying, agent\n# stopped. (default: false)",
    ),
    (
        "notifyWarningSound",
        "# Sound for warnings. (default: false)",
    ),
    (
        "notifyTeamNative",
        "# OS banner for Chat direct messages and @mentions. Shown only when you are\n# away. (default: true)",
    ),
    (
        "notifyTeamSound",
        "# Sound for Chat notifications. (default: true)",
    ),
    (
        "notifyPermissionActions",
        "# Show Allow once / Deny buttons on permission banners. Off: the banner only\n# opens the session. (default: true)",
    ),
    (
        "notifyDisabledKinds",
        "# Notification kinds you switched off in Settings > Notifications, by id, e.g.\n# [\"terminal-done\", \"git-behind\"]. Unknown ids are ignored; a kind that must\n# always show (sign-in lost) cannot be silenced. (default: [])",
    ),
    (
        "notifyAgentMinDurationMs",
        "# An agent turn that finished faster than this many milliseconds stays quiet;\n# failures and requests for you are never held back. 0 turns it off. Must be\n# between 0 and 3600000. (default: 0)",
    ),
    (
        "favoriteModels",
        "# Models you starred in the composer's model picker, as \"agentType:modelId\",\n# e.g. [\"claude-code:opus\"]. Starred models open the picker on Favorites.\n# Unknown entries are ignored. (default: [])",
    ),
    (
        "confirmDeleteChat",
        "# Ask before deleting a session from the sidebar or the history. A deleted\n# session's transcript stays with its agent, but Atlas forgets the session.\n# Settling never asks, because it can be undone. (default: true)",
    ),
    (
        "confirmQuitWhileRunning",
        "# Ask before quitting while an agent is in the middle of a turn, since\n# quitting stops it. Quitting again while the question is open quits anyway.\n# (default: true)",
    ),
    (
        "defaultAgent",
        "# The agent a new session starts with: \"atlas-agent\" for Atlas Agent, or the\n# id of an installed ACP agent, such as \"claude-code\". An agent that isn't\n# installed falls back to Atlas Agent. (default: \"atlas-agent\") A project can\n# override it in its own .atlas/config.toml.",
    ),
    (
        "chatWidth",
        "# How wide the conversation and the composer may grow: \"normal\" (760 pixels),\n# \"wide\" (1080 pixels) or \"full\" (the whole panel). (default: \"normal\")",
    ),
    (
        "wordWrap",
        "# Wrap long lines in file tabs, diffs and a session's code blocks. Off: lines\n# keep their shape and scroll sideways. The wrap button in a file's or the\n# review diff's header flips this same setting. (default: true)",
    ),
    (
        "sidebarSort",
        "# The order of sessions in the sidebar: \"recent\" puts the session with the\n# latest activity first, \"created\" the one started most recently. (default:\n# \"recent\")",
    ),
    (
        "autoSettleAfterDays",
        "# Days a session may sit idle before Atlas settles it: moves it to the Settled\n# shelf at the bottom of the session sidebar, where it stays listed and\n# resumable. A session that is running, waiting for you, pinned, snoozed, or\n# that you un-settled since its last activity is left alone, and sending to a\n# settled session brings it back. 0 turns auto-settling off; settling by hand\n# still works. Must be between 0 and 90. (default: 3)",
    ),
    (
        "timeFormat",
        "# The clock for every time of day Atlas shows: \"12h\", \"24h\", or \"system\" to\n# follow your system's region settings. (default: \"system\")",
    ),
    (
        "uiFontFamily",
        "# The font for Atlas's interface and chats, as a CSS font-family list such as\n# \"Inter, sans-serif\". Empty uses the theme's font-sans if it sets one, else\n# the system font. A font that isn't installed falls through to the next one\n# in the list. (default: \"\")",
    ),
    (
        "codeFontFamily",
        "# The font for the editor, diffs and code in chats, as a CSS font-family list\n# such as \"JetBrains Mono, monospace\". Empty uses the theme's font-mono if it\n# sets one, else the platform's monospace font. The terminal uses it too\n# unless terminalFontFamily is set. (default: \"\")",
    ),
    (
        "composerFontFamily",
        "# The font for the chat composer, as a CSS font-family list. Empty uses the\n# interface font. (default: \"\")",
    ),
    (
        "terminalFontFamily",
        "# The terminal's font, as a CSS font-family list. Empty uses the code font. A\n# font that isn't fixed-width misaligns columns. (default: \"\")",
    ),
    (
        "editorFontSize",
        "# The code editor's font size, in pixels. The interface zoom scales it along\n# with everything else. (default: 13)",
    ),
    (
        "terminalFontSize",
        "# The terminal's font size, in pixels. The interface zoom scales it along with\n# everything else. (default: 13)",
    ),
    (
        "diffIgnoreWhitespace",
        "# Leave out changes that are only whitespace in diffs you read: a file's diff,\n# a commit, and a chat's changes. Diffs you stage from always show every\n# change, since a patch without the whitespace no longer applies. (default:\n# false)",
    ),
    (
        "diffFilesCollapsed",
        "# Open a diff, such as your changes or a commit, as a list of its files, each\n# collapsed to its header; click a file to expand it. Off: every file starts\n# expanded. (default: true)",
    ),
    (
        "diffPalette",
        "# The colours for added and removed lines: \"theme\" uses the theme's green and\n# red, \"blue-orange\" uses its blue and orange, which stay distinct with\n# red-green colour blindness. (default: \"theme\")",
    ),
    (
        "interfaceContrast",
        "# Contrast of borders and secondary text, in percent of what the theme draws.\n# Above 100 moves them toward the text colour, below 100 toward the\n# background. Applies to every theme, the terminal and charts included.\n# (default: 100)",
    ),
    (
        "showTurnRail",
        "# The turn rail: a column of short ticks down the left edge of a session's\n# transcript, one per turn. Hovering a tick previews the prompt and the start\n# of the reply; clicking it jumps to that turn. Off hides the rail. (default:\n# true)",
    ),
    (
        "autoSettleOnMerge",
        "# Settle a session once its linked pull request merges, when the merge came\n# after you last worked in the session. A pull request that is closed without\n# merging always settles its session. Settled sessions stay listed and\n# resumable. (default: true)",
    ),
    (
        "autoSettleKeepPullRequests",
        "# Auto-settling after days of inactivity (autoSettleAfterDays) leaves a\n# session alone while it has a linked pull request. Merging or closing it can\n# still settle the session (autoSettleOnMerge). (default: true)",
    ),
    (
        "pullRequestWatchWakes",
        "# When a session watches its pull request (the agent asked to, or you turned\n# the watch on), a failing check, a new review or comment, or a conflict with\n# the base sends the session's agent an update so it can act. Off: watches\n# still track the pull request but never prompt an agent. (default: true)",
    ),
    (
        "pullRequestLinksOpenInApp",
        "# Open a pull request link from a session, the sidebar or a transcript in\n# Atlas's pull request tab when it belongs to the project's repository. Off,\n# or a pull request of another repository: it opens in the browser. (default:\n# true)",
    ),
    (
        "pullRequestMergeMethod",
        "# The method a pull request's Merge button starts on: \"merge\", \"squash\" or\n# \"rebase\", or \"last\" for whichever you picked most recently on this device. A\n# method the repository doesn't allow falls back to one it does. (default:\n# \"last\") A project can override it in its own .atlas/config.toml.",
    ),
    (
        "removeAgentCreditsOnMerge",
        "# Remove recognized agent credit lines (an agent's Co-Authored-By trailer, a\n# \"Generated with\" footer) from the message of a merge or squash Atlas\n# performs, auto-merge included. Human co-authors are kept. Commits already on\n# the branch are not rewritten. (default: false) A project can override it in\n# its own .atlas/config.toml.",
    ),
    (
        "pullRequestGuideEnabled",
        "# Show the Guide tab on pull requests, where an agent writes a tour of the\n# change in reading order, with the calls a maintainer should make. The agent\n# reads a checkout of the pull request's head and changes nothing. (default:\n# true) A project can override it in its own .atlas/config.toml.",
    ),
    (
        "pullRequestGuideAgent",
        "# The agent that writes review guides: \"atlas-agent\" or an installed ACP\n# agent's id, such as \"claude-code\". Empty uses defaultAgent. An agent that\n# isn't installed falls back to Atlas Agent. (default: \"\") A project can\n# override it in its own .atlas/config.toml.",
    ),
    (
        "pullRequestGuideModel",
        "# The model the guide's agent runs on, as that agent names it (the id after\n# the colon in favoriteModels). The guide reads the change over many steps, so\n# a stronger model helps. Empty keeps the agent's default; a model the agent\n# doesn't offer is ignored. (default: \"\") A project can override it in its own\n# .atlas/config.toml.",
    ),
    (
        "pullRequestGuideInstructions",
        "# Your preferences for review guides, added to the guide's prompt: what to\n# show first, dwell on or skip, and how long summaries should be. The guide's\n# format and its coverage of every changed file stay the same. (default: \"\") A\n# project can override it in its own .atlas/config.toml.",
    ),
];

/// The keys a project's `.atlas/config.toml` may override (`project` in the
/// registry). Any other key there is ignored and reported.
pub const PROJECT_SETTING_KEYS: &[&str] = &[
    "gitBlameInline",
    "gitAutoFetch",
    "agentUiNavigation",
    "agentOrgAccess",
    "agentCodeTools",
    "memoryDreams",
    "memoryRepoMirror",
    "defaultAgent",
    "pullRequestMergeMethod",
    "removeAgentCreditsOnMerge",
    "pullRequestGuideEnabled",
    "pullRequestGuideAgent",
    "pullRequestGuideModel",
    "pullRequestGuideInstructions",
];

/// Of those, the booleans a project may only turn off (`project = "tighten"`):
/// a repository can commit that file, so it never switches on what the user
/// switched off.
pub const PROJECT_TIGHTEN_ONLY_KEYS: &[&str] = &[
    "gitAutoFetch",
    "agentUiNavigation",
    "agentOrgAccess",
    "agentCodeTools",
    "memoryDreams",
    "memoryRepoMirror",
];
