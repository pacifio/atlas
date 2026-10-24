// "View log" on a check: the end of its job's log around the first error,
// read from GitHub only when asked for, in a dialog over the tab. The Checks
// row mounts it with one line; a check with no Actions job (a commit status,
// a third-party app, a run still going) shows nothing.

import { useState } from "react";
import { toast } from "sonner";
import { Copy, ExternalLink, ScrollText } from "lucide-react";

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog";

import { prErrorMessage } from "../lib/pr-errors";
import { hasCheckLog, useCheckLog } from "../lib/pull-request-check-log";
import type { PrCheck } from "../lib/pull-requests-types";
import { usePullRequestScope } from "./pull-request-context";

export function CheckLogButton({ check }: { check: PrCheck }) {
  const { repoPath, number } = usePullRequestScope();
  const [open, setOpen] = useState(false);
  const url = check.url ?? "";
  const log = useCheckLog(repoPath, number, url, open && hasCheckLog(check));
  if (!hasCheckLog(check)) return null;
  const title = check.workflow ? `${check.workflow} / ${check.name}` : check.name;

  const copy = () => {
    if (!log.data) return;
    void navigator.clipboard
      .writeText(log.data.text)
      .then(() => toast.success("Log copied"))
      .catch(() => toast.error("Could not copy the log"));
  };

  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <ScrollText aria-hidden className="size-3" />
        View log
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(56rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {log.data
                ? log.data.foundError
                  ? `The lines around the first error${log.data.truncated ? "; the rest of the log is left out" : ""}.`
                  : `The end of the log; the runner marked no error${log.data.truncated ? "" : " and nothing is left out"}.`
                : "The end of this check's log, around its first error."}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] min-h-24 overflow-auto rounded border border-border bg-background">
            {log.isPending ? (
              <p className="p-3 text-xs text-muted-foreground">Reading the log…</p>
            ) : log.error ? (
              <p role="alert" className="p-3 text-xs text-destructive">
                {prErrorMessage(log.error)}
              </p>
            ) : log.data && log.data.text.length > 0 ? (
              <pre className="p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words text-secondary-foreground">
                {log.data.text}
              </pre>
            ) : (
              <p className="p-3 text-xs text-muted-foreground">The log is empty.</p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" disabled={!log.data} onClick={copy}>
              <Copy aria-hidden className="size-3" />
              Copy
            </Button>
            {check.url ? (
              <Button size="xs" variant="outline" onClick={() => openPullRequest(check.url!)}>
                <ExternalLink aria-hidden className="size-3" />
                Open on GitHub
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
