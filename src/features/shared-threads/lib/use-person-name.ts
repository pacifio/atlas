import { useMemo } from "react";

import { useCommsStore } from "@/features/comms/stores/comms-store";

/**
 * A thread participant's name, from the Organisation's member list the chat
 * already holds; their user id while that list has not loaded or does not
 * know them (ATL-407 avatars and carets).
 */
export function usePersonName(): (userId: string) => string {
  const members = useCommsStore.use.members();
  return useMemo(() => {
    const byId = new Map(members.map((m) => [m.id, m.name]));
    return (userId: string) => byId.get(userId)?.trim() || userId;
  }, [members]);
}
