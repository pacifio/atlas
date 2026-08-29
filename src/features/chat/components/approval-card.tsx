// Stepper card for agent questions (AskUserQuestion et al).
//
// One question per step — radio options (or checkboxes for multiSelect), a
// free-text "answer in your own words" field, progress dots, back/next. The
// shape follows beui's ApprovalCard, rebuilt on Atlas tokens and with NO
// motion library: the only animation is CSS transitions, per the house rules.
//
// The card is PURE: it collects answers and hands them back. Mapping an answer
// onto a wire — resolving an ACP permission option, composing a user message,
// or filling an elicitation's form fields — belongs to the caller, because the
// three contracts genuinely differ and baking one of them in here is what made
// this renderable for permissions only.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuestionSpec } from "../lib/questions";

/** One question's answer, as the card reports it. */
export interface Answer {
  selected: string[];
  custom: string;
}

const EMPTY: Answer = { selected: [], custom: "" };

function isAnswered(a: Answer): boolean {
  return a.selected.length > 0 || a.custom.trim().length > 0;
}

export function ApprovalCard({
  questions,
  queueNote,
  onSubmit,
  onSkip,
  skipLabel = "Skip",
}: {
  questions: QuestionSpec[];
  queueNote?: string | null;
  /** Every question's answer, in question order. */
  onSubmit: (answers: Answer[]) => void;
  /** Answer nothing and let the agent carry on. Omitted when the caller has no
   *  way to say "no answer" on its wire. */
  onSkip?: () => void;
  skipLabel?: string;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(() => EMPTY));
  const inputRef = useRef<HTMLInputElement>(null);
  const advanceTimer = useRef<number | null>(null);

  const q = questions[Math.min(step, questions.length - 1)];
  const answer = answers[step] ?? EMPTY;
  const last = step === questions.length - 1;

  const setAnswer = useCallback(
    (next: Answer) => {
      setAnswers((cur) => {
        const out = cur.slice();
        out[step] = next;
        return out;
      });
    },
    [step],
  );

  const clearAdvance = useCallback(() => {
    if (advanceTimer.current !== null) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  }, []);
  useEffect(() => clearAdvance, [clearAdvance]);

  const submit = useCallback((finalAnswers: Answer[]) => onSubmit(finalAnswers), [onSubmit]);

  const goNext = useCallback(
    (fromAnswers?: Answer[]) => {
      clearAdvance();
      const current = fromAnswers ?? answers;
      if (last) submit(current);
      else setStep((s) => Math.min(s + 1, questions.length - 1));
    },
    [answers, last, submit, questions.length, clearAdvance],
  );

  /** Single-select pick: set, then auto-advance after a beat (not on the last
   *  step — there the arrow becomes Submit and the pause reads as a stall). */
  const pick = (label: string) => {
    const next: Answer = { selected: [label], custom: "" };
    setAnswer(next);
    if (!last) {
      clearAdvance();
      const stepped = answers.slice();
      stepped[step] = next;
      advanceTimer.current = window.setTimeout(() => goNext(stepped), 220);
    }
  };

  const toggle = (label: string) => {
    const on = answer.selected.includes(label);
    setAnswer({
      ...answer,
      selected: on ? answer.selected.filter((l) => l !== label) : [...answer.selected, label],
    });
  };

  // Keyboard: digits pick/toggle options, Enter advances/submits. Esc is the
  // permission modal's job (it owns cancel), so it is deliberately not here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inText = document.activeElement === inputRef.current;
      if (e.key === "Enter") {
        if (inText || isAnswered(answer)) {
          e.preventDefault();
          goNext();
        }
        return;
      }
      if (inText) return;
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= q.options.length) {
        e.preventDefault();
        const label = q.options[n - 1].label;
        if (q.multiSelect) toggle(label);
        else pick(label);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, q, step, goNext]);

  return (
    <div className="mx-auto w-full max-w-[720px] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
      <div className="px-4 pt-3.5 pb-4">
        {/* Header: icon, question, step counter. */}
        <div className="flex items-start gap-2.5">
          <CircleHelp className="mt-0.5 size-4 shrink-0 text-[var(--text-tertiary)]" />
          <div className="min-w-0 flex-1">
            {q.header && (
              <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                {q.header}
              </div>
            )}
            <div className="text-[14px] font-medium leading-snug text-[var(--text-primary)]">
              {q.question || "The agent has a question"}
            </div>
            {queueNote && (
              <div className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">{queueNote}</div>
            )}
          </div>
          {questions.length > 1 && (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-tertiary)]">
              {step + 1}/{questions.length}
            </span>
          )}
        </div>

        {/* Options. */}
        <div className="mt-3 flex flex-col gap-0.5 pl-[26px]">
          {q.options.map((o, i) => {
            const on = answer.selected.includes(o.label);
            return (
              <button
                key={`${o.label}-${i}`}
                type="button"
                onClick={() => (q.multiSelect ? toggle(o.label) : pick(o.label))}
                className={cn(
                  "flex min-h-9 w-full items-start gap-3 rounded-lg px-2 py-1.5 text-left transition-colors",
                  on ? "bg-[var(--bg-active)]" : "hover:bg-[var(--bg-hover)]",
                )}
              >
                {/* Radio circle / check square, drawn by hand so the tone
                    matches the thread instead of a form control. */}
                <span
                  aria-hidden
                  className={cn(
                    "mt-[3px] grid size-[15px] shrink-0 place-items-center border transition-colors",
                    q.multiSelect ? "rounded-[4px]" : "rounded-full",
                    on
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]"
                      : "border-[var(--border-strong)]",
                  )}
                >
                  {on &&
                    (q.multiSelect ? (
                      <Check size={10} strokeWidth={3} className="text-[var(--bg-base)]" />
                    ) : (
                      <span className="size-[5px] rounded-full bg-[var(--bg-base)]" />
                    ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-snug text-[var(--text-primary)]">
                    {o.label}
                  </span>
                  {o.description && (
                    <span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-secondary)]">
                      {o.description}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 shrink-0 font-mono text-[10px] text-[var(--text-ghost)]">
                  {i + 1}
                </span>
              </button>
            );
          })}

          {/* Free text — always offered; typing clears a single-select pick. */}
          <input
            ref={inputRef}
            value={answer.custom}
            onChange={(e) =>
              setAnswer({
                selected: q.multiSelect ? answer.selected : [],
                custom: e.target.value,
              })
            }
            placeholder={q.options.length > 0 ? "Answer in your own words…" : "Type your answer…"}
            className={cn(
              "h-10 w-full rounded-lg border-0 bg-[var(--bg-base)]/70 px-3 text-[13px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:bg-[var(--bg-base)]",
              q.options.length > 0 && "mt-1.5",
            )}
          />
        </div>

        {/* Footer: back, dots, next/submit. */}
        <div className="mt-4 flex items-center gap-3 pl-[26px]">
          <button
            type="button"
            aria-label="Previous question"
            disabled={step === 0}
            onClick={() => {
              clearAdvance();
              setStep((s) => Math.max(0, s - 1));
            }}
            className={cn(
              "grid size-8 place-items-center rounded-full transition-colors",
              step === 0
                ? "cursor-default text-[var(--text-ghost)]"
                : "cursor-pointer text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
            )}
          >
            <ArrowLeft size={15} />
          </button>

          <span
            className="flex items-center gap-1.5"
            aria-label={`Question ${step + 1} of ${questions.length}`}
          >
            {questions.map((_, i) => (
              <span
                key={i}
                aria-hidden
                className={cn(
                  "rounded-full bg-[var(--text-primary)] transition-all duration-200",
                  i === step ? "size-2 opacity-100" : "size-1.5",
                  i < step ? "opacity-70" : i > step ? "opacity-30" : "",
                )}
              />
            ))}
          </span>

          {onSkip && (
            <button
              type="button"
              onClick={() => {
                clearAdvance();
                onSkip();
              }}
              className="ml-auto cursor-pointer rounded-full px-2.5 py-1.5 text-[12px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              {skipLabel}
            </button>
          )}

          <button
            type="button"
            aria-label={last ? "Submit answers" : "Next question"}
            disabled={!isAnswered(answer)}
            onClick={() => goNext()}
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors",
              onSkip ? "" : "ml-auto",
              isAnswered(answer)
                ? "cursor-pointer bg-[var(--accent-primary)] text-[var(--bg-base)] hover:bg-[var(--accent-primary-hover)]"
                : "cursor-default bg-[var(--bg-base)] text-[var(--text-ghost)]",
            )}
          >
            {last && questions.length > 1 && <span>Submit</span>}
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
