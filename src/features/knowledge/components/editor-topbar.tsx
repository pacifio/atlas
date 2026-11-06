import { Fragment } from "react";
import { Folder, PanelRight } from "lucide-react";
import {
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Hint,
  Icon,
  IconButton,
  RailGlyph,
} from "@tryatlas/design";

interface EditorTopbarProps {
  /** Folder/segment trail (empty for root-level pages). */
  breadcrumbs?: string[];
  /** Trailing page name. */
  title: string;
  /** Icon emoji or null. Falls back to a doc glyph. */
  icon?: string | null;
  /** Tag pill on the right ("NOTE", "REPO" etc.). */
  kind?: string;
  /** Show a small dirty dot before the inspector toggle. */
  isDirty?: boolean;
  /** Toggle the left sidebar; the open button only shows when hidden. */
  onToggleSidebar?: () => void;
  sidebarHidden?: boolean;
  /** Toggle the right inspector panel. */
  onToggleInspector?: () => void;
}

/**
 * Compact note topbar. Just breadcrumbs + kind pill + a single
 * inspector toggle on the right — History / Pin / More were removed in
 * batch 1 of the user's feedback since none of them wire to anything.
 */
export function EditorTopbar({
  breadcrumbs = [],
  title,
  icon,
  kind = "NOTE",
  isDirty,
  onToggleSidebar,
  sidebarHidden,
  onToggleInspector,
}: EditorTopbarProps) {
  return (
    <div
      data-view="editor-topbar"
      className="flex h-[36px] shrink-0 items-center gap-2 border-b border-border-subtle bg-panel px-3.5"
    >
      {onToggleSidebar && (
        <Hint label={sidebarHidden ? "Show sidebar" : "Hide sidebar"}>
          <button
            type="button"
            onClick={onToggleSidebar}
            className="-ml-1.5 inline-flex size-control-sm items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-element-hover hover:text-secondary-foreground"
          >
            <RailGlyph open={!sidebarHidden} size="sm" />
          </button>
        </Hint>
      )}
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap overflow-hidden">
          {breadcrumbs.map((segment, i) => (
            <Fragment key={i}>
              <BreadcrumbItem className="min-w-0 shrink">
                <Icon icon={Folder} size="sm" className="shrink-0" />
                <span className="truncate">{segment}</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
            </Fragment>
          ))}
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="leading-none">{icon ?? "📄"}</span>
                <span className="truncate">{title}</span>
              </span>
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <Badge variant="outline" size="md">
        {kind}
      </Badge>

      <span className="flex-1" />

      {isDirty && (
        <span
          role="img"
          aria-label="Unsaved changes"
          title="Unsaved changes"
          className="size-1.5 shrink-0 rounded-full bg-foreground"
        />
      )}
      {onToggleInspector && (
        <Hint label="Toggle inspector">
          <IconButton
            icon={PanelRight}
            label="Toggle inspector"
            size="sm"
            onClick={onToggleInspector}
          />
        </Hint>
      )}
    </div>
  );
}
