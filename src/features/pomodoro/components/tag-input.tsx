import { useRef, useState } from "react";
import { X, Plus, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  /** Existing tag universe — surfaced as quick-pick chips. */
  known: string[];
  placeholder?: string;
}

/**
 * Editor for a list of tag names. Renders selected tags as removable
 * chips followed by an inline "+ Add" affordance. Suggestions for
 * existing (known) tags not yet selected appear below.
 */
export function TagInput({
  value,
  onChange,
  known,
  placeholder = "tag name",
}: Props) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const n = raw.trim();
    if (!n) return;
    if (value.includes(n)) return;
    onChange([...value, n]);
  };

  const toggle = (name: string) => {
    if (value.includes(name)) onChange(value.filter((t) => t !== name));
    else onChange([...value, name]);
  };

  const remove = (name: string) => onChange(value.filter((t) => t !== name));

  const startAdd = () => {
    setAdding(true);
    setDraft("");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const finishAdd = (commitIt: boolean) => {
    if (commitIt) commit(draft);
    setDraft("");
    setAdding(false);
  };

  const suggestions = known.filter(
    (t) =>
      !value.includes(t) &&
      (!adding || t.toLowerCase().includes(draft.trim().toLowerCase())),
  );
  const draftMatchesKnown = known.some(
    (t) => t.toLowerCase() === draft.trim().toLowerCase(),
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5 items-center">
        {value.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full bg-text-primary text-bg-primary text-[12px]"
          >
            {t}
            <button
              onClick={() => remove(t)}
              aria-label={`Remove ${t}`}
              className="inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-bg-primary/20 cursor-pointer"
            >
              <X size={10} strokeWidth={2.5} />
            </button>
          </span>
        ))}

        {adding ? (
          <div className="inline-flex items-center gap-1 h-7 px-2 rounded-full border border-border-default bg-bg-input">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  finishAdd(true);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  finishAdd(false);
                } else if (e.key === "Backspace" && !draft && value.length) {
                  e.preventDefault();
                  onChange(value.slice(0, -1));
                }
              }}
              onBlur={() => finishAdd(true)}
              placeholder={placeholder}
              className="bg-transparent border-none outline-none text-[12px] text-text-primary placeholder:text-text-tertiary w-[110px]"
            />
            {draft.trim() && !draftMatchesKnown && (
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  finishAdd(true);
                }}
                className="inline-flex items-center justify-center w-4 h-4 rounded-full text-text-secondary hover:text-text-primary cursor-pointer"
                title="Create"
              >
                <Check size={11} />
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={startAdd}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-dashed border-border-default text-[12px] text-text-tertiary hover:text-text-primary hover:border-border-strong cursor-pointer"
          >
            <Plus size={11} />
            Add tag
          </button>
        )}
      </div>

      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.slice(0, 12).map((t) => (
            <button
              key={t}
              onClick={() => toggle(t)}
              className={cn(
                "inline-flex items-center h-6 px-2 rounded-full border text-[11px] transition-colors cursor-pointer",
                "border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-text-primary",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
