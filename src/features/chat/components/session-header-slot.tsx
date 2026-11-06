// The empty box a column header leaves for its session's controls. The chat
// panel fills it through a portal (`session-header-slot-store.ts`).

import { useLayoutEffect, useRef } from "react";

import { useSessionHeaderSlotStore } from "../stores/session-header-slot-store";

export function SessionHeaderSlot({ tabId }: { tabId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { register, unregister } = useSessionHeaderSlotStore.getState();
    register(tabId, el);
    return () => unregister(tabId, el);
  }, [tabId]);
  // `contents`: the controls sit in the header's own row, spaced by its gap,
  // as if they were written there.
  return <div ref={ref} data-session-header-slot={tabId} className="contents" />;
}
