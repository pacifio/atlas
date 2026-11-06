import type { TabType } from "@/lib/constants";

/** A predefined split/tab arrangement applied via the layout switcher (⌘⌥L) or
 *  Settings → Layouts. Applied to the ACTIVE project. */
export interface LayoutTemplate {
  id: string;
  name: string;
  description: string;
  /** Split columns, left→right (1–3). Each cell is the tab type that fills it;
   *  the first is the main column, which holds the agent. */
  columns: { type: TabType; title: string }[];
  /** Index of the column to focus after applying (default last). */
  focus?: number;
}

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: "focus",
    name: "Focus",
    description: "Just the agent — a single column.",
    columns: [{ type: "chat", title: "Agents" }],
  },
  {
    id: "develop",
    name: "Develop",
    description: "Agent + editor. The classic IDE setup.",
    columns: [
      { type: "chat", title: "Agents" },
      { type: "editor", title: "Editor" },
    ],
    focus: 0,
  },
  {
    id: "terminal",
    name: "Terminal",
    description: "Agent next to a terminal.",
    columns: [
      { type: "chat", title: "Agents" },
      { type: "terminal", title: "Terminal" },
    ],
    focus: 0,
  },
  {
    id: "review",
    name: "Review",
    description: "Agent with source control beside it.",
    columns: [
      { type: "chat", title: "Agents" },
      { type: "source-control", title: "Source control" },
    ],
    focus: 0,
  },
];
