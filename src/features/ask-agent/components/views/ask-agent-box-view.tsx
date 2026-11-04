// The ask box's face: the context chips, the prompt, the session picker and
// the two ways out (send, or draft into the composer). Props only — the
// container is `ask-agent-host.tsx`.

import type { Ref } from "react";
import { X } from "lucide-react";
import { Button, Icon, KbdKeys, Pill, Select, Textarea } from "@tryatlas/design";

import type { AgentContext } from "../../lib/agent-context";
import { askKeyAction } from "../../lib/ask-box-keys";
import { CONTEXT_ICON } from "../../lib/context-icons";

export interface AskChipView {
  key: string;
  kind: AgentContext["kind"];
  label: string;
  /** The hover: the source and the start of the excerpt. */
  title: string;
}

export interface AskTargetOption {
  value: string;
  label: string;
  description?: string;
}

export interface AskAgentBoxViewProps {
  chips: readonly AskChipView[];
  onRemoveChip: (key: string) => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  placeholder?: string;
  /** Quick prompts; picking one fills the prompt. */
  suggestions?: readonly string[];
  onSuggestion?: (prompt: string) => void;
  targets: readonly AskTargetOption[];
  target: string;
  onTargetChange: (target: string) => void;
  onSend: () => void;
  onDraft: () => void;
  onCancel: () => void;
  /** There is something to ask (a chip or words) and nothing in flight. */
  canSubmit: boolean;
  error: string | null;
  /** Keycaps for the two actions (["⌘", "↵"], ["Ctrl", "↵"], …). */
  sendKeys: readonly string[];
  draftKeys: readonly string[];
  inputRef?: Ref<HTMLTextAreaElement>;
}

export function AskAgentBoxView({
  chips,
  onRemoveChip,
  prompt,
  onPromptChange,
  placeholder = "Ask the agent…",
  suggestions,
  onSuggestion,
  targets,
  target,
  onTargetChange,
  onSend,
  onDraft,
  onCancel,
  canSubmit,
  error,
  sendKeys,
  draftKeys,
  inputRef,
}: AskAgentBoxViewProps) {
  return (
    <div className="flex flex-col gap-2">
      {chips.length > 0 && (
        <ul aria-label="Context" className="flex flex-wrap gap-1">
          {chips.map((chip) => (
            <li key={chip.key} className="min-w-0">
              <Pill trailingAction title={chip.title} className="max-w-full">
                <Icon icon={CONTEXT_ICON[chip.kind]} size="xs" />
                <span className="truncate">{chip.label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${chip.label}`}
                  onClick={() => onRemoveChip(chip.key)}
                  className="inline-flex shrink-0 items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon icon={X} size="xs" />
                </button>
              </Pill>
            </li>
          ))}
        </ul>
      )}
      {suggestions && suggestions.length > 0 && (
        <div role="group" aria-label="Suggested asks" className="flex flex-wrap gap-1">
          {suggestions.map((s) => (
            <Button
              key={s}
              size="xs"
              variant="outline"
              aria-pressed={prompt.trim() === s}
              onClick={() => onSuggestion?.(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      )}
      <Textarea
        ref={inputRef}
        value={prompt}
        rows={3}
        aria-label="Ask the agent"
        placeholder={placeholder}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={(e) => {
          const action = askKeyAction({
            key: e.key,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            isComposing: e.nativeEvent.isComposing || e.keyCode === 229,
          });
          if (!action) return;
          e.preventDefault();
          if (action === "cancel") onCancel();
          else if (!canSubmit) return;
          else if (action === "send") onSend();
          else onDraft();
        }}
      />
      {error && (
        <p role="alert" className="text-3xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Select
            size="sm"
            variant="ghost"
            aria-label="Session"
            // A long session title truncates inside the trigger instead of
            // running under Draft and Send.
            className="max-w-full"
            value={target}
            onValueChange={onTargetChange}
            options={targets}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" disabled={!canSubmit} onClick={onDraft}>
            Draft
            <KbdKeys keys={draftKeys} />
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={onSend}>
            Send
            <KbdKeys keys={sendKeys} />
          </Button>
        </div>
      </div>
    </div>
  );
}
