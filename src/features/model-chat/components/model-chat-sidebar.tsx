import { useMemo, useState } from "react";
import { Plus, Search, Trash2, PanelLeft, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { ProviderLogo, hasProviderLogo } from "@/components/provider-logo";
import { AtlasLoader } from "@/components/atlas-loader";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useModelChatStore } from "../stores/model-chat-store";

export function ModelChatSidebar({ onNew }: { onNew: () => void }) {
  const sidebar = useLayoutStore.use.modelChatSidebar();
  const { toggleModelChatSidebar } = useLayoutStore.use.actions();
  const metas = useModelChatStore.use.metas();
  const streaming = useModelChatStore.use.streaming();
  const activeId = useModelChatStore.use.activeId();
  const { selectSession, deleteSession } = useModelChatStore.use.actions();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return metas;
    return metas.filter((m) => m.title.toLowerCase().includes(q));
  }, [metas, query]);

  if (!sidebar.visible) return null;

  return (
    <div
      style={{ width: sidebar.width }}
      className="flex h-full shrink-0 flex-col border-r border-border-default bg-bg-sidebar"
    >
      {/* Search — full-width borderless row, matching the agent chat sidebar. */}
      <div className="flex items-center gap-1.5 h-[32px] shrink-0 border-b border-border-default bg-bg-primary px-3">
        <Search size={11} className="text-text-tertiary shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          spellCheck={false}
          className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary min-w-0"
        />
      </div>

      {/* History list */}
      <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar">
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-text-tertiary">
            {metas.length === 0 ? "No chats yet" : "No matches"}
          </div>
        ) : (
          filtered.map((m, idx) => {
            const active = m.id === activeId;
            const isLast = idx === filtered.length - 1;
            return (
              <div
                key={m.id}
                role="button"
                tabIndex={0}
                onClick={() => void selectSession(m.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void selectSession(m.id);
                }}
                className={cn(
                  "group relative w-full text-left px-3 py-3 transition-colors flex flex-col gap-1 cursor-pointer select-none",
                  active
                    ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] opacity-80 hover:opacity-100 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                  !isLast && "border-b border-[var(--border-default)]",
                )}
              >
                <div className="flex items-start gap-1.5">
                  <span className="shrink-0 inline-flex h-[15px] items-center justify-center">
                    {streaming[m.id] ? (
                      <AtlasLoader size={8} className="text-[var(--accent-primary)]" />
                    ) : m.provider && hasProviderLogo(m.provider) ? (
                      <ProviderLogo id={m.provider} size={13} />
                    ) : (
                      <MessageSquare size={11} className="text-text-tertiary" />
                    )}
                  </span>
                  <span className="text-[11px] leading-snug line-clamp-2 flex-1">{m.title}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteSession(m.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 -mt-0.5 rounded text-text-muted hover:text-[var(--danger,#e5484d)] transition-opacity"
                    title="Delete chat"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="pl-[20px]">
                  <span className="text-[9px] text-text-tertiary">
                    {timeAgo(m.updatedAt, { suffix: true })}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer: hide + new chat */}
      <div className="flex items-center justify-between px-1.5 h-[29px] border-t border-border-default bg-bg-sidebar">
        <button
          onClick={toggleModelChatSidebar}
          className="flex items-center justify-center w-6 h-6 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title="Hide sidebar (⌘⌥K)"
        >
          <PanelLeft size={12} />
        </button>
        <button
          onClick={onNew}
          className="flex items-center justify-center w-6 h-6 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title="New chat"
        >
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}
