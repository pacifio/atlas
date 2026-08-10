import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Search, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd, KbdGroup } from "@/ui/kbd";
import type { ChatMessage } from "@/types/agent";

interface ChatSearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: ChatMessage[];
  onJump: (originalIndex: number) => void;
}

export function ChatSearchPalette({
  open,
  onOpenChange,
  messages,
  onJump,
}: ChatSearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only user messages, with their original indices.
  const userMessages = useMemo(
    () => messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role === "user"),
    [messages],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return userMessages;
    return userMessages.filter(({ m }) => m.content.toLowerCase().includes(q));
  }, [userMessages, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && filtered[selected]) {
      e.preventDefault();
      onJump(filtered[selected].i);
      onOpenChange(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[var(--z-overlay)]" />
        <Dialog.Content
          className={cn(
            "fixed top-[20%] left-1/2 -translate-x-1/2 z-[var(--z-modal)]",
            "w-[560px] max-h-[440px] rounded-xl overflow-hidden",
            "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
            "shadow-[var(--shadow-overlay)]",
            "flex flex-col",
          )}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Find user message</Dialog.Title>
          <div className="flex items-center gap-2 px-4 h-[44px] border-b border-[var(--border-default)] shrink-0">
            <Search size={14} className="text-[var(--text-tertiary)] shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Find a question you asked…"
              className="flex-1 bg-transparent outline-none text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
            />
            <span className="text-[10px] text-[var(--text-tertiary)] font-mono">
              {filtered.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto hide-scrollbar py-1">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-[11px] text-[var(--text-tertiary)]">
                {userMessages.length === 0 ? "No user messages yet." : "No matches."}
              </div>
            ) : (
              filtered.slice(0, 200).map(({ m, i }, idx) => {
                const active = idx === selected;
                const preview = m.content.replace(/\s+/g, " ").slice(0, 160);
                const ts = new Date(m.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
                return (
                  <button
                    key={m.id}
                    onMouseEnter={() => setSelected(idx)}
                    onClick={() => {
                      onJump(i);
                      onOpenChange(false);
                    }}
                    className={cn(
                      "w-full flex items-start gap-3 px-4 py-2 text-left cursor-pointer",
                      active ? "bg-[var(--bg-selected)]" : "hover:bg-[var(--bg-hover)]",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 bg-[var(--accent-primary-muted)]",
                      )}
                    >
                      <User size={10} className="text-[var(--accent-primary)]" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
                          You
                        </span>
                        <span className="text-[10px] font-mono text-[var(--text-tertiary)]">
                          {ts}
                        </span>
                      </div>
                      <div className="text-[12px] text-[var(--text-primary)] truncate mt-0.5">
                        {preview}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <div className="flex items-center gap-3 px-4 h-[28px] border-t border-[var(--border-default)] text-[10px] text-[var(--text-tertiary)] shrink-0">
            <KbdGroup>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span>navigate</span>
            </KbdGroup>
            <KbdGroup>
              <Kbd>↵</Kbd>
              <span>jump</span>
            </KbdGroup>
            <KbdGroup className="ml-auto">
              <Kbd>esc</Kbd>
              <span>close</span>
            </KbdGroup>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
