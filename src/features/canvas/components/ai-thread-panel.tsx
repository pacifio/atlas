import { useEffect, useRef, useState } from "react";
import { X, Trash2, ArrowUp, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "../stores/canvas-store";
import { useCanvasAiStore } from "../stores/canvas-ai-store";
import { ProviderModelPills } from "@/features/chat/components/provider-model-pills";

const PANEL_W = 340;

/**
 * Figma-comment-style thread popover for an AI group (ref `2.png`). Shows the
 * conversation that produced the diagram and a reply composer to keep modifying
 * the same group. Anchored (fixed) near the clicked ✨ pin.
 */
export function AiThreadPanel({
  groupId,
  at,
  projectPath,
  onClose,
}: {
  groupId: string;
  at: { x: number; y: number };
  projectPath: string;
  onClose: () => void;
}) {
  const group = useCanvasStore.use.aiGroups()[groupId];
  const { deleteGroup } = useCanvasStore.use.actions();
  const { generate } = useCanvasAiStore.use.actions();
  const streamingGroupId = useCanvasAiStore.use.streamingGroupId();
  const generating = streamingGroupId === groupId;

  const [text, setText] = useState("");
  const [provider, setProvider] = useState(group?.provider ?? "");
  const [model, setModel] = useState(group?.model ?? "");
  const listRef = useRef<HTMLDivElement>(null);

  // Group deleted out from under us → close.
  useEffect(() => {
    if (!group) onClose();
  }, [group, onClose]);

  // Keep scrolled to the latest message.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [group?.messages.length, generating]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!group) return null;

  // Clamp within the viewport.
  const left = Math.min(at.x, window.innerWidth - PANEL_W - 12);
  const top = Math.min(at.y, window.innerHeight - 420);

  const submit = () => {
    const prompt = text.trim();
    if (!prompt || !provider || !model || generating) return;
    setText("");
    void generate({
      groupId,
      anchor: group.anchor,
      prompt,
      provider,
      model,
      projectPath,
    });
  };

  return (
    <div
      className="fixed z-[9999] flex flex-col rounded-xl border border-border-default bg-[var(--bg-elevated)]/90 backdrop-blur-2xl shadow-[var(--shadow-overlay)]"
      style={{
        left: Math.max(12, left),
        top: Math.max(12, top),
        width: PANEL_W,
        maxHeight: 420,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 h-[34px] shrink-0">
        <Sparkles size={12} className="text-[var(--accent-primary)]" />
        <span className="flex-1 text-[11px] font-semibold text-text-primary">
          AI diagram
        </span>
        <button
          type="button"
          title="Delete diagram"
          onClick={() => {
            deleteGroup(groupId);
            onClose();
          }}
          className="p-1 rounded hover:bg-white/10 text-text-tertiary hover:text-[var(--status-error)] cursor-pointer transition-colors"
        >
          <Trash2 size={12} />
        </button>
        <button
          type="button"
          title="Close"
          onClick={onClose}
          className="p-1 rounded hover:bg-white/10 text-text-tertiary hover:text-text-primary cursor-pointer transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto hide-scrollbar px-3 py-2 space-y-2"
      >
        {group.messages.length === 0 && (
          <div className="text-[11px] text-text-tertiary italic">
            No messages yet.
          </div>
        )}
        {group.messages.map((m, i) => (
          <div
            key={i}
            className={cn(
              "text-[11px] leading-relaxed",
              m.role === "user" ? "text-text-primary" : "text-text-secondary",
            )}
          >
            <span className="text-[9px] uppercase tracking-wide text-text-tertiary mr-1.5">
              {m.role === "user" ? "You" : "AI"}
            </span>
            {m.content}
          </div>
        ))}
        {generating && (
          <div className="text-[11px] text-text-tertiary italic">
            Generating…
          </div>
        )}
      </div>

      {/* Reply composer */}
      <div className="shrink-0 border-t border-white/10 p-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          rows={2}
          placeholder="Modify this diagram…"
          className="w-full resize-none bg-transparent px-1 text-[12px] leading-relaxed text-text-primary placeholder:text-text-tertiary outline-none"
        />
        <div className="flex items-center justify-between gap-2 pt-1">
          <ProviderModelPills
            provider={provider}
            model={model}
            onProvider={setProvider}
            onModel={setModel}
            showCompress={false}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || !provider || !model || generating}
            title="Send"
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full transition-colors",
              text.trim() && provider && model && !generating
                ? "bg-[var(--accent-primary)] text-[var(--bg-base)] hover:opacity-90 cursor-pointer"
                : "bg-bg-hover text-text-tertiary cursor-not-allowed",
            )}
          >
            <ArrowUp size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
