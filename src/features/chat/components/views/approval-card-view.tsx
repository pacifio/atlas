// Stepper card for agent questions (AskUserQuestion et al).
//
// One question per step — radio options (or checkboxes for multiSelect), a
// free-text "answer in your own words" field, progress dots, back/next. The
// shape follows beui's ApprovalCard, rebuilt on the design package and with
// NO motion library: the only animation is CSS transitions, per the house
// rules.
//
// The card is a VIEW: it collects answers and hands them back. Mapping an
// answer onto a wire — resolving an ACP permission option, composing a user
// message, or filling an elicitation's form fields — belongs to the container
// (`permission-modal.tsx`, `session-elicitation.tsx`), because the three
// contracts genuinely differ and baking one of them in here is what made this
// renderable for permissions only.
//
// The options stay buttons with a drawn indicator rather than a radio group:
// a radio group's arrow-key roving focus would fight the card's own
// window-level digit and Enter handling below.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuestionSpec } from "../../lib/questions";
import { Button, HintGroup, HintItem, Icon, IconButton, Input } from "@tryatlas/design";

/** One question's answer, as the card reports it. */
export interface Answer {
  selected: string[];
  custom: string;
}

const EMPTY: Answer = { selected: [], custom: "" };

function isAnswered(a: Answer): boolean {
  return a.selected.length > 0 || a.custom.trim().length > 0;
}

export function ApprovalCardView({
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

  const goBack = useCallback(() => {
    clearAdvance();
    setStep((s) => Math.max(0, s - 1));
  }, [clearAdvance]);

  // Keyboard: digits pick/toggle options, ↑/↓ walk the options (focus, so
  // Space or Enter on one is the button's own press), ←/→ move between the
  // questions (→ only once this one is answered, as the arrow button is), and
  // Enter advances/submits. Esc is the permission modal's job (it owns
  // cancel), so it is deliberately not here.
  const optionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      const inText = active === inputRef.current;
      const options = Array.from(
        optionsRef.current?.querySelectorAll<HTMLButtonElement>("[data-option]") ?? [],
      );
      const onOption = options.findIndex((b) => b === active);
      if (e.key === "Enter") {
        // A focused option takes its own Enter (a press); the card takes the rest.
        if (onOption >= 0) return;
        if (inText || isAnswered(answer)) {
          e.preventDefault();
          goNext();
        }
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // In the text field the arrows move the caret; a question only moves
        // from its edges.
        if (inText) {
          const input = inputRef.current!;
          const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
          const atEnd = input.selectionStart === input.value.length;
          if (e.key === "ArrowLeft" ? !atStart : !atEnd) return;
        }
        if (e.key === "ArrowLeft" && step > 0) {
          e.preventDefault();
          goBack();
        } else if (e.key === "ArrowRight" && isAnswered(answer)) {
          e.preventDefault();
          goNext();
        }
        return;
      }
      if (inText) return;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && options.length > 0) {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const next =
          onOption < 0
            ? dir > 0
              ? 0
              : options.length - 1
            : (onOption + dir + options.length) % options.length;
        options[next].focus();
        return;
      }
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, q, step, goNext, goBack]);

  return (
    <div
      // Inset from the 720px column the composer and transcript share, so the
      // question reads as a thing resting ON the conversation rather than as
      // another row of it. Wide enough that an option's label and its
      // description still sit on one line each, which is what the narrower
      // version cost.
      //
      // `bg-popover`, not `bg-card`: this sits directly on the composer, whose
      // field is `background`, and `card` is only one step from it in either
      // appearance — close enough that the two read as one surface with a
      // line through it. `popover` is the lifted tone the rest of the chrome
      // uses when something sits above something else, and it is the step
      // that makes the card legible against the composer in both.
      //
      // The menu elevation (`shadow-md`), which every theme defines for its
      // own appearance. The hand-written black shadow it replaces was tuned
      // for one dark theme and painted a grey smear under the card on light
      // ones, and a heavier one than any menu on dark.
      data-approval-card
      data-testid="approval-card"
      className="mx-auto w-full max-w-[650px] overflow-hidden rounded-xl border border-border bg-popover shadow-md"
    >
      <div
        // `pb-6` rather than matching `pt-3.5`: the card is deliberately
        // bottom-heavy. Its last row is the footer's controls, and its bottom
        // edge is tucked under the composer (see `ComposerDrawer`), so padding
        // that looked even on its own left the next/submit button sitting on
        // the join.
        className="px-4 pt-3.5 pb-6"
      >
        {/* Header: icon, question, step counter. */}
        <div className="flex items-start gap-2.5">
          <Icon icon={CircleHelp} size="lg" className="mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            {/* `q.header` is deliberately not rendered. It is the question's
                category ("Layout", "Features") and the question text below
                already says what is being asked, so the eyebrow was a second,
                shorter restatement sitting above it. It still travels on the
                spec — `composeAnswers` names each answer by it when there is
                more than one question, which is where it earns its keep. */}
            <div className="text-md font-medium leading-snug text-foreground">
              {q.question || "The agent has a question"}
            </div>
            {queueNote && <div className="mt-0.5 text-xs text-muted-foreground">{queueNote}</div>}
          </div>
          {questions.length > 1 && (
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {step + 1}/{questions.length}
            </span>
          )}
        </div>

        {/* Options. */}
        {/* No left indent. Aligning these under the header's TEXT (past the
            icon) cost 26px that the right-hand edge has no counterpart for, so
            the options sat in a column noticeably further from their left
            border than their numbers were from the right one. They now share
            the card's own padding with everything else. */}
        <div ref={optionsRef} className="mt-3 flex flex-col gap-0.5">
          {q.options.map((o, i) => {
            const on = answer.selected.includes(o.label);
            return (
              <button
                key={`${o.label}-${i}`}
                type="button"
                data-option
                aria-pressed={on}
                onClick={() => (q.multiSelect ? toggle(o.label) : pick(o.label))}
                className={cn(
                  "flex min-h-9 w-full items-start gap-3 rounded-lg px-2 py-1.5 text-left transition-colors outline-none",
                  "focus-visible:bg-element-hover focus-visible:ring-1 focus-visible:ring-border-strong",
                  on ? "bg-element-active" : "hover:bg-element-hover",
                )}
              >
                {/* Radio circle / check square, drawn by hand so the tone
                    matches the session instead of a form control. */}
                <span
                  aria-hidden
                  className={cn(
                    "mt-[3px] grid size-[15px] shrink-0 place-items-center border transition-colors",
                    q.multiSelect ? "rounded-sm" : "rounded-full",
                    on ? "border-primary bg-primary" : "border-border-strong",
                  )}
                >
                  {on &&
                    (q.multiSelect ? (
                      <Icon icon={Check} size="xs" strokeWidth={3} className="text-background" />
                    ) : (
                      <span className="size-[5px] rounded-full bg-background" />
                    ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-base leading-snug text-foreground">{o.label}</span>
                  {o.description && (
                    <span className="mt-0.5 block text-xs leading-snug text-secondary-foreground">
                      {o.description}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 shrink-0 font-mono text-2xs text-disabled">{i + 1}</span>
              </button>
            );
          })}

          {/* Free text — always offered; typing clears a single-select pick. */}
          <div className={cn(q.options.length > 0 && "mt-1.5")}>
            <Input
              ref={inputRef}
              size="lg"
              value={answer.custom}
              onChange={(e) =>
                setAnswer({
                  selected: q.multiSelect ? answer.selected : [],
                  custom: e.target.value,
                })
              }
              placeholder={q.options.length > 0 ? "Answer in your own words…" : "Type your answer…"}
            />
          </div>
        </div>

        {/* Footer: back, dots, next/submit. */}
        <HintGroup side="top">
          <div className="mt-5 flex items-center gap-3">
            <HintItem label="Previous question">
              <IconButton
                icon={ArrowLeft}
                label="Previous question"
                size="md"
                shape="round"
                disabled={step === 0}
                onClick={goBack}
              />
            </HintItem>

            <span
              className="flex items-center gap-1.5"
              aria-label={`Question ${step + 1} of ${questions.length}`}
            >
              {questions.map((_, i) => (
                <span
                  key={i}
                  aria-hidden
                  className={cn(
                    // One box for every dot, so the row never reflows; the
                    // current step is full size and the rest scale down to the
                    // 1.5 step (6px of 8), on the compositor.
                    "size-2 rounded-full bg-foreground transition-[scale,opacity] duration-200",
                    i === step ? "opacity-100" : "scale-75",
                    i < step ? "opacity-70" : i > step ? "opacity-30" : "",
                  )}
                />
              ))}
            </span>

            {onSkip && (
              <div className="ml-auto">
                <Button
                  variant="ghost"
                  size="lg"
                  onClick={() => {
                    clearAdvance();
                    onSkip();
                  }}
                >
                  {skipLabel}
                </Button>
              </div>
            )}

            <HintItem
              label={last ? "Submit answers" : "Next question"}
              className={onSkip ? undefined : "ml-auto"}
            >
              <Button
                variant="default"
                size="lg"
                disabled={!isAnswered(answer)}
                onClick={() => goNext()}
              >
                {last && questions.length > 1 && <span>Submit</span>}
                <Icon icon={ArrowRight} size="lg" />
              </Button>
            </HintItem>
          </div>
        </HintGroup>
      </div>
    </div>
  );
}
