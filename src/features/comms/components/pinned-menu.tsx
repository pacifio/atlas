import { useEffect, useState } from "react";
import { comms } from "../lib/comms-api";
import type { ChatPin, OrgMemberProfile } from "../types";
import { PinnedMenuView } from "./views/pinned-menu-view";

/**
 * The conversation header's pin count, opening the pin rail.
 *
 * Rows come from `comms_pins` fresh on every open, not from the store: the
 * store holds pinned *ids* only, and a pin can point far outside the loaded
 * message window — the REST rail carries each message riding with its pin.
 */
export function PinnedMenu({
  convId,
  count,
  members,
  onJump,
}: {
  convId: string;
  count: number;
  members: Map<string, OrgMemberProfile>;
  onJump: (messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ChatPin[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setRows(null);
    comms
      .pins(convId)
      .then((pins) => {
        if (live) setRows(pins);
      })
      .catch((e) => {
        console.warn("comms: pins fetch failed:", convId, e);
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [open, convId]);

  return (
    <PinnedMenuView
      count={count}
      open={open}
      onOpenChange={setOpen}
      rows={rows}
      members={members}
      onJump={onJump}
    />
  );
}
