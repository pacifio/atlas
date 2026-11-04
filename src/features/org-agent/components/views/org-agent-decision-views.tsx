// What Atlas puts to the member mid-answer — a question, an approval — and
// an approval once decided. Props only: `org-agent-turn.tsx` reads the store
// and hands these what is in flight and how to send.

import { useState } from "react";
import { Bell, Check, Eye, Loader2 } from "lucide-react";

import type { OrgAgentTarget } from "../../lib/org-agent-links";
import type { ApprovalBlock, QuestionBlock } from "../../lib/org-agent-log";
import { CardList } from "../org-agent-cards";
import { Notice } from "./org-agent-turn-parts";
import { Badge, Button, Input } from "@tryatlas/design";

// ── Questions ───────────────────────────────────────────────────────────────

/** A question Atlas asked: its choices as buttons, and a line of free text
 *  when it allows one. */
export function QuestionCardView({
  block,
  sending,
  answer,
}: {
  block: QuestionBlock;
  sending: boolean;
  answer: (questionId: string, answer: { choice?: string; text?: string }) => unknown;
}) {
  const [text, setText] = useState("");
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      data-slot="org-agent-question"
    >
      <p className="text-sm text-foreground">{block.text}</p>
      {block.answered ? (
        <p className="text-2xs text-muted-foreground">Answered.</p>
      ) : sending ? (
        <p className="flex items-center gap-2 text-2xs text-muted-foreground" aria-live="polite">
          <Loader2 size={11} className="animate-spin" />
          Sending your answer
        </p>
      ) : (
        <>
          {block.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {block.options.map((o) => (
                <Button
                  key={o.id}
                  size="sm"
                  variant="outline"
                  onClick={() => answer(block.question_id, { choice: o.id })}
                >
                  {o.label}
                </Button>
              ))}
            </div>
          )}
          {block.allow_text && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) answer(block.question_id, { text: text.trim() });
              }}
            >
              <Input
                aria-label="Your answer"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Or type an answer"
                className="flex-1"
              />
              <Button type="submit" size="sm" disabled={!text.trim()}>
                Answer
              </Button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

// ── Approvals ───────────────────────────────────────────────────────────────

const HOW: Record<string, string> = { dm: "direct message", mention: "mention", digest: "digest" };

export function ApprovalFormView({
  block,
  deciding,
  connected,
  onApprove,
  onDecline,
}: {
  block: ApprovalBlock;
  deciding: boolean;
  connected: boolean;
  /** Sends the approval for the kept rows and the (possibly edited) body. */
  onApprove: (selected: readonly boolean[], body: string | null) => void;
  /** Sends the decline, with its reason. */
  onDecline: (selected: readonly boolean[], body: string | null, reason: string) => void;
}) {
  const { card } = block;
  const [selected, setSelected] = useState(() => card.rows.map((r) => r.selected));
  const [body, setBody] = useState<string | null>(card.editable_body ? (card.body ?? "") : null);
  const [pressed, setPressed] = useState<"approve" | "decline" | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  const batch = card.rows.length > 1;
  const fact = card.tool === "propose_fact";
  const none = batch && !selected.some(Boolean);
  const canConfirm = connected && !deciding && !none && (body === null || body.trim().length > 0);
  const confirm = () => {
    if (!canConfirm) return;
    setPressed("approve");
    onApprove(selected, body);
  };
  const decline = () => {
    if (deciding || !connected) return;
    setPressed("decline");
    onDecline(selected, body, reason);
  };

  return (
    <section
      aria-label="Approval needed"
      data-slot="org-agent-approval"
      className="flex flex-col gap-3 rounded-xl border border-border-strong bg-card p-3 shadow-sm"
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
        const el = e.target as HTMLElement;
        if (el.dataset.slot === "decline-reason") {
          e.preventDefault();
          decline();
          return;
        }
        const inField = el.tagName === "TEXTAREA";
        if ((inField && !(e.metaKey || e.ctrlKey)) || (!inField && el.closest("button"))) return;
        e.preventDefault();
        confirm();
      }}
    >
      <header className="flex items-center gap-2">
        <Badge variant="warning">Needs your approval</Badge>
        <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{card.title}</h3>
      </header>

      {card.warnings.map((w, i) =>
        w.kind === "external_content" ? (
          <Notice key={i} tone="error">
            {w.note}
          </Notice>
        ) : (
          <Notice key={i} tone="warning">
            {w.note}
          </Notice>
        ),
      )}

      {batch ? (
        <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border">
          {card.rows.map((row, i) => (
            <li key={`${row.target.kind}:${row.target.id}`}>
              <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selected[i] ?? false}
                  onChange={(e) =>
                    setSelected((s) => s.map((v, j) => (j === i ? e.target.checked : v)))
                  }
                  disabled={deciding}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">{row.target.name}</span>
                  {row.body && (
                    <span className="mt-0.5 block whitespace-pre-wrap break-words text-2xs text-muted-foreground">
                      {row.body}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        card.rows[0] && (
          <p className="text-xs text-muted-foreground">
            {fact ? "About" : "To"}{" "}
            <span className="font-medium text-foreground">{card.rows[0].target.name}</span>
          </p>
        )
      )}

      {body !== null ? (
        <textarea
          aria-label={fact ? "Fact" : "Message"}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={deciding}
          rows={Math.min(10, Math.max(3, body.split("\n").length))}
          className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none focus:border-border-strong"
        />
      ) : (
        card.body && (
          <p className="max-h-60 overflow-y-auto rounded-md border border-border bg-background px-2.5 py-2 text-xs whitespace-pre-wrap break-words text-foreground">
            {card.body}
          </p>
        )
      )}

      {card.loop && (
        <dl
          data-slot="loop-setup"
          className="flex flex-col gap-1 rounded-md bg-element-hover px-2.5 py-2 text-2xs"
        >
          <div className="flex flex-wrap gap-x-1.5">
            <dt className="text-muted-foreground">Runs</dt>
            <dd className="text-foreground">{card.loop.trigger}</dd>
          </div>
          <div className="flex flex-wrap gap-x-1.5">
            <dt className="text-muted-foreground">Result goes to</dt>
            <dd className="text-foreground">{card.loop.output}</dd>
          </div>
          <div className="flex flex-wrap gap-x-1.5">
            <dt className="text-muted-foreground">Reads</dt>
            <dd className="text-foreground">{card.loop.audience}</dd>
          </div>
        </dl>
      )}

      {card.sources && card.sources.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-2xs text-muted-foreground">Sources</p>
          <ul aria-label="Sources" className="flex flex-wrap gap-1.5">
            {card.sources.map((s) => (
              <li
                key={`${s.kind}:${s.ref}`}
                className="rounded-full bg-element-hover px-2 py-0.5 font-mono text-2xs"
              >
                {s.label ?? s.ref}
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="flex flex-col gap-1 text-2xs text-muted-foreground">
        {card.notifies.length > 0 && (
          <div className="flex items-start gap-1.5">
            <dt className="flex shrink-0 items-center pt-px">
              <Bell size={11} />
              <span className="sr-only">Notifies</span>
            </dt>
            <dd className="min-w-0">
              Notifies {card.notifies.map((n) => `${n.name} (${HOW[n.how] ?? n.how})`).join(", ")}
            </dd>
          </div>
        )}
        <div className="flex items-start gap-1.5">
          <dt className="flex shrink-0 items-center pt-px">
            <Eye size={11} />
            <span className="sr-only">Visible to</span>
          </dt>
          <dd className="min-w-0">Visible to {card.visible_to.description}</dd>
        </div>
      </dl>

      {declining && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            data-slot="decline-reason"
            aria-label="Reason for declining"
            placeholder="Tell Atlas why (optional)"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            disabled={deciding}
            autoFocus
            className="min-w-0 flex-1 basis-48"
          />
          <Button variant="ghost" size="sm" onClick={() => setDeclining(false)} disabled={deciding}>
            Back
          </Button>
          <Button size="sm" variant="secondary" onClick={decline} disabled={deciding}>
            {deciding && pressed === "decline" ? "Declining…" : "Decline"}
          </Button>
        </div>
      )}

      <footer className="flex items-center justify-end gap-2 border-t border-border-subtle pt-2.5">
        {!connected && (
          <span className="mr-auto text-2xs text-muted-foreground">Reconnecting…</span>
        )}
        {!declining && (
          <Button variant="ghost" size="sm" onClick={() => setDeclining(true)} disabled={deciding}>
            Decline
          </Button>
        )}
        <Button
          size="sm"
          onClick={confirm}
          disabled={!canConfirm || declining}
          aria-busy={deciding && pressed === "approve"}
        >
          {deciding && pressed === "approve"
            ? "Working…"
            : fact
              ? "Save"
              : card.tool === "loop_create"
                ? "Create Loop"
                : "Confirm"}
        </Button>
      </footer>
    </section>
  );
}

/** An approval once decided: what was proposed, and what came of it. */
export function ApprovalSummary({
  block,
  onOpen,
}: {
  block: ApprovalBlock;
  onOpen: (target: OrgAgentTarget) => void;
}) {
  const { card, resolved } = block;
  const target =
    card.rows.length > 1 ? `${card.rows.length} recipients` : (card.rows[0]?.target.name ?? "");
  return (
    <div className="flex flex-col gap-2" data-slot="org-agent-approval-summary">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{card.title}</span>
        {target && <span>· {target}</span>}
        {resolved === null ? (
          <Badge variant="warning">Waiting for you</Badge>
        ) : resolved.withdrawn ? (
          <Badge variant="outline">Withdrawn</Badge>
        ) : resolved.decision === "decline" ? (
          <Badge variant="outline">Declined</Badge>
        ) : resolved.outcome_unknown ? (
          <Badge variant="warning">Outcome unknown</Badge>
        ) : resolved.executed && !resolved.executed.ok ? (
          <Badge variant="destructive">Failed</Badge>
        ) : (
          <Badge variant="success">
            <Check size={10} />
            Done
          </Badge>
        )}
      </div>
      {resolved?.outcome_unknown && (
        <p className="text-2xs text-muted-foreground">
          Atlas could not confirm whether this went through. Check before trying again.
        </p>
      )}
      {resolved?.executed && resolved.executed.cards.length > 0 && (
        <CardList cards={resolved.executed.cards} onOpen={onOpen} />
      )}
    </div>
  );
}
