import type { MouseEvent, Ref } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import {
  Globe,
  ExternalLink,
  Loader2,
  Search,
  Copy,
  BookOpen,
  AppWindow,
  BookText,
} from "lucide-react";
import type { ReadableContent } from "../../lib/browser-types";

/** Reader mode's body: the sanitized page, its loading/error/empty states,
 *  and its context menu. */
export function BrowserReaderSurface({
  contentRef,
  page,
  loading,
  error,
  canSave,
  onContentClick,
  onRetry,
  onQuickLink,
  onCopySelection,
  onCopyLink,
  onOpenSearch,
  onOpenWindow,
  onOpenExternal,
  onSave,
}: {
  contentRef: Ref<HTMLDivElement>;
  page: ReadableContent | null;
  loading: boolean;
  error: string | null;
  /** A page and a project to save it into. */
  canSave: boolean;
  onContentClick: (e: MouseEvent) => void;
  onRetry: () => void;
  onQuickLink: (site: string) => void;
  onCopySelection: () => void;
  onCopyLink: () => void;
  onOpenSearch: () => void;
  onOpenWindow: () => void;
  onOpenExternal: () => void;
  onSave: () => void;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <div
            className="flex-1 overflow-auto hide-scrollbar"
            onContextMenu={(e) => e.stopPropagation()}
          >
            {loading && (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={20} className="animate-spin text-primary" />
              </div>
            )}
            {error && (
              <div className="px-6 py-8 text-center">
                <p className="text-sm text-error">{error}</p>
                <button
                  onClick={onRetry}
                  className="mt-2 text-xs text-primary underline cursor-pointer"
                >
                  Retry
                </button>
              </div>
            )}
            {!loading && !error && page && (
              <div className="select-text">
                <div className="px-4 py-3 border-b border-border">
                  <h1 className="text-lg font-semibold text-foreground leading-snug">
                    {page.title}
                  </h1>
                  <span className="text-2xs text-muted-foreground font-mono">{page.url}</span>
                </div>
                <div
                  ref={contentRef}
                  className="reader-content px-4 py-4"
                  onClick={onContentClick}
                  dangerouslySetInnerHTML={{ __html: page.html }}
                />
              </div>
            )}
            {!loading && !error && !page && (
              <div className="h-full flex items-center justify-center py-16">
                <div className="text-center space-y-3">
                  <BookText size={32} className="text-muted-foreground mx-auto" />
                  <p className="text-sm text-secondary-foreground">
                    Reader mode — enter a URL for a clean, JS-free view
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center max-w-[300px] pt-2">
                    {[
                      "arxiv.org",
                      "github.com",
                      "news.ycombinator.com",
                      "developer.mozilla.org",
                    ].map((site) => (
                      <button
                        key={site}
                        onClick={() => onQuickLink(site)}
                        className="px-2.5 py-1 rounded border border-border bg-card text-2xs text-secondary-foreground hover:bg-element-hover hover:text-foreground transition-colors font-mono cursor-pointer"
                      >
                        {site}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        }
      />
      <ContextMenu.Portal>
        {/* Base UI positions the Popup through a Positioner, and the Popup
            is static inside it — the z-index has to sit on the Positioner
            or it does nothing. */}
        <ContextMenu.Positioner className="z-popover">
          <ContextMenu.Popup className="w-[180px] rounded-lg border border-border bg-card shadow-md py-1">
            <ContextMenu.Item
              onClick={onCopySelection}
              className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
            >
              <Copy size={11} className="text-muted-foreground" /> Copy Selection
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={onCopyLink}
              className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
            >
              <Globe size={11} className="text-muted-foreground" /> Copy Link
            </ContextMenu.Item>
            <ContextMenu.Separator className="h-px bg-border my-1" />
            <ContextMenu.Item
              onClick={onOpenSearch}
              className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
            >
              <Search size={11} className="text-muted-foreground" /> Find in Page
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={onOpenWindow}
              className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
            >
              <AppWindow size={11} className="text-muted-foreground" /> Open in Browser Window
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={onOpenExternal}
              className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
            >
              <ExternalLink size={11} className="text-muted-foreground" /> Open in System Browser
            </ContextMenu.Item>
            {canSave && (
              <>
                <ContextMenu.Separator className="h-px bg-border my-1" />
                <ContextMenu.Item
                  onClick={onSave}
                  className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
                >
                  <BookOpen size={11} className="text-muted-foreground" /> Save to Knowledge
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
