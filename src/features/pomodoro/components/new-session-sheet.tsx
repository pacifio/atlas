import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ChevronLeft, ChevronRight, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePomodoroStore } from "../stores/pomodoro-store";
import { PRESETS } from "../lib/presets";
import { fmtDur } from "../lib/format";
import type { PresetId } from "../lib/pomodoro-types";
import { TagInput } from "./tag-input";

export function NewSessionSheet() {
  const open = usePomodoroStore.use.sheetOpen();
  const knownTags = usePomodoroStore.use.knownTags();
  const { closeSheet, startSession } = usePomodoroStore.use.actions();

  const [step, setStep] = useState(1);
  const [task, setTask] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [presetId, setPresetIdLocal] = useState<PresetId>("25-5");
  const [customFocus, setCustomFocus] = useState(25);
  const [customBreak, setCustomBreak] = useState(5);
  const [cycles, setCycles] = useState(4);
  const taskRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setStep(1);
      setTask("");
      setNotes("");
      setTags([]);
      setPresetIdLocal("25-5");
      setCycles(4);
      setTimeout(() => taskRef.current?.focus(), 50);
    }
  }, [open]);

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const focusMin = presetId === "custom" ? customFocus : preset.focusMin;
  const breakMin = presetId === "custom" ? customBreak : preset.breakMin;
  const totalMin = focusMin * cycles + breakMin * Math.max(0, cycles - 1);
  const canAdvance = step === 1 ? task.trim().length > 0 : true;

  const next = () => canAdvance && setStep((s) => Math.min(3, s + 1));
  const prev = () => setStep((s) => Math.max(1, s - 1));

  const submit = () => {
    startSession({
      task: task.trim() || "Untitled focus",
      tags,
      presetId,
      focusMin,
      breakMin,
      cycles,
    });
    closeSheet();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && closeSheet()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[var(--z-overlay)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-[15%] -translate-x-1/2 z-[var(--z-modal)]",
            "w-[520px] max-h-[80vh] rounded-xl overflow-hidden flex flex-col",
            "bg-bg-secondary border border-border-default shadow-[var(--shadow-overlay)]",
          )}
        >
          <div className="px-6 pt-5 pb-1 flex items-start justify-between">
            <div>
              <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-1.5">
                New session
              </div>
              <Dialog.Title className="text-[17px] font-semibold tracking-tight text-text-primary">
                {step === 1 && "What are you working on?"}
                {step === 2 && "Choose your interval"}
                {step === 3 && "Ready to start"}
              </Dialog.Title>
            </div>
            <button
              onClick={closeSheet}
              aria-label="Close"
              className="inline-flex items-center justify-center w-7 h-7 rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>

          <Stepper step={step} />

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {step === 1 && (
              <div className="flex flex-col gap-4">
                <Field label="Task" hint={`${task.length}/120`}>
                  <input
                    ref={taskRef}
                    value={task}
                    onChange={(e) => setTask(e.target.value.slice(0, 120))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && task.trim()) next();
                    }}
                    placeholder="e.g. Refactor session card component"
                    className="w-full h-10 px-3 bg-bg-input border border-border-default rounded text-[13px] text-text-primary outline-none focus:border-border-focus"
                  />
                </Field>
                <Field
                  label="Tags"
                  hint={tags.length ? `${tags.length} selected` : "categorize this session"}
                >
                  <TagInput value={tags} onChange={setTags} known={knownTags} />
                </Field>
                <Field label="Notes" hint="optional">
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Context, intentions, links…"
                    className="w-full min-h-[72px] p-3 bg-bg-input border border-border-default rounded text-[13px] text-text-primary outline-none focus:border-border-focus resize-y"
                  />
                </Field>
              </div>
            )}

            {step === 2 && (
              <div className="flex flex-col gap-4">
                <Field label="Preset">
                  <div className="grid grid-cols-2 gap-2">
                    {PRESETS.map((p) => {
                      const active = p.id === presetId;
                      return (
                        <button
                          key={p.id}
                          onClick={() => setPresetIdLocal(p.id)}
                          className={cn(
                            "text-left p-3 rounded-md border transition-colors",
                            active
                              ? "bg-bg-elevated border-text-primary"
                              : "border-border-default hover:bg-bg-hover",
                          )}
                        >
                          <div className="text-[13px] font-medium text-text-primary">{p.label}</div>
                          <div className="text-[11px] text-text-tertiary mt-0.5">{p.sub}</div>
                        </button>
                      );
                    })}
                  </div>
                </Field>
                {presetId === "custom" && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Focus" hint="minutes">
                      <input
                        type="number"
                        min={5}
                        max={180}
                        value={customFocus}
                        onChange={(e) => setCustomFocus(parseInt(e.target.value || "0"))}
                        className="w-full h-9 px-3 bg-bg-input border border-border-default rounded text-[13px] text-text-primary outline-none focus:border-border-focus tabular-nums"
                      />
                    </Field>
                    <Field label="Break" hint="minutes">
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={customBreak}
                        onChange={(e) => setCustomBreak(parseInt(e.target.value || "0"))}
                        className="w-full h-9 px-3 bg-bg-input border border-border-default rounded text-[13px] text-text-primary outline-none focus:border-border-focus tabular-nums"
                      />
                    </Field>
                  </div>
                )}
                <Field label="Cycles" hint={`≈ ${fmtDur(totalMin)} total`}>
                  <div className="flex items-center gap-2.5">
                    <StepperBtn onClick={() => setCycles((c) => Math.max(1, c - 1))}>−</StepperBtn>
                    <div className="flex gap-1 flex-1">
                      {Array.from({ length: 8 }, (_, i) => {
                        const filled = i < cycles;
                        return (
                          <button
                            key={i}
                            onClick={() => setCycles(i + 1)}
                            className={cn(
                              "flex-1 h-6 rounded transition-colors",
                              filled ? "bg-text-primary" : "bg-border-default",
                            )}
                          />
                        );
                      })}
                    </div>
                    <StepperBtn onClick={() => setCycles((c) => Math.min(8, c + 1))}>+</StepperBtn>
                    <span className="text-[13px] font-semibold text-text-primary min-w-[18px] text-right tabular-nums">
                      {cycles}
                    </span>
                  </div>
                </Field>
              </div>
            )}

            {step === 3 && (
              <div className="flex flex-col gap-4">
                <div className="p-4 rounded-md border border-border-default bg-bg-elevated">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-1.5">
                        Session
                      </div>
                      <div className="text-[14px] font-medium text-text-primary leading-snug truncate">
                        {task || "Untitled focus"}
                      </div>
                      {tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {tags.map((t) => (
                            <span
                              key={t}
                              className="inline-flex items-center px-2 h-5 rounded-full bg-bg-secondary border border-border-subtle text-[11px] text-text-secondary"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[22px] font-semibold text-text-primary tabular-nums">
                        {fmtDur(totalMin)}
                      </div>
                      <div className="text-[11px] text-text-tertiary mt-1">
                        {cycles} × {focusMin}m
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-border-subtle">
                    <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-2">
                      Schedule preview
                    </div>
                    <div className="flex gap-0.5 h-5">
                      {Array.from({ length: cycles }, (_, i) => (
                        <div
                          key={i}
                          className="flex gap-0.5"
                          style={{ flex: `${focusMin + (i < cycles - 1 ? breakMin : 0)} 1 0` }}
                        >
                          <div
                            className="bg-text-primary rounded-sm flex items-center justify-center text-[10px] text-bg-primary font-semibold tabular-nums"
                            style={{ flex: `${focusMin} 1 0` }}
                          >
                            {focusMin}m
                          </div>
                          {i < cycles - 1 && (
                            <div
                              className="bg-border-default rounded-sm flex items-center justify-center text-[10px] text-text-tertiary tabular-nums"
                              style={{ flex: `${breakMin} 1 0` }}
                            >
                              {breakMin}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between px-5 py-3 border-t border-border-subtle bg-bg-base">
            <div className="text-[11px] text-text-tertiary">
              {step === 1 && "Enter ⮐ to continue"}
              {step === 2 && `Total ≈ ${fmtDur(totalMin)}`}
              {step === 3 && "All set"}
            </div>
            <div className="flex gap-1.5">
              {step > 1 && (
                <FooterBtn onClick={prev}>
                  <ChevronLeft size={12} /> Back
                </FooterBtn>
              )}
              <FooterBtn onClick={closeSheet}>Cancel</FooterBtn>
              {step < 3 ? (
                <FooterBtn primary disabled={!canAdvance} onClick={next}>
                  Continue <ChevronRight size={12} />
                </FooterBtn>
              ) : (
                <FooterBtn primary onClick={submit}>
                  <Play size={12} /> Start session
                </FooterBtn>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Stepper({ step }: { step: number }) {
  const labels = ["Task", "Interval", "Start"];
  return (
    <div className="flex items-center gap-2 px-6 pb-2">
      {labels.map((l, i) => {
        const n = i + 1;
        const active = step === n;
        const done = step > n;
        return (
          <div key={l} className="flex items-center gap-2">
            <div
              className={cn(
                "w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-semibold transition-colors tabular-nums",
                done || active
                  ? "bg-text-primary text-bg-primary"
                  : "bg-border-default text-text-tertiary",
              )}
            >
              {n}
            </div>
            <span
              className={cn("text-[12px]", active ? "text-text-primary" : "text-text-tertiary")}
            >
              {l}
            </span>
            {i < labels.length - 1 && <div className="w-6 h-px bg-border-default mx-1" />}
          </div>
        );
      })}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
          {label}
        </span>
        {hint && <span className="text-[11px] text-text-tertiary/70">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function StepperBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center justify-center w-7 h-7 rounded border border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer"
    >
      <span className="text-[14px] leading-none">{children}</span>
    </button>
  );
}

function FooterBtn({
  onClick,
  primary,
  disabled,
  children,
}: {
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 h-8 px-3 rounded text-[12px] font-medium transition-colors cursor-pointer",
        primary
          ? "bg-text-primary text-bg-primary hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
      )}
    >
      {children}
    </button>
  );
}
