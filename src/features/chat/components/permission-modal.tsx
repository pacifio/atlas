// The container for every permission prompt a session raises: it reads the
// head of the session's permission queue, answers on the wire, and picks one
// of three props-only views to draw it —
//
//   `PlanReviewView`      an ExitPlanMode plan, in a modal
//   `ApprovalCardView`    Claude's AskUserQuestion bridge, as the question card
//   `PermissionCardView`  everything else, as the inline card
//
// The window keydown handler below stays here, with the data: it is the
// prompt's safety logic (which keys may pick which option, ADR-0014), and the
// views only draw what it decides.

import { memo, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store";
import { respondAndPopPermission, type PermissionAnswer } from "../lib/respond-permission";
import { Markdown } from "@/lib/markdown";
import { extractPlanMarkdown } from "../lib/plans";
import { exitPlanOffersBypass } from "../lib/exit-plan-modes";
import { composeAnswers, extractQuestions } from "../lib/questions";
import { ApprovalCardView, type Answer } from "./views/approval-card-view";
import { PermissionCardView, type PermissionOptionItem } from "./views/permission-card-view";
import { PlanReviewView } from "./views/plan-review-view";
import { ComposerDrawer } from "./composer-drawer";
import type { PendingPermission } from "@/types/acp";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { isRecordingShortcut } from "@/features/keybindings/lib/recording";
import {
  isOutwardCall,
  keyMayPick,
  outwardApprovalOf,
  outwardPreparingOf,
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
function relabelAgentBrand(label: string, display: string): string {
  // `display` is `agentMeta(agentType).label`, not a raw AGENT_LABEL read: that
  // table only covers first-party agents, so every external one rendered as
  // the anonymous "the agent".
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
 * keyboard-selectable, with a free-text fallback) pinned above the composer;
 * plan reviews keep the richer two-panel modal.
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
  const { applyExitPlanSelection } = useChatStore.use.actions();

  const [draft, setDraft] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Reset the free-text field whenever the active request changes.
  const reqId = current?.requestId;
  useEffect(() => {
    setDraft("");
  }, [reqId]);

  // The option Enter picks, and the one drawn as primary. None on an outward
  // action's card: its Allow is a click (`keyMayPick`).
  const primaryId = current?.options.find(
    (o) => isAllow(o.kind) && keyMayPick(current.toolCall, o.kind),
  )?.optionId;

  // Keyboard: digits 1–9 select, Enter = primary, Esc = cancel — except while
  // the free-text field is focused (there Enter submits text, Esc still cancels).
  useEffect(() => {
    if (!current) return;
    const send = (decision: PermissionAnswer) => {
      void respondAndPopPermission(current, decision, {
        // A plan approval picks a mode the adapter applies silently — see
        // `exit-plan-modes.ts`. Mirror it, or the pill lies from here on.
        onSent: () => {
          if (decision.kind === "selected" && extractPlanMarkdown(current.toolCall)) {
            applyExitPlanSelection(tabId, decision.option_id);
          }
        },
        onError: (e) => toast.error(`Permission send failed: ${e}`),
      });
    };
    const onKey = (e: KeyboardEvent) => {
      // A chord being recorded in Settings → Keybindings is not an answer.
      if (isRecordingShortcut()) return;
      const inText = document.activeElement === textRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        // The plan review is a dialog whose own Esc dismiss also cancels:
        // stop the key here, or one Esc sends two cancels.
        if (extractPlanMarkdown(current.toolCall)) e.stopPropagation();
        send({ kind: "cancelled" });
        return;
      }
      // AskUserQuestion answers are picked by click (the card's button order
      // can differ from the raw ACP option order), so don't let digits/Enter
      // resolve a possibly-mismatched option here.
      if (extractQuestions(current.toolCall)) return;
      if (inText) return; // let the field handle digits / Enter
      // A key the card takes is the card's alone: it must not also reach the
      // composer, where Enter on an empty field is Stop.
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Enter") {
        if (primaryId) {
          consume();
          send({ kind: "selected", option_id: primaryId });
        } else if (isOutwardCall(current.toolCall)) {
          // An outward action's Allow is a click. Its Enter does nothing —
          // it neither posts nor stops the turn under the card.
          consume();
        }
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= current.options.length) {
        const picked = current.options[n - 1];
        consume();
        if (!keyMayPick(current.toolCall, picked.kind)) return;
        send({ kind: "selected", option_id: picked.optionId });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current, primaryId, applyExitPlanSelection, tabId]);

  if (!current) return null;

  /** Answer with an option; for a plan approval also adopt the mode it
   *  selects (`override` = the mode Atlas's own "approve and bypass" action
   *  applies on top of the plain approval). */
  const resolve = (optId: string, override?: "bypassPermissions") => {
    const isPlan = !!extractPlanMarkdown(current.toolCall);
    void respondAndPopPermission(
      current,
      { kind: "selected", option_id: optId },
      {
        onSent: () => {
          if (isPlan) applyExitPlanSelection(tabId, optId, override);
        },
        onError: (e) => toast.error(`Permission send failed: ${e}`),
      },
    );
  };

  const cancel = () => {
    void respondAndPopPermission(
      current,
      { kind: "cancelled" },
      { onError: (e) => toast.error(`Permission cancel failed: ${e}`) },
    );
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
  const preparing = outward ? null : outwardPreparingOf(current.toolCall, current.options);
  const queueNote = queueLength > 1 ? `${queueLength - 1} more pending after this` : null;

  // The options as the views draw them — wire order, relabelled, one primary
  // at most. Shared by the inline card and the plan review.
  const agentLabel = agentMeta(agentType).label;
  const optionItems: PermissionOptionItem[] = current.options.map((opt) => ({
    optionId: opt.optionId,
    label: relabelAgentBrand(opt.name, agentLabel),
    tone: isAllow(opt.kind) ? "allow" : isReject(opt.kind) ? "reject" : "other",
    isPrimary: opt.optionId === primaryId,
  }));

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
      <PlanReviewView
        plan={<Markdown>{planMarkdown}</Markdown>}
        options={optionItems}
        bypassOptionId={bypassOptionId}
        queueNote={queueNote}
        onSelect={resolve}
        onCancel={cancel}
      />
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
      <ComposerDrawer>
        <ApprovalCardView
          key={current.requestId}
          questions={questions}
          queueNote={queueNote}
          onSubmit={submitQuestionAnswers}
        />
      </ComposerDrawer>
    );
  }

  // Standard case — inline card above the composer.
  return (
    <PermissionCardView
      heading={
        preparing
          ? { kind: "preparing", preparing }
          : outward
            ? { kind: "outward", approval: outward }
            : { kind: "tool", title }
      }
      preview={outward || preparing ? null : previewOf(current.toolCall)}
      options={optionItems}
      queueNote={queueNote}
      draft={draft}
      onDraftChange={setDraft}
      onSubmitDraft={submitText}
      draftRef={textRef}
      onSelect={(optionId) => resolve(optionId)}
    />
  );
}

/** The tool call's input as the card previews it: pretty JSON, capped at
 *  4,000 characters, or null when the call carries none. */
function previewOf(tc: PendingPermission["toolCall"]): string | null {
  const inputValue =
    (tc as Record<string, unknown>).rawInput ?? (tc as Record<string, unknown>).input;
  return inputValue !== undefined ? safeStringify(inputValue, 2) : null;
}

function safeStringify(v: unknown, indent: number): string {
  try {
    const s = JSON.stringify(v, null, indent);
    return s.length > 4000 ? s.slice(0, 4000) + "\n…(truncated)" : s;
  } catch {
    return String(v);
  }
}
