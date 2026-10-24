// The Details card's Memory section: what this session wrote to memory.
//
// No section at all when the session remembered nothing, which is most
// sessions: a heading over nothing is noise.

import { Brain } from "lucide-react";

import { useChatStore } from "@/features/chat/stores/chat-store";
import { KIND_ICON, kindLabel } from "@/features/memory/lib/memory-kind-icon";
import { openMemoryEntry } from "@/features/memory/lib/open-memory-entry";
import { useSessionMemoryWrites } from "@/features/memory/lib/use-session-memory-writes";
import { cn } from "@/lib/utils";

import { ContextSection } from "./context-rows";

export function MemorySection({
  tabId,
  projectPath,
}: {
  tabId: string;
  projectPath: string | null;
}) {
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId ?? null);
  const { writes } = useSessionMemoryWrites(projectPath, acpSessionId);
  if (writes.length === 0) return null;
  return (
    <ContextSection title="Memory" collapse={{ id: "memory", badge: `${writes.length}` }}>
      <ul className="m-0 hide-scrollbar max-h-64 list-none overflow-y-auto overscroll-contain p-0">
        {writes.map((write) => {
          const Icon = KIND_ICON[write.kind] ?? Brain;
          return (
            <li
              key={write.id}
              // Opens the entry in Memory. A forgotten or archived one has
              // nothing to open, so it stays plain text.
              role={write.live ? "button" : undefined}
              tabIndex={write.live ? 0 : undefined}
              onClick={write.live ? () => openMemoryEntry(write.id) : undefined}
              onKeyDown={
                write.live
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openMemoryEntry(write.id);
                      }
                    }
                  : undefined
              }
              className={cn(
                "flex h-7 items-center gap-2.5 rounded-lg px-2.5 text-xs text-secondary-foreground",
                write.live
                  ? "cursor-pointer outline-none transition-colors hover:bg-element-hover focus-visible:bg-element-hover"
                  : "opacity-60",
              )}
              title={`${kindLabel(write.kind)}: ${write.content}`}
            >
              {/* The kind's glyph, as under the turn that wrote it. */}
              <Icon
                size={12}
                strokeWidth={1.5}
                className="shrink-0 text-muted-foreground"
                aria-label={kindLabel(write.kind)}
              />
              <span className={cn("min-w-0 flex-1 truncate", !write.live && "line-through")}>
                {write.content || "(forgotten)"}
              </span>
            </li>
          );
        })}
      </ul>
    </ContextSection>
  );
}
