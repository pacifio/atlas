import type { ReactNode } from "react";
import { EmptyState } from "@tryatlas/design";

/** The draft editor tab's frame: the editor, or the note that its draft or
 *  conversation is gone. */
export function CommsDraftTabView({
  missing,
  children,
}: {
  missing: boolean;
  children?: ReactNode;
}) {
  if (missing) {
    return (
      <EmptyState
        data-view="comms-draft-tab"
        className="h-full"
        title="This draft is no longer available."
      />
    );
  }
  return (
    <div data-view="comms-draft-tab" className="flex h-full flex-col bg-background">
      {children}
    </div>
  );
}
