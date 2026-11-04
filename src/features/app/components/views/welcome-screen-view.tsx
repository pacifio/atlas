import { Clock, Folder, FolderOpen, X } from "lucide-react";
import { Button, Hint, IconButton, Kbd } from "@tryatlas/design";
import { AtlasIcon } from "@/components/brand-marks";

export interface WelcomeScreenViewProps {
  recents: ReadonlyArray<{ name: string; path: string }>;
  /** The command palette's chord; always shown. */
  paletteHint: string;
  /** The chord of the add-a-folder action, if it is bound. */
  openFolderHint?: string;
  onOpenFolder: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
}

/** The centre with no project open: open a folder, or one you had. */
export function WelcomeScreenView({
  recents,
  paletteHint,
  openFolderHint,
  onOpenFolder,
  onOpenRecent,
  onRemoveRecent,
}: WelcomeScreenViewProps) {
  return (
    <div
      data-view="welcome-screen"
      className="h-full flex items-center justify-center bg-background"
    >
      <div className="w-[360px] space-y-8">
        {/* Branding */}
        <div className="text-center space-y-2">
          <AtlasIcon size={64} className="mx-auto mb-4 rounded-2xl" />
          <h1 className="text-xl font-semibold text-foreground">Atlas</h1>
          <p className="text-sm text-secondary-foreground">Multiplayer AI development</p>
        </div>

        {/* Primary action */}
        <Button variant="outline" size="lg" className="w-full justify-start" onClick={onOpenFolder}>
          <FolderOpen size={14} className="text-primary" />
          Open Folder
          {openFolderHint && <Kbd className="ml-auto">{openFolderHint}</Kbd>}
        </Button>

        {/* Recent projects */}
        {recents.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 px-1">
              <Clock size={11} className="text-muted-foreground" />
              <span className="text-2xs font-semibold text-muted-foreground uppercase tracking-wide">
                Recent Projects
              </span>
            </div>
            <div className="space-y-1">
              {recents.map((project) => (
                // The row is a wrapper holding two siblings, the open button and
                // Remove, so no control sits inside another.
                <div
                  key={project.path}
                  className="group flex items-center gap-1 pr-2 rounded-lg hover:bg-element-hover focus-within:bg-element-hover transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => onOpenRecent(project.path)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg py-2 pl-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Folder size={14} className="text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {project.name}
                      </div>
                      <div className="text-2xs text-muted-foreground truncate font-mono">
                        {project.path}
                      </div>
                    </div>
                  </button>
                  <span className="inline-flex opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <Hint label="Remove from recents">
                      <IconButton
                        size="xs"
                        icon={X}
                        label="Remove from recents"
                        onClick={() => onRemoveRecent(project.path)}
                      />
                    </Hint>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Hint */}
        <div className="text-center">
          <span className="text-2xs text-muted-foreground">
            Press <Kbd>{paletteHint}</Kbd> for command palette
          </span>
        </div>
      </div>
    </div>
  );
}
