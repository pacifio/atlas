// Add or edit a project script: a name, a glyph, the command. Saving writes
// the whole list back to the project's `.atlas/config.toml`
// (`project_scripts_save`); an existing script can also be deleted here.
//
// Mounted once beside the overlay, open while the store holds a request.

import { useId, useState } from "react";
import { toast } from "sonner";

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
import { Select } from "@/ui/select";

import {
  nextProjectScriptId,
  useProjectScripts,
  useSaveProjectScripts,
} from "../lib/project-scripts";
import type { ProjectScript, ProjectScriptIcon } from "../lib/session-context-api";
import { useSessionDetailsStore, type ScriptEditorRequest } from "../stores/session-details-store";
import { PROJECT_SCRIPT_ICONS, ProjectScriptGlyph } from "./project-script-icons";

const ICON_OPTIONS = PROJECT_SCRIPT_ICONS.map((entry) => ({
  value: entry.value,
  label: entry.label,
  icon: <ProjectScriptGlyph icon={entry.value} />,
}));

export function ProjectScriptDialogHost() {
  const request = useSessionDetailsStore.use.scriptEditor();
  if (!request) return null;
  // Keyed so a second request starts from its own script, not the last form.
  return (
    <ProjectScriptDialog
      key={`${request.projectPath}:${request.script?.id ?? "new"}`}
      request={request}
    />
  );
}

function ProjectScriptDialog({ request }: { request: ScriptEditorRequest }) {
  const id = useId();
  const { projectPath, script } = request;
  const scripts = useProjectScripts(projectPath).data ?? [];
  const save = useSaveProjectScripts();
  const close = () => useSessionDetailsStore.getState().actions.editScript(null);
  const [name, setName] = useState(script?.name ?? "");
  const [icon, setIcon] = useState<ProjectScriptIcon>(script?.icon ?? "play");
  const [command, setCommand] = useState(script?.command ?? "");
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0 && command.trim().length > 0;

  const write = async (next: ProjectScript[], done: string) => {
    setBusy(true);
    try {
      await save(projectPath, next);
      toast.success(done);
      close();
    } catch (e) {
      toast.error("Could not save the project's scripts", { description: String(e) });
      setBusy(false);
    }
  };

  const submit = () => {
    if (!valid || busy) return;
    const edited: ProjectScript = {
      id:
        script?.id ??
        nextProjectScriptId(
          name,
          scripts.map((s) => s.id),
        ),
      name: name.trim(),
      icon,
      command: command.trim(),
    };
    const next = script
      ? scripts.map((s) => (s.id === script.id ? edited : s))
      : [...scripts, edited];
    void write(next, script ? `Saved ${edited.name}` : `Added ${edited.name}`);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-md">
        <form
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{script ? "Edit project script" : "Add project script"}</DialogTitle>
            <DialogDescription>
              Runs in a terminal at the project root. Saved in the project's .atlas/config.toml, so
              everyone working on it gets the same scripts.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <label
              className="flex min-w-0 flex-col gap-1.5 text-xs text-secondary-foreground"
              htmlFor={`${id}-name`}
            >
              Name
              <Input
                id={`${id}-name`}
                autoFocus
                required
                placeholder="Dev server"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="flex min-w-0 flex-col gap-1.5 text-xs text-secondary-foreground">
              Icon
              <Select
                aria-label="Icon"
                value={icon}
                options={ICON_OPTIONS}
                onValueChange={setIcon}
              />
            </div>
          </div>
          <label
            className="flex min-w-0 flex-col gap-1.5 text-xs text-secondary-foreground"
            htmlFor={`${id}-command`}
          >
            Command
            <textarea
              id={`${id}-command`}
              required
              rows={3}
              spellCheck={false}
              placeholder="bun run dev"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              className="w-full resize-none rounded border border-border bg-panel-input p-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-border-strong"
            />
          </label>
          <DialogFooter>
            {script ? (
              <Button
                variant="ghost"
                className="sm:me-auto"
                disabled={busy}
                onClick={() =>
                  void write(
                    scripts.filter((s) => s.id !== script.id),
                    `Deleted ${script.name}`,
                  )
                }
              >
                Delete
              </Button>
            ) : null}
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {script ? "Save" : "Add script"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
