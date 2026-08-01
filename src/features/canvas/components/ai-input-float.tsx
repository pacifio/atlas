import { useEffect, useRef, useState } from "react";
import { ArrowUp, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "../stores/canvas-store";
import { useCanvasAiStore } from "../stores/canvas-ai-store";
import { ProviderModelPills } from "@/features/chat/components/provider-model-pills";

/**
 * Figma-comment-style floating AI composer, anchored at a clicked canvas point
 * (ref `1.png`). Submitting creates a new AI group at that flow position and kicks
 * off generation; the group's ✨ pin + thread then take over.
 */
export function AiInputFloat({
  screen,
  flow,
  projectPath,
  onClose,
}: {
  screen: { x: number; y: number };
  flow: { x: number; y: number };
  projectPath: string;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const { createAiGroup } = useCanvasStore.use.actions();
  const { generate } = useCanvasAiStore.use.actions();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    const prompt = text.trim();
    if (!prompt || !provider || !model) return;
    const groupId = createAiGroup(flow, provider, model);
    void generate({
      groupId,
      anchor: flow,
      prompt,
      provider,
      model,
      projectPath,
    });
    onClose();
  };

  return (
    <div
      className="absolute z-30 flex items-start gap-2"
      style={{ left: screen.x, top: screen.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* ✨ anchor pin (teardrop) */}
      <div className="mt-1 flex h-7 w-7 items-center justify-center rounded-full rounded-bl-none bg-[var(--accent-primary)] text-[var(--bg-base)] shadow-lg shrink-0">
        <Sparkles size={14} />
      </div>

      <div className="w-[360px] rounded-xl border border-border-default bg-[var(--bg-elevated)]/90 backdrop-blur-2xl shadow-[var(--shadow-overlay)]">
        <textarea
          ref={ref}
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
          placeholder="Ask AI to draw… e.g. “architecture diagram of this codebase”"
          className="w-full resize-none bg-transparent px-3 pt-2.5 text-[12px] leading-relaxed text-text-primary placeholder:text-text-tertiary outline-none"
        />
        <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-2 py-1.5">
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
            disabled={!text.trim() || !provider || !model}
            title="Generate"
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full transition-colors",
              text.trim() && provider && model
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
