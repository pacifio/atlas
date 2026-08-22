import type { TabType } from "@/lib/constants";

type LeftSection = "files" | "knowledge";
type RightSection = "changes" | "github" | "git-graph";

/** A predefined panel/split/tab arrangement applied via the layout switcher
 *  (⌘⌥L) or Settings → Layouts. Applied to the ACTIVE workspace. */
export interface LayoutTemplate {
  id: string;
  name: string;
  description: string;
  /** Side/bottom panel visibility (omitted = hidden). */
  panels: { left?: boolean; right?: boolean; bottom?: boolean };
  leftSection?: LeftSection;
  rightSection?: RightSection;
  /** Split columns, left→right (1–3). Each cell is the tab type that fills it. */
  columns: { type: TabType; title: string }[];
  /** Index of the column to focus after applying (default last). */
  focus?: number;
}

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: "focus",
    name: "Focus",
    description: "Just the agent — single column, no side panels.",
    panels: {},
    columns: [{ type: "chat", title: "Agents" }],
  },
  {
    id: "develop",
    name: "Develop",
    description: "Files + editor + agent. The classic IDE setup.",
    panels: { left: true },
    leftSection: "files",
    columns: [
      { type: "editor", title: "Editor" },
      { type: "chat", title: "Agents" },
    ],
    focus: 1,
  },
  {
    id: "research",
    name: "Research",
    description: "Knowledge, agent and the web side by side.",
    panels: {},
    columns: [
      { type: "knowledge", title: "Knowledge" },
      { type: "chat", title: "Agents" },
      { type: "browser", title: "Browser" },
    ],
    focus: 1,
  },
  {
    id: "terminal",
    name: "Terminal",
    description: "Agent next to a terminal, with the file tree.",
    panels: { left: true },
    leftSection: "files",
    columns: [
      { type: "chat", title: "Agents" },
      { type: "terminal", title: "Terminal" },
    ],
    focus: 0,
  },
  {
    id: "review",
    name: "Review",
    description: "Agent with the code-review panel open.",
    panels: { right: true },
    rightSection: "changes",
    columns: [{ type: "chat", title: "Agents" }],
  },
  {
    id: "console",
    name: "Console",
    description: "The cross-project analytics dashboard.",
    panels: {},
    columns: [{ type: "mission-control", title: "Console" }],
  },
];
