import type { Ref } from "react";
import { isBrowserMock } from "@/lib/env";
import { Globe, ExternalLink, BookOpen, AppWindow } from "lucide-react";

/**
 * Live mode's body: the placeholder the native webview is positioned over,
 * and what shows through it when there is no webview on top — the mock
 * notice, the embed-failure fallback, the overlay pause, the start page.
 */
export function BrowserLiveSurface({
  placeholderRef,
  embedError,
  paused,
  pausedLabel,
  showStartPage,
  onSwitchToReader,
  onOpenWindow,
  onOpenExternal,
  onQuickLink,
}: {
  placeholderRef: Ref<HTMLDivElement>;
  embedError: string | null;
  /** The embed exists and a DOM overlay has forced it hidden. */
  paused: boolean;
  /** The page's title, else its URL, named while paused. */
  pausedLabel: string;
  showStartPage: boolean;
  onSwitchToReader: () => void;
  onOpenWindow: () => void;
  onOpenExternal: () => void;
  onQuickLink: (site: string) => void;
}) {
  return (
    <div ref={placeholderRef} className="flex-1 relative bg-background">
      <NativeOnlyNotice />
      {/* Safe fallback UI when native webview containment or creation fails */}
      {embedError && (
        <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-auto bg-background z-10">
          <div className="flex max-w-[380px] flex-col items-center gap-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card">
              <Globe size={22} className="text-muted-foreground" />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">Native Embed Fallback</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                The embedded live browser could not be native-contained in this panel area. You can
                view in Reader mode or open in a separate window:
              </p>
              <p className="truncate pt-1 font-mono text-2xs text-muted-foreground">{embedError}</p>
            </div>
            <div className="flex flex-col gap-2 pt-1 w-full max-w-[280px]">
              <button
                onClick={onSwitchToReader}
                className="flex items-center justify-center gap-2 rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90 cursor-pointer"
              >
                <BookOpen size={14} />
                Switch to Reader mode
              </button>
              <button
                onClick={onOpenWindow}
                className="flex items-center justify-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer"
              >
                <AppWindow size={14} />
                Open in a new window
              </button>
              <button
                onClick={onOpenExternal}
                className="flex items-center justify-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer"
              >
                <ExternalLink size={14} />
                Open in default browser
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Shown when an overlay forces the native webview to hide — it sits
          UNDER the webview, so it's only visible while the webview is gone. */}
      {paused && (
        <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-auto">
          <div className="flex max-w-[380px] flex-col items-center gap-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card">
              <Globe size={22} className="text-muted-foreground" />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">Browser paused</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                A menu or dialog is open on top. Keep browsing without interruption:
              </p>
              {pausedLabel && (
                <p className="truncate pt-1 font-mono text-2xs text-secondary-foreground">
                  {pausedLabel}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2 pt-1 w-full max-w-[280px]">
              <button
                onClick={onOpenWindow}
                className="flex items-center justify-center gap-2 rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90 cursor-pointer"
              >
                <AppWindow size={14} />
                Continue in a new window
              </button>
              <button
                onClick={onOpenExternal}
                className="flex items-center justify-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer"
              >
                <ExternalLink size={14} />
                Open in default browser
              </button>
            </div>
          </div>
        </div>
      )}
      {/* The start page is suppressed under the browser mock: there is no
          webview for a quick link to load, and `NativeOnlyNotice` occupies
          the same box saying exactly that. */}
      {showStartPage && !isBrowserMock && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center space-y-3">
            <Globe size={32} className="text-muted-foreground mx-auto" />
            <p className="text-sm text-secondary-foreground">Enter a URL to browse</p>
            <div className="flex flex-wrap gap-2 justify-center max-w-[320px] pt-2">
              {["google.com", "youtube.com", "github.com", "news.ycombinator.com"].map((site) => (
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
  );
}

/**
 * The Browser tab's native-only placeholder (decision 39).
 *
 * Live mode is a real child `WebviewWindow` that the macOS window server parks
 * over this div — there is no `invoke()` behind it, so `src/dev/mock-backend/`
 * cannot fake it and never will. Without this, `bun run dev` drew the full
 * chrome (tab strip, address bar, reader toggle) around an empty rectangle,
 * which reads as a start page that has finished loading. A reviewer then
 * reports "the Browser tab is blank" as a defect, or worse signs the surface
 * off having never seen it.
 *
 * So it says what it is, in the place the page would be. Renders only under
 * `bun run dev` in an ordinary browser: `isBrowserMock` is a build-time
 * constant, so the whole component is eliminated from production, and inside
 * `dev:app` the real webview covers this div anyway.
 */
function NativeOnlyNotice() {
  if (!isBrowserMock) return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="flex max-w-[380px] flex-col items-center gap-4 text-center">
        <div className="flex size-control-lg items-center justify-center rounded-full border border-border bg-card">
          <AppWindow size={16} className="text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <p className="heading">Native-only surface</p>
          <p className="body text-muted-foreground">
            The live browser is a native webview the window server draws over this panel, not HTML.
            Nothing in the mock backend can stand in for it.
          </p>
          <p className="caption pt-1">
            Check it in <span className="code text-secondary-foreground">bun run dev:app</span>.
            Reader mode is ordinary themed HTML and does work here.
          </p>
        </div>
      </div>
    </div>
  );
}
