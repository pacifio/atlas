// Who sent a prompt that did not come from this window's composer: their face
// and name under the bubble, the way the web viewer says "Sent by …".
//
// The room never names a user (`rc-people.ts`), so the wire's name is a
// fallback; the id is resolved against the signed-in account and the room's
// Organisation first. A prompt you sent from your phone reads as yours.
// Only the live row knows its origin — a snapshot carries none, so after a
// reload the caption is gone.

import { RadioTower } from "lucide-react";
import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { useRcPeople } from "../lib/rc-people";
import { useChatStore } from "../stores/chat-store";
import { useRcRoom } from "../stores/rc-store";

export function RemoteAuthor({
  tabId,
  id,
  fallback,
}: {
  tabId: string;
  id: string | null;
  fallback: string;
}) {
  const sessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId ?? null);
  const room = useRcRoom(sessionId);
  const people = useRcPeople(room?.scope?.orgId ?? null);
  const person = id ? people(id, fallback === "Someone else" ? null : fallback) : null;
  const label = person ? (person.isYou ? `${person.label} (you)` : person.label) : fallback;

  return (
    <span
      data-testid="user-row-remote-author"
      className="mt-1 flex items-center gap-1.5 text-2xs text-[var(--muted-foreground)]"
      title="Sent from remote control"
    >
      {person ? <AccountAvatar user={person.user} size={14} /> : <RadioTower size={10} />}
      <span>
        Sent by <span className="text-secondary-foreground">{label}</span> · remote control
      </span>
    </span>
  );
}
