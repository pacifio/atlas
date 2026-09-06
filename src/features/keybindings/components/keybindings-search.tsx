import { useEffect, useRef } from "react";
import { ArrowDownAZ, Keyboard, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { KbdKeys } from "@/ui/kbd";
import { type Combo, comboFromEvent, displayKeys } from "../lib/combo";
import { IconButton } from "./profile-bar";

export interface SearchState {
  query: string;
  /** Record-keys mode: the input captures a chord instead of text. */
  recordKeys: boolean;
  recorded: Combo | null;
  sortAlpha: boolean;
}

/**
 * VS Code's search row: free text, or — with the keyboard toggle on — press a
 * chord and the table filters to whatever is bound to it.
 */
export function KeybindingsSearch({
  state,
  onChange,
}: {
  state: SearchState;
  onChange: (next: SearchState) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the field when record mode turns on so the next chord lands here.
  useEffect(() => {
    if (state.recordKeys) inputRef.current?.focus();
  }, [state.recordKeys]);

  const clear = () => onChange({ ...state, query: "", recorded: null });
  const empty = !state.query && !state.recorded;

  return (
    <div className="flex h-[36px] shrink-0 items-center gap-1 border-b border-border-default px-2">
      <div
        className={cn(
          "flex h-6 flex-1 items-center gap-1.5 rounded-md border bg-bg-elevated px-2",
          state.recordKeys
            ? "border-border-strong"
            : "border-border-default focus-within:border-border-strong",
        )}
      >
        {state.recordKeys ? (
          <Keyboard size={12} className="shrink-0 text-text-tertiary" />
        ) : (
          <Search size={12} className="shrink-0 text-text-tertiary" />
        )}
        {state.recordKeys ? (
          <input
            ref={inputRef}
            readOnly
            value={state.recorded ? displayKeys(state.recorded).join(" ") : ""}
            placeholder="Press a key combination to find what it's bound to…"
            onKeyDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.key === "Escape") {
                onChange({ ...state, recordKeys: false, recorded: null });
                return;
              }
              if (e.key === "Backspace" && !e.metaKey && !e.altKey && !e.ctrlKey) {
                onChange({ ...state, recorded: null });
                return;
              }
              const combo = comboFromEvent(e.nativeEvent);
              if (combo) onChange({ ...state, recorded: combo });
            }}
            className="h-full flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-muted"
          />
        ) : (
          <input
            ref={inputRef}
            value={state.query}
            placeholder="Type to search in keybindings"
            onChange={(e) => onChange({ ...state, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && state.query) {
                e.preventDefault();
                clear();
              }
              e.stopPropagation();
            }}
            className="h-full flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-muted"
          />
        )}
        {state.recordKeys && state.recorded && <KbdKeys keys={displayKeys(state.recorded)} />}
      </div>
      <IconButton
        label={state.recordKeys ? "Record keys (on)" : "Record keys"}
        active={state.recordKeys}
        onClick={() => onChange({ ...state, recordKeys: !state.recordKeys, recorded: null })}
      >
        <Keyboard size={13} />
      </IconButton>
      <IconButton
        label={state.sortAlpha ? "Sorted A–Z" : "Grouped by category"}
        active={state.sortAlpha}
        onClick={() => onChange({ ...state, sortAlpha: !state.sortAlpha })}
      >
        <ArrowDownAZ size={13} />
      </IconButton>
      <IconButton label="Clear search" disabled={empty} onClick={clear}>
        <X size={13} />
      </IconButton>
    </div>
  );
}
