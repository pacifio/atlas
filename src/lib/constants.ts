const TAB_TYPES = [
  "chat",
  "canvas",
  "browser",
  "tasks",
  "editor",
  "knowledge",
  "knowledge-graph",
  "memory",
  "terminal",
  "diff",
  "settings",
  "log",
  "media",
  "svg",
  "pdf",
  "unsupported",
  "pomodoro",
  "mission-control",
  "artifacts",
] as const;

export type TabType = (typeof TAB_TYPES)[number];
