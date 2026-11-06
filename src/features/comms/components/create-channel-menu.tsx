import { useState } from "react";
import { toast } from "sonner";
import { comms } from "../lib/comms-api";
import { useCommsStore } from "../stores/comms-store";
import { CreateChannelMenuView } from "./views/create-channel-menu-view";

/** The Channels section's `+`: creates the channel, then opens it. */
export function CreateChannelMenu() {
  const actions = useCommsStore.use.actions();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const create = async (name: string, isPrivate: boolean) => {
    setPending(true);
    try {
      const conversation = await comms.createChannel(name, isPrivate ? "private" : undefined);
      setOpen(false);
      // Don't wait for the org-wide broadcast round trip to render our own act.
      actions.adoptConversation(conversation);
      actions.openConversation(conversation.id);
    } catch (e) {
      console.warn("comms: create channel failed:", e);
      toast.error(typeof e === "string" ? e : "Could not create that channel.");
      setPending(false);
    }
  };

  return (
    <CreateChannelMenuView
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPending(false);
      }}
      pending={pending}
      onCreate={(name, isPrivate) => void create(name, isPrivate)}
    />
  );
}
