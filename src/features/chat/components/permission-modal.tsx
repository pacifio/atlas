import { memo, useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { DialogOverlay } from "@/ui/dialog";
import { CheckCircle2, XCircle, AlertTriangle, ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store";
import { agents } from "../lib/agents-api";
import { cn } from "@/lib/utils";
import { Kbd } from "@/ui/kbd";
import { Markdown } from "@/lib/markdown";
import { extractPlanMarkdown } from "../lib/plans";
import { exitPlanOffersBypass } from "../lib/exit-plan-modes";
import { composeAnswers, extractQuestions } from "../lib/questions";
import { ApprovalCard, type Answer } from "./approval-card";
import type { PermissionOptionRef, PendingPermission } from "@/types/acp";
import { type AgentType } from "@/types/agent";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import {
  outwardApprovalOf,
  type OutwardApproval,
} from "@/features/org-actions/lib/outward-approval";

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
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "atlas-agent");
  const { popPermission, applyExitPlanSelection } = useChatStore.use.actions();

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
        .then(() => {
          // A plan approval picks a mode the adapter applies silently — see
          // `exit-plan-modes.ts`. Mirror it, or the pill lies from here on.
          if (decision.kind === "selected" && extractPlanMarkdown(current.toolCall)) {
            applyExitPlanSelection(tabId, decision.option_id);
          }
        })
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
  }, [current, primaryId, popPermission, applyExitPlanSelection, tabId]);

  if (!current) return null;

  /** Answer with an option; for a plan approval also adopt the mode it
   *  selects (`override` = the mode Atlas's own "approve and bypass" action
   *  applies on top of the plain approval). */
  const resolve = (optId: string, override?: "bypassPermissions") => {
    const isPlan = !!extractPlanMarkdown(current.toolCall);
    agents
      .respondPermission(current.agentId, current.acpSessionId, current.requestId, {
        kind: "selected",
        option_id: optId,
      })
      .then(() => {
        if (isPlan) applyExitPlanSelection(tabId, optId, override);
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

  // Answers → the permission wire. A single single-select answer that names a
  // real ACP option resolves it properly, so the tool call completes with an
  // answer. Anything else (several questions, multiSelect, typed text, or the
  // adapter only offering generic allow/reject) cancels the request and sends
  // the composed answers as a message — the agent reads them from there.
  const submitQuestionAnswers = (answers: Answer[]) => {
    const specs = questions ?? [];
    if (specs.length === 1 && !specs[0].multiSelect) {
      const a = answers[0];
      if (a && !a.custom.trim() && a.selected.length === 1) {
        const want = a.selected[0].trim().toLowerCase();
        const match = current.options.find((o) => o.name.trim().toLowerCase() === want);
        if (match) {
          resolve(match.optionId);
          return;
        }
      }
    }
    const text = composeAnswers(specs, answers);
    if (!text) return;
    cancel();
    onSendMessage?.(text);
  };

  const title = current.toolCall.title ?? current.toolCall.kind ?? "Tool call";
  const planMarkdown = extractPlanMarkdown(current.toolCall);
  const questions = extractQuestions(current.toolCall);
  const outward = outwardApprovalOf(current.toolCall);
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
  //
  // The Claude adapter offers ONE elevated approval, and on a model that
  // supports auto mode that is "use auto mode" — which still prompts for risky
  // tools — with no bypass choice at all. Bypass is still in the session's
  // advertised modes, only the prompt omits it, so Atlas adds the action back:
  // approve plainly, then push `bypassPermissions`.
  const bypassOptionId =
    agentType === "claude-code" &&
    planMarkdown &&
    !exitPlanOffersBypass(current.options.map((o) => o.optionId))
      ? (current.options.find((o) => o.optionId === "exit-plan-default")?.optionId ??
        current.options.find((o) => isAllow(o.kind))?.optionId ??
        null)
      : null;
  if (planMarkdown) {
    return (
      <Dialog.Root open onOpenChange={(open) => !open && cancel()}>
        <Dialog.Portal>
          <DialogOverlay className="backdrop-blur-sm" />
          <Dialog.Popup
            className={cn(
              // Anchor near the top (not vertically centered) with a viewport
              // cap, so a long plan never pushes the modal — and its Cancel
              // footer — below the window. The plan panel scrolls internally.
              "fixed left-1/2 top-[5vh] z-modal -translate-x-1/2",
              "flex max-h-[90vh] w-[880px] max-w-[94vw] flex-col overflow-hidden",
              "rounded-md border border-border bg-card",
              "shadow-md animate-scale-in text-foreground",
            )}
          >
            <div className="flex items-start gap-3 border-b border-border px-4 py-3">
              <ClipboardList className="mt-0.5 size-4 text-primary" />
              <div className="flex-1">
                <Dialog.Title className="text-sm font-medium">Review plan</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-secondary-foreground">
                  The agent proposed a plan before continuing. Review it, then approve or reject.
                </Dialog.Description>
              </div>
              {queueNote && (
                <span className="shrink-0 rounded-sm bg-background px-2 py-0.5 text-xs text-secondary-foreground">
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
              <aside className="flex w-[320px] shrink-0 flex-col border-l border-border">
                <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-3">
                  {optionList}
                  {bypassOptionId && (
                    <button
                      type="button"
                      onClick={() => resolve(bypassOptionId, "bypassPermissions")}
                      className={cn(
                        "mt-2 flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-2 text-left",
                        "text-sm text-foreground transition-colors hover:bg-background",
                      )}
                    >
                      <AlertTriangle className="size-3.5 shrink-0 text-[var(--atlas-status-error-foreground)]" />
                      <span className="flex-1">
                        Yes, and bypass permissions
                        <span className="block text-xs text-secondary-foreground">
                          Approve the plan and stop asking for the rest of this session.
                        </span>
                      </span>
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
                  <button
                    type="button"
                    onClick={cancel}
                    className="inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs text-secondary-foreground hover:bg-background hover:text-foreground transition-colors"
                  >
                    Cancel <Kbd>esc</Kbd>
                  </button>
                </div>
              </aside>
            </div>
          </Dialog.Popup>
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
          queueNote={queueNote}
          onSubmit={submitQuestionAnswers}
        />
      </div>
    );
  }

  // Standard case — inline card above the composer.
  return (
    <div className="px-4 pt-2">
      <div
        // A card resting in the composer stack, not a menu: `shadow-md` is the
        // menu elevation (0 16px 48px at 90%) and read as a black slab over the
        // transcript. This sits between `shadow-sm` and that, with no step to name.
        // ratchet-allow: an in-flow raised card, softer than the menu elevation
        className="mx-auto w-full max-w-[720px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-start gap-2 px-3 pt-3">
          <div className="flex-1 min-w-0">
            {outward ? (
              <OutwardActionHeading approval={outward} />
            ) : (
              <div className="text-base font-medium leading-snug text-foreground">
                The agent wants to run <span className="font-mono text-foreground">{title}</span>?
              </div>
            )}
            {queueNote && (
              <div className="mt-0.5 text-xs text-secondary-foreground">{queueNote}</div>
            )}
          </div>
        </div>

        {outward ? (
          <OutwardActionBody approval={outward} />
        ) : (
          <ToolCallPreview tc={current.toolCall} />
        )}

        <div className="px-3 py-2.5">{optionList}</div>

        <div className="border-t border-border px-3 py-2.5">
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
            className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-[var(--atlas-border-strong)]"
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
    ? "border-transparent bg-[var(--primary)] text-[var(--background)] hover:bg-[var(--atlas-primary-hover)]"
    : reject
      ? "border-border bg-background text-[var(--atlas-status-error-foreground)] hover:bg-[var(--atlas-status-error-background)]"
      : "border-border bg-background text-foreground hover:bg-element-hover";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-md border px-2.5 py-2 text-left text-sm transition-colors outline-none",
        tone,
      )}
    >
      {index > 0 && (
        <span
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded text-2xs font-semibold",
            isPrimary
              ? "bg-[var(--background)]/15 text-[var(--background)]"
              : "bg-card text-secondary-foreground",
          )}
        >
          {index}
        </span>
      )}
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 font-medium break-words">{label}</span>
      {isPrimary && (
        <Kbd className="border-[var(--background)]/20 bg-[var(--background)]/10 text-[var(--background)]">
          ↵
        </Kbd>
      )}
    </button>
  );
}

/**
 * An outward action's headline (ADR-0014): the act and whom it reaches, then
 * the recipient in full — in place of "The agent wants to run …?", which
 * reads wrongly for a message.
 */
export function OutwardActionHeading({ approval }: { approval: OutwardApproval }) {
  return (
    <>
      <div className="text-base font-medium leading-snug text-foreground">{approval.title}</div>
      <div className="mt-0.5 text-xs text-secondary-foreground">{approval.recipient}</div>
    </>
  );
}

/**
 * The exact words an outward action will post, in the tool-call preview's
 * box: the whole body, never truncated, scrolling inside the card when long.
 */
export function OutwardActionBody({ approval }: { approval: OutwardApproval }) {
  return (
    <div className="mx-3 mt-2 rounded-md border border-border bg-background px-3 py-2">
      <div
        data-testid="outward-body"
        className="max-h-64 overflow-auto whitespace-pre-wrap text-sm leading-snug text-foreground"
      >
        {approval.body}
      </div>
    </div>
  );
}

function ToolCallPreview({ tc }: { tc: PendingPermission["toolCall"] }) {
  const inputValue =
    (tc as Record<string, unknown>).rawInput ?? (tc as Record<string, unknown>).input;
  const formatted = inputValue !== undefined ? safeStringify(inputValue, 2) : null;
  if (!formatted) return null;
  return (
    <div className="mx-3 mt-2 rounded-md border border-border bg-background px-3 py-2">
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs leading-snug text-secondary-foreground">
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
