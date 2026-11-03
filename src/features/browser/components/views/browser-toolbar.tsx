import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import {
  Globe,
  ExternalLink,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Save,
  Search,
  AppWindow,
  RotateCw,
  BookText,
  Zap,
} from "lucide-react";
import type { BrowserMode } from "../../lib/browser-types";

/** The Browser tab's address bar: history, the omnibox, the Reader toggle and
 *  the page actions. */
export function BrowserAddressBar({
  mode,
  inputUrl,
  canBack,
  canFwd,
  isLoading,
  canSave,
  searchOpen,
  onBack,
  onForward,
  onReload,
  onInputChange,
  onNavigate,
  onToggleReader,
  onSave,
  onSearchOpenChange,
  onOpenWindow,
  onOpenExternal,
}: {
  mode: BrowserMode;
  inputUrl: string;
  canBack: boolean;
  canFwd: boolean;
  isLoading: boolean;
  /** Reader mode with a page and a project to save it into. */
  canSave: boolean;
  searchOpen: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onInputChange: (value: string) => void;
  onNavigate: (raw: string) => void;
  onToggleReader: () => void;
  onSave: () => void;
  onSearchOpenChange: (open: boolean) => void;
  onOpenWindow: () => void;
  onOpenExternal: () => void;
}) {
  const isLive = mode === "live";
  return (
    <div className="flex items-center gap-1.5 px-2 h-[36px] shrink-0 border-b border-border bg-background">
      {/* The live webview paints over anything below this bar, so the
          address-bar tooltips open upward. */}
      <HintGroup side="top">
        <HintItem label="Back">
          <button
            onClick={onBack}
            disabled={!canBack}
            className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer disabled:opacity-30"
          >
            <ArrowLeft size={12} />
          </button>
        </HintItem>
        <HintItem label="Forward">
          <button
            onClick={onForward}
            disabled={!canFwd}
            className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer disabled:opacity-30"
          >
            <ArrowRight size={12} />
          </button>
        </HintItem>
        <HintItem label="Reload">
          <button
            onClick={onReload}
            className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer"
          >
            {isLoading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          </button>
        </HintItem>
      </HintGroup>

      <div className="flex-1 flex items-center gap-2 h-7 rounded border border-border bg-card px-2 focus-within:ring-1 focus-within:ring-border-strong">
        <Globe size={11} className="text-muted-foreground shrink-0" />
        <input
          value={inputUrl}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onNavigate(inputUrl);
          }}
          className="flex-1 bg-transparent outline-none text-xs text-foreground font-mono placeholder:text-muted-foreground"
          placeholder="Search or enter URL"
        />
      </div>

      {/* Reader toggle — renders a clean view of the current page; toggle off
          returns to the live webview. */}
      <button
        onClick={onToggleReader}
        className={cn(
          "flex items-center gap-1 px-1.5 h-6 rounded transition-colors cursor-pointer",
          mode === "reader"
            ? "bg-element-hover text-foreground"
            : "hover:bg-element-hover text-muted-foreground",
        )}
        title={mode === "reader" ? "Back to live page" : "Reader view of this page"}
      >
        {mode === "reader" ? <Zap size={11} /> : <BookText size={11} />}
        <span className="text-2xs">{mode === "reader" ? "Live" : "Reader"}</span>
      </button>

      <HintGroup side="top">
        {canSave && (
          <HintItem label="Save to knowledge base">
            <button
              onClick={onSave}
              className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer"
            >
              <Save size={12} />
            </button>
          </HintItem>
        )}
        {!isLive && (
          <HintItem label="Find in page">
            <button
              onClick={() => onSearchOpenChange(!searchOpen)}
              className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer"
            >
              <Search size={12} />
            </button>
          </HintItem>
        )}
        <HintItem label="Open in browser window">
          <button
            onClick={onOpenWindow}
            className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer"
          >
            <AppWindow size={12} />
          </button>
        </HintItem>
        <HintItem label="Open in system browser">
          <button
            onClick={onOpenExternal}
            className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer"
          >
            <ExternalLink size={12} />
          </button>
        </HintItem>
      </HintGroup>
    </div>
  );
}

/** Reader mode's find-in-page bar. */
export function BrowserFindBar({
  searchQuery,
  onSearchQueryChange,
  onSearch,
  onClose,
}: {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearch: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 h-[32px] shrink-0 border-b border-border bg-background">
      <Search size={11} className="text-muted-foreground shrink-0" />
      <input
        value={searchQuery}
        onChange={(e) => onSearchQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSearch();
          if (e.key === "Escape") onClose();
        }}
        className="flex-1 bg-transparent outline-none text-xs text-foreground placeholder:text-muted-foreground"
        placeholder="Find in page..."
        autoFocus
      />
    </div>
  );
}
