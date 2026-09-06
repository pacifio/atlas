// Design-sync bundle entry. Re-exports the presentational primitives of the
// Atlas design system — the components that render standalone, with no Tauri
// IPC, workspace store, or router context. Kept in sync with
// `componentSrcMap` in .design-sync/config.json.

export { Kbd, KbdGroup, KbdKeys, KbdCombo } from "@/ui/kbd";
export { ScrollArea } from "@/ui/scroll-area";
export { SecretInput } from "@/ui/secret-input";
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/tooltip";
export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/ui/context-menu";

export { AgentMark } from "@/components/agent-mark";
export { AtlasIcon } from "@/components/atlas-icon";
export { AtlasLoader } from "@/components/atlas-loader";
export { GithubIcon } from "@/components/github-icon";
export { GradualBlur } from "@/components/gradual-blur";
export { GraphRuler } from "@/components/graph-ruler";
export { PanelSkeleton } from "@/components/panel-skeleton";
export { ProviderLogo } from "@/components/provider-logo";
export { TrendSparkline } from "@/components/trend-sparkline";
export { AgentMonogram, ExternalAgentIcon } from "@/components/agent-icons";
