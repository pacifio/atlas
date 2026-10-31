// Create PR: the title and body the branch would open with, editable, then
// `gh pr create`. Opened by `startCreatePr` once the branch is on the remote;
// mounted once beside the overlay, open while the store holds a request.

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { toast } from "sonner";

import { prErrorMessage, classifyPrError } from "@/features/pull-requests/lib/pr-errors";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";

import { submitCreatePr } from "../lib/create-pr";
import { useSessionDetailsStore, type CreatePrRequest } from "../stores/session-details-store";

export function CreatePrDialogHost() {
  const request = useSessionDetailsStore.use.createPr();
  if (!request) return null;
  return (
    <CreatePrDialog
      key={`${request.projectPath}:${request.prefill.headBranch ?? ""}`}
      request={request}
    />
  );
}

function CreatePrDialog({ request }: { request: CreatePrRequest }) {
  const id = useId();
  const client = useQueryClient();
  const { projectPath, prefill } = request;
  const [title, setTitle] = useState(prefill.title);
  const [body, setBody] = useState(prefill.body);
  const [draft, setDraft] = useState(request.draft);
  const [busy, setBusy] = useState(false);
  const close = () => useSessionDetailsStore.getState().actions.requestCreatePr(null);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await submitCreatePr(
        client,
        projectPath,
        { title: title.trim(), body, base: prefill.baseBranch, draft },
        request.sessionId,
      );
      close();
    } catch (raw) {
      toast.error("Could not open the pull request", {
        description: prErrorMessage(classifyPrError(raw)),
      });
      setBusy(false);
    }
  };

  const commits = `${prefill.commitCount} commit${prefill.commitCount === 1 ? "" : "s"}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <form
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{draft ? "Create draft pull request" : "Create pull request"}</DialogTitle>
            <DialogDescription>
              <span className="flex min-w-0 items-center gap-1.5">
                <GitBranch size={14} aria-hidden className="shrink-0" />
                <span className="min-w-0 truncate font-mono">
                  {prefill.headBranch} → {prefill.baseBranch ?? "default branch"}
                </span>
                <span className="shrink-0 text-muted-foreground">· {commits}</span>
              </span>
            </DialogDescription>
          </DialogHeader>
          <label
            className="flex min-w-0 flex-col gap-1.5 text-xs text-secondary-foreground"
            htmlFor={`${id}-title`}
          >
            Title
            <Input
              id={`${id}-title`}
              autoFocus
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label
            className="flex min-w-0 flex-col gap-1.5 text-xs text-secondary-foreground"
            htmlFor={`${id}-body`}
          >
            Description
            <textarea
              id={`${id}-body`}
              rows={8}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              className="w-full resize-y rounded border border-border bg-panel-input p-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-border-strong"
            />
          </label>
          <label
            className="flex items-center gap-2 text-xs text-secondary-foreground"
            htmlFor={`${id}-draft`}
          >
            <Switch id={`${id}-draft`} size="sm" checked={draft} onCheckedChange={setDraft} />
            Open as a draft
          </label>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || busy}>
              {busy ? "Opening…" : draft ? "Create draft PR" : "Create PR"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
