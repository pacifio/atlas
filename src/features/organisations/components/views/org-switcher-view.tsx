import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@tryatlas/design";

import { BreadcrumbButton } from "@/components/breadcrumb-button";

/**
 * The org half of the title bar's `org / project` breadcrumb: the org's name
 * and a chevron, opening the organisation menu (`panel`). The same panel is
 * the Organization submenu at the foot of the sidebar's project picker.
 *
 * `overlays` are the create, members and delete dialogs, which outlive the
 * menu and so render beside it.
 */
export function OrgSwitcherView({
  name,
  open,
  onOpenChange,
  panel,
  overlays,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  panel: ReactNode;
  overlays: ReactNode;
}) {
  return (
    <div data-view="org-switcher" className="flex min-w-0 shrink items-center">
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger
          render={<BreadcrumbButton title="Switch organization">{name}</BreadcrumbButton>}
        />
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="flex max-h-[min(480px,70vh)] w-[268px] flex-col"
        >
          {panel}
        </DropdownMenuContent>
      </DropdownMenu>
      {overlays}
    </div>
  );
}
