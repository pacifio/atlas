import { useMemo, useState } from "react";
import { toast } from "sonner";
import { comms } from "../lib/comms-api";
import { useCommsStore } from "../stores/comms-store";
import { NewDmMenuView } from "./views/new-dm-menu-view";

/**
 * The Direct messages section's `+`.
 *
 * One selection goes through `createDm`, which is idempotent — picking
 * somebody you already talk to opens the existing thread. Two-plus goes
 * through `createGroupDm`, which deliberately is NOT: membership is frozen
 * at creation, so every group starts fresh with no history to leak.
 */
export function NewDmMenu() {
  const memberList = useCommsStore.use.members();
  const me = useCommsStore.use.me();
  const actions = useCommsStore.use.actions();

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const candidates = useMemo(
    () => memberList.filter((m) => m.id !== me).sort((a, b) => a.name.localeCompare(b.name)),
    [memberList, me],
  );

  const start = async (ids: string[]) => {
    setPending(true);
    try {
      const conversation =
        ids.length === 1
          ? (await comms.createDm(ids[0])).conversation
          : await comms.createGroupDm(ids);
      setOpen(false);
      actions.adoptConversation(conversation);
      actions.openConversation(conversation.id);
    } catch (e) {
      console.warn("comms: start conversation failed:", e);
      toast.error(typeof e === "string" ? e : "Could not start that conversation.");
      setPending(false);
    }
  };

  return (
    <NewDmMenuView
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPending(false);
      }}
      pending={pending}
      candidates={candidates}
      totalMembers={memberList.length}
      onStart={(ids) => void start(ids)}
    />
  );
}
