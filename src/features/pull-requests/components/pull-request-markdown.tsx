// Markdown as a pull request writes it, and the editor for it. The renderer
// is lazy (`pull-request-markdown-impl.tsx`); while its chunk loads the raw
// text shows, so nothing jumps from blank to filled.

import { lazy, Suspense, useState } from "react";
import { Pencil } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Segmented } from "@/ui/segmented";

const PullRequestMarkdownImpl = lazy(() => import("./pull-request-markdown-impl"));

export function PullRequestMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <Suspense
      fallback={
        <p className={cn("text-sm whitespace-pre-wrap text-secondary-foreground", className)}>
          {text}
        </p>
      }
    >
      <PullRequestMarkdownImpl text={text} className={className} />
    </Suspense>
  );
}

/** The pencil beside something the viewer may rewrite; shown on hover or focus. */
export function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <span className="flex shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
      <IconButton icon={Pencil} label={label} size="xs" onClick={onClick} />
    </span>
  );
}

/** A plain text area drawn like the house input. */
export const TEXTAREA_CLASS =
  "block w-full min-w-0 resize-y rounded border border-border bg-panel-input px-2 py-1.5 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-50";

/** Write / Preview over a text area, Save and Cancel under it. ⌘↵ saves,
 *  Escape cancels. */
export function PullRequestMarkdownEditor({
  value,
  label,
  placeholder,
  saving,
  allowEmpty = false,
  className,
  onSave,
  onCancel,
}: {
  value: string;
  label: string;
  placeholder?: string;
  saving: boolean;
  allowEmpty?: boolean;
  className?: string;
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  // The draft is taken from `value` once, when the editor opens. A refetch
  // while it is open (a poll, a focus, someone else's edit) must not wipe
  // what is being typed; it is offered instead (`base` is what the draft
  // started from).
  const [draft, setDraft] = useState(value);
  const [base, setBase] = useState(value);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const changedUpstream = value !== base && value !== draft && !saving;
  const empty = draft.trim().length === 0;
  const saveDisabled = saving || (empty && !allowEmpty);

  return (
    <div
      className={cn("space-y-2", className)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          if (!saveDisabled && !event.repeat) onSave(draft);
          return;
        }
        if (event.key === "Escape" && !saving) {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      {changedUpstream ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded border border-warning bg-warning-muted px-2 py-1.5 text-xs text-foreground"
        >
          <span className="min-w-0 flex-1">Changed on GitHub while you were editing.</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setDraft(value);
              setBase(value);
            }}
          >
            Reload
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setBase(value)}>
            Keep mine
          </Button>
        </div>
      ) : null}
      <Segmented
        aria-label="Editor mode"
        size="sm"
        value={mode}
        onValueChange={setMode}
        disabled={saving}
        options={[
          { value: "write", label: "Write" },
          { value: "preview", label: "Preview" },
        ]}
      />
      {mode === "preview" ? (
        <div className="rounded border border-border px-3 py-2">
          {empty ? (
            <p className="text-xs text-muted-foreground">Nothing to preview.</p>
          ) : (
            <PullRequestMarkdown text={draft} />
          )}
        </div>
      ) : (
        <textarea
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by the pencil, so typing is next
          autoFocus
          disabled={saving}
          value={draft}
          rows={8}
          placeholder={placeholder}
          aria-label={label}
          className={TEXTAREA_CLASS}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="outline" disabled={saveDisabled} onClick={() => onSave(draft)}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
