import { memo, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2, XCircle, AlertTriangle, ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store";
import { agents } from "../lib/agents-api";
import { cn } from "@/lib/utils";
import { Kbd } from "@/ui/kbd";
import { Markdown } from "@/lib/markdown";
import { extractPlanMarkdown } from "../lib/plans";
import { extractQuestions } from "../lib/questions";
import { ApprovalCard } from "./approval-card";
import type { PermissionOptionRef, PendingPermission } from "@/types/acp";
import { type AgentType } from "@/types/agent";
import { agentMeta } from "@/features/agents/lib/agent-meta";

function isAllow(kind: string) {
  return kind === "allow_once" || kind === "allow_always";
}
function isReject(kind: string) {
  return kind === "reject_once" || kind === "reject_always";
}

// Some agents bake their own brand into permission-option labels (e.g.
// codex-acp emits "No, and tell Codex what to do differently"). Rewrite any
// OTHER agent's brand to the agent actually bound to this session so the card
// never names the wrong agent. Ordered longest-first to avoid partial matches.
const AGENT_BRANDS = ["Claude Code", "Codex", "Claude", "OpenCode", "Cursor"];
function relabelAgentBrand(label: string, agentType: AgentType): string {
  // `agentMeta`, not a raw AGENT_LABEL read: that table only covers first-party
  // agents, so every external one rendered as the anonymous "the agent".
  const display = agentMeta(agentType).label;
  let out = label;
  for (const brand of AGENT_BRANDS) {
    if (brand === display) continue;
    out = out.replace(new RegExp(`\\b${brand}\\b`, "g"), display);
  }
  return out;
}

interface PermissionModalProps {
  tabId: string;
  /** Send a fresh message to the agent (used by the "tell the agent what to do
   *  instead" field, which cancels the request then sends the text). */
  onSendMessage?: (text: string) => void;
}

/**
 * Renders the head of the pending-permission queue for whichever ACP session
 * is bound to this tab. The standard case is an inline card (numbered options,
 * keyboard-selectable, with a free-text fallback) pinned above the composer,
 * à la Claude Code / VSCode. Plan reviews keep the richer two-panel modal.
 * Cancelled requests (ESC / click outside) resolve as `cancelled` on the wire
 * so the agent backs off correctly.
 */
// memo: ChatPanel re-renders per streaming rAF flush; tabId + the stable
// onSendMessage wrapper never change identity, so the permission card's own
// narrow store subscriptions decide when it actually re-renders.
export const PermissionModal = memo(PermissionModalImpl);

function PermissionModalImpl({ tabId, onSendMessage }: PermissionModalProps) {
  // Narrow subscription: only this tab's acpSessionId and the head of its
  // permission queue, so the card stays idle until a request actually arrives.
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  const current = useChatStore((s) =>
    acpSessionId ? s.pendingPermissions[acpSessionId]?.[0] : undefined,
  );
  const queueLength = useChatStore((s) =>
    acpSessionId ? (s.pendingPermissions[acpSessionId]?.length ?? 0) : 0,
  );
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "cersei");
  const popPermission = useChatStore.use.actions().popPermission;

  const [draft, setDraft] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Reset the free-text field whenever the active request changes.
  const reqId = current?.requestId;
  useEffect(() => {
    setDraft("");
  }, [reqId]);

  const primaryId = current?.options.find((o) => isAllow(o.kind))?.optionId;

  // Keyboard: digits 1–9 select, Enter = primary, Esc = cancel — except while
  // the free-text field is focused (there Enter submits text, Esc still cancels).
  useEffect(() => {
    if (!current) return;
    const send = (decision: Parameters<typeof agents.respondPermission>[3]) => {
      agents
        .respondPermission(current.agentId, current.acpSessionId, current.requestId, decision)
        .catch((e) => toast.error(`Permission send failed: ${e}`))
        .finally(() => popPermission(current.acpSessionId, current.requestId));
    };
    const onKey = (e: KeyboardEvent) => {
      const inText = document.activeElement === textRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        send({ kind: "cancelled" });
        return;
      }
      // AskUserQuestion answers are picked by click (the card's button order
      // can differ from the raw ACP option order), so don't let digits/Enter
      // resolve a possibly-mismatched option here.
      if (extractQuestions(current.toolCall)) return;
      if (inText) return; // let the field handle digits / Enter
      if (e.key === "Enter") {
        if (primaryId) {
          e.preventDefault();
          send({ kind: "selected", option_id: primaryId });
        }
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= current.options.length) {
        e.preventDefault();
        send({ kind: "selected", option_id: current.options[n - 1].optionId });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current, primaryId, popPermission]);

  if (!current) return null;

  const resolve = (optId: string) => {
    agents
      .respondPermission(current.agentId, current.acpSessionId, current.requestId, {
        kind: "selected",
        option_id: optId,
      })
      .catch((e) => toast.error(`Permission send failed: ${e}`))
      .finally(() => popPermission(current.acpSessionId, current.requestId));
  };

  const cancel = () => {
    agents
      .respondPermission(current.agentId, current.acpSessionId, current.requestId, {
        kind: "cancelled",
      })
      .catch((e) => toast.error(`Permission cancel failed: ${e}`))
      .finally(() => popPermission(current.acpSessionId, current.requestId));
  };

  // Free-text: cancel the request, then send the typed instruction as a new
  // message (ACP has no text-response path for a permission).
  const submitText = () => {
    const text = draft.trim();
    if (!text) return;
    cancel();
    onSendMessage?.(text);
  };

  const title = current.toolCall.title ?? current.toolCall.kind ?? "Tool call";
  const planMarkdown = extractPlanMarkdown(current.toolCall);
  const questions = extractQuestions(current.toolCall);
  const queueNote = queueLength > 1 ? `${queueLength - 1} more pending after this` : null;

  // Numbered option list — shared by both layouts.
  const optionList = (
    <div className="flex flex-col gap-1">
      {current.options.map((opt, i) => (
        <PermissionOption
          key={opt.optionId}
          index={i + 1}
          option={opt}
          agentType={agentType}
          isPrimary={opt.optionId === primaryId}
          onSelect={() => resolve(opt.optionId)}
        />
      ))}
    </div>
  );

  // Plan review keeps the richer two-panel modal (with number-key support from
  // the keyboard effect above).
  if (planMarkdown) {
    return (
      <Dialog.Root open onOpenChange={(open) => !open && cancel()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content
            className={cn(
              // Anchor near the top (not vertically centered) with a viewport
              // cap, so a long plan never pushes the modal — and its Cancel
              // footer — below the window. The plan panel scrolls internally.
              "fixed left-1/2 top-[5vh] z-50 -translate-x-1/2",
              "flex max-h-[90vh] w-[880px] max-w-[94vw] flex-col overflow-hidden",
              "rounded-md border border-border-default bg-bg-elevated",
              "shadow-[var(--shadow-overlay)] animate-scale-in text-text-primary",
            )}
          >
            <div className="flex items-start gap-3 border-b border-border-default px-4 py-3">
              <ClipboardList className="mt-0.5 size-4 text-accent" />
              <div className="flex-1">
                <Dialog.Title className="text-sm font-medium">Review plan</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-text-secondary">
                  The agent proposed a plan before continuing. Review it, then approve or reject.
                </Dialog.Description>
              </div>
              {queueNote && (
                <span className="shrink-0 rounded-sm bg-bg-base px-2 py-0.5 text-[11px] text-text-secondary">
                  {queueNote}
                </span>
              )}
            </div>
            <div className="flex min-h-0 flex-1">
              <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="min-h-0 min-w-0 flex-1 overflow-auto px-5 py-4">
                  <Markdown>{planMarkdown}</Markdown>
                </div>
              </section>
              <aside className="flex w-[320px] shrink-0 flex-col border-l border-border-default">
                <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-3">{optionList}</div>
                <div className="flex items-center justify-end gap-2 border-t border-border-default px-4 py-2.5">
                  <button
                    type="button"
                    onClick={cancel}
                    className="inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-base hover:text-text-primary transition-colors"
                  >
                    Cancel <Kbd>esc</Kbd>
                  </button>
                </div>
              </aside>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  // AskUserQuestion — the stepper card (one question per step, radio /
  // checkbox options, free text, progress dots). All questions are answered,
  // not just the first. Submit either resolves a matching ACP option (single
  // single-select answer) or cancels the request and sends the composed
  // answers as a user message — see the card's own header for the contract.
  // Esc still backs out via this modal's keyboard handler.
  if (questions) {
    return (
      <div className="px-4 pt-2">
        <ApprovalCard
          key={current.requestId}
          questions={questions}
          acpOptions={current.options}
          queueNote={queueNote}
          onResolveOption={resolve}
          onAnswerText={(text) => {
            cancel();
            onSendMessage?.(text);
          }}
        />
      </div>
    );
  }

  // Standard case — inline card above the composer.
  return (
    <div className="px-4 pt-2">
      <div className="mx-auto w-full max-w-[720px] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
        <div className="flex items-start gap-2 px-3 pt-3">
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium leading-snug text-text-primary">
              The agent wants to run <span className="font-mono text-text-primary">{title}</span>?
            </div>
            {queueNote && <div className="mt-0.5 text-[11px] text-text-secondary">{queueNote}</div>}
          </div>
        </div>

        <ToolCallPreview tc={current.toolCall} />

        <div className="px-3 py-2.5">{optionList}</div>

        <div className="border-t border-border-default px-3 py-2.5">
          <textarea
            ref={textRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitText();
              }
            }}
            rows={1}
            placeholder="Tell the agent what to do instead…"
            className="w-full resize-none rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-[12px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[var(--border-focus)]"
          />
        </div>
      </div>
    </div>
  );
}

function PermissionOption({
  index,
  option,
  agentType,
  isPrimary,
  onSelect,
}: {
  index: number;
  option: PermissionOptionRef;
  agentType: AgentType;
  isPrimary?: boolean;
  onSelect: () => void;
}) {
  const allow = isAllow(option.kind);
  const reject = isReject(option.kind);
  const Icon = allow ? CheckCircle2 : reject ? XCircle : AlertTriangle;
  const label = relabelAgentBrand(option.name, agentType);

  const tone = isPrimary
    ? "border-transparent bg-[var(--accent-primary)] text-[var(--bg-base)] hover:bg-[var(--accent-primary-hover)]"
    : reject
      ? "border-border-default bg-bg-base text-[var(--status-error)] hover:bg-[var(--status-error-muted)]"
      : "border-border-default bg-bg-base text-text-primary hover:bg-bg-hover";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-md border px-2.5 py-2 text-left text-[12px] transition-colors outline-none",
        tone,
      )}
    >
      {index > 0 && (
        <span
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold",
            isPrimary
              ? "bg-[var(--bg-base)]/15 text-[var(--bg-base)]"
              : "bg-bg-elevated text-text-secondary",
          )}
        >
          {index}
        </span>
      )}
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 font-medium break-words">{label}</span>
      {isPrimary && (
        <Kbd className="border-[var(--bg-base)]/20 bg-[var(--bg-base)]/10 text-[var(--bg-base)]">
          ↵
        </Kbd>
      )}
    </button>
  );
}

function ToolCallPreview({ tc }: { tc: PendingPermission["toolCall"] }) {
  const inputValue =
    (tc as Record<string, unknown>).rawInput ?? (tc as Record<string, unknown>).input;
  const formatted = inputValue !== undefined ? safeStringify(inputValue, 2) : null;
  if (!formatted) return null;
  return (
    <div className="mx-3 mt-2 rounded-md border border-border-default bg-bg-base px-3 py-2">
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-snug text-text-secondary">
        {formatted}
      </pre>
    </div>
  );
}

function safeStringify(v: unknown, indent: number): string {
  try {
    const s = JSON.stringify(v, null, indent);
    return s.length > 4000 ? s.slice(0, 4000) + "\n…(truncated)" : s;
  } catch {
    return String(v);
  }
}
