import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { useKeybindingsStore } from "../stores/keybindings-store";

/**
 * Paste a profile someone copied with "Copy as JSON". A textarea rather than
 * reading the clipboard: WKWebView gates `clipboard.readText` behind a native
 * paste prompt, and a visible field lets the user see what they're importing.
 */
export function ImportProfileDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { importProfile } = useKeybindingsStore.use.actions();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = (next: boolean) => {
    if (!next) {
      setText("");
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = () => {
    const result = importProfile(text);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const notes = [
      result.unknownPresetId && `preset “${result.unknownPresetId}” isn't in this Atlas`,
      result.unknownActionIds.length > 0 &&
        `${result.unknownActionIds.length} command(s) this Atlas doesn't have were kept`,
    ].filter(Boolean);
    toast.success(`Imported “${result.profile.name}”`, {
      description: notes.length ? notes.join("; ") : undefined,
    });
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a keybinding profile</DialogTitle>
          <DialogDescription>
            Paste the JSON from “Copy as JSON”. It's added as a new profile and made active.
          </DialogDescription>
        </DialogHeader>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            // Typing here must not reach the table's own key handling behind it.
            e.stopPropagation();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          spellCheck={false}
          placeholder={'{\n  "atlasKeybindings": 1,\n  "name": "…",\n  "bindings": {}\n}'}
          className={cn(
            "h-48 w-full resize-none rounded-md border bg-background p-2 font-mono text-xs",
            "text-foreground outline-none placeholder:text-muted-foreground",
            error ? "border-error" : "border-border",
          )}
        />
        {error && <p className="text-xs text-error">Can't import: {error}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!text.trim()} onClick={submit}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
