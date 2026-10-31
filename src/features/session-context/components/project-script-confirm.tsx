// The first run of a project script, or its first run since its command
// changed: the whole command, where it will run, and a choice.
//
// The scripts come from the project's `.atlas/config.toml`, which travels with
// the repository: a clone or a pull request can bring a script nobody here
// wrote, under a friendly name. So a script whose command has not been
// approved shows that command in full before it is typed into a shell, and
// "Run" records the approval (`project_scripts_approve`) so the next click
// just runs it. Scripts added in Atlas's own editor come back approved.
//
// Mounted once beside the overlay, open while the store holds a request.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";

import { approveAndRunProjectScript, projectScriptsKey } from "../lib/project-scripts";
import { useSessionDetailsStore, type ScriptConfirmRequest } from "../stores/session-details-store";

export function ProjectScriptConfirmHost() {
  const request = useSessionDetailsStore.use.scriptConfirm();
  if (!request) return null;
  return (
    <ProjectScriptConfirm
      key={`${request.projectPath}:${request.script.id}:${request.script.command}`}
      request={request}
    />
  );
}

export function ProjectScriptConfirm({ request }: { request: ScriptConfirmRequest }) {
  const { projectPath, script, cwd } = request;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const close = () => useSessionDetailsStore.getState().actions.confirmScript(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    const ran = await approveAndRunProjectScript(projectPath, script, cwd);
    if (ran) {
      void client.invalidateQueries({ queryKey: projectScriptsKey(projectPath) });
      close();
    } else {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Run {script.name}?</DialogTitle>
          <DialogDescription>
            This script comes from the project's .atlas/config.toml, which anyone who can change the
            repository can edit. Check the command before you run it. Atlas asks again if it
            changes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-1.5 text-xs text-secondary-foreground">
          Command
          <pre
            aria-label="Command"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-panel-input p-2 font-mono text-xs text-foreground select-text"
          >
            {script.command}
          </pre>
        </div>
        <p className="min-w-0 truncate text-xs text-muted-foreground" title={cwd}>
          Runs in a terminal at <span className="font-mono">{cwd}</span>
        </p>
        <DialogFooter>
          {/* Focus starts on Cancel: Enter must not run a command unread. */}
          <Button variant="outline" autoFocus onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void run()}>
            Run script
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
