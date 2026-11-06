import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import { comms } from "../lib/comms-api";
import type { ChatConversation } from "../types";
import { useCommsStore } from "../stores/comms-store";
import { RenameChannelMenuView } from "./views/rename-channel-menu-view";

/**
 * Rename a channel — `PATCH /conversations/{id} { name }`, open to any member
 * (an org admin too). Channels only: `kind` is immutable server-side and a
 * DM refuses a name outright, so no other conversation ever offers this.
 *
 * The response carries the whole updated conversation; adopting it paints
 * the header, tab label and home list at once, ahead of the org-wide
 * `conversation.updated` broadcast that keeps everyone else honest.
 */
export function RenameChannelMenu({
  conv,
  children,
}: {
  conv: ChatConversation;
  children: ReactElement;
}) {
  const actions = useCommsStore.use.actions();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const save = async (name: string) => {
    setPending(true);
    try {
      const updated = await comms.patchConversation(conv.id, { name });
      setOpen(false);
      actions.adoptConversation(updated);
    } catch (e) {
      console.warn("comms: rename failed:", conv.id, e);
      toast.error(typeof e === "string" ? e : "Could not rename that channel.");
      setPending(false);
    }
  };

  return (
    <RenameChannelMenuView
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPending(false);
      }}
      initialName={conv.name ?? ""}
      pending={pending}
      onSave={(name) => void save(name)}
      trigger={children}
    />
  );
}
