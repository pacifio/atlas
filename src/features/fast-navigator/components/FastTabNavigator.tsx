import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { cn } from "@/lib/utils";

// Ctrl+Tab, not Cmd+Tab — Cmd+Tab is the OS-level app switcher on macOS and
// can't be intercepted from a webview. VS Code makes the same choice on Mac.
const MODIFIER_KEY = "Control";

export function FastTabNavigator() {
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const snapshotRef = useRef<string[]>([]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();

      const s = useLayoutStore.getState();

      if (!open) {
        const focusedIds = new Set(
          s.tabs
            .filter((t) => (t.groupId ?? "main") === s.focusedGroupId)
            .map((t) => t.id),
        );
        // tabMru is global; filter to the focused column and drop any stale
        // ids (defensive — closeTab already prunes, this just guards drift).
        const snapshot = s.tabMru.filter((id) => focusedIds.has(id));
        if (snapshot.length < 2) return; // nothing to cycle to

        snapshotRef.current = snapshot;
        setSelectedIndex(1 % snapshot.length); // skip current (index 0)
        setOpen(true);
      } else {
        setSelectedIndex((i) => {
          const len = snapshotRef.current.length;
          const delta = e.shiftKey ? -1 : 1;
          return (i + delta + len) % len;
        });
      }
    }

    function commitAndClose() {
      const targetId = snapshotRef.current[selectedIndex];
      if (targetId) {
        useLayoutStore.getState().actions.setActiveTab(targetId);
      }
      setOpen(false);
      setSelectedIndex(0);
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.key !== MODIFIER_KEY || !open) return;
      commitAndClose();
    }

    // Safety net: if the window loses focus while cycling (e.g. an OS-level
    // Alt+Tab steals the keyup, or a DE swallows it), don't leave the
    // overlay stuck open with no way to dismiss it.
    function handleBlur() {
      if (open) commitAndClose();
    }

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [open, selectedIndex]);

  if (!open) return null;

  const tabsById = new Map(useLayoutStore.getState().tabs.map((t) => [t.id, t]));

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[20vh] pointer-events-none">
      <div className="pointer-events-auto min-w-[360px] max-w-[520px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)] py-1.5">
        {snapshotRef.current.map((id, i) => {
          const tab = tabsById.get(id);
          if (!tab) return null;
          return (
            <div
              key={id}
              className={cn(
                "flex items-center gap-2 px-3 h-[30px] text-[12px] truncate",
                i === selectedIndex
                  ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)]",
              )}
            >
              {tab.title}
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}