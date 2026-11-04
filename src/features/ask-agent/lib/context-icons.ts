// The glyph a context chip wears, the same in the ask box and in the composer.

import {
  Brain,
  CircleAlert,
  FileCode,
  FileDiff,
  GitCommitHorizontal,
  Quote,
  type LucideIcon,
} from "lucide-react";

import type { AgentContext } from "./agent-context";

export const CONTEXT_ICON: Record<AgentContext["kind"], LucideIcon> = {
  file_range: FileCode,
  diff_hunk: FileDiff,
  memory_entry: Brain,
  commit: GitCommitHorizontal,
  error: CircleAlert,
  quote: Quote,
};
