// The project's scripts, as one row.
//
// No scripts: "+ Add project script", which opens the editor. Otherwise a
// split: the main button runs the script last run here (else the first) in a
// terminal tab where the session works (`cwd`: the project root, or a pull
// request session's worktree); the ▾ lists every script — click to run, the
// pencil to edit — then "Add project script".
//
// Every script shows its command, in monospace and cut to one line: a name
// alone ("Setup") says nothing about what a click types into a shell. One
// whose command has not been approved asks first, showing all of it
// (`project-script-confirm.tsx`).
//
// The editor is a dialog the store holds (`editScript`), mounted outside the
// popover, so it survives the popover closing as focus moves into it.

import { Pencil, Plus } from "lucide-react";

import { DropdownMenuItem, DropdownMenuSeparator } from "@/ui/dropdown-menu";

import {
  commandSummary,
  preferredProjectScriptId,
  primaryProjectScript,
  runProjectScript,
  useProjectScripts,
} from "../lib/project-scripts";
import { useSessionDetailsStore } from "../stores/session-details-store";
import { DetailsRow, DetailsSplit, RowIcon, RowLabel } from "./details-rows";
import { ProjectScriptGlyph } from "./project-script-icons";

export function ProjectScriptsRow({
  projectPath,
  cwd = projectPath,
}: {
  projectPath: string;
  /** Where a script runs. */
  cwd?: string;
}) {
  const scripts = useProjectScripts(projectPath).data ?? [];
  const editScript = useSessionDetailsStore.use.actions().editScript;
  const primary = primaryProjectScript(scripts, preferredProjectScriptId(projectPath));

  if (!primary) {
    return (
      <DetailsRow onClick={() => editScript({ projectPath, script: null })}>
        <RowIcon icon={Plus} />
        <RowLabel>Add project script</RowLabel>
      </DetailsRow>
    );
  }

  return (
    <DetailsSplit
      title={primary.command}
      onClick={() => runProjectScript(projectPath, primary, cwd)}
      menuLabel="Project scripts"
      menu={
        <>
          {scripts.map((script) => (
            <DropdownMenuItem
              key={script.id}
              title={script.command}
              onClick={() => runProjectScript(projectPath, script, cwd)}
            >
              <ProjectScriptGlyph icon={script.icon} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{script.name}</span>
                <span className="truncate font-mono text-2xs text-muted-foreground">
                  {commandSummary(script.command)}
                </span>
              </span>
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Edit ${script.name}`}
                className="-me-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-element-active hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  editScript({ projectPath, script });
                }}
              >
                <Pencil className="size-3" />
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => editScript({ projectPath, script: null })}>
            <Plus />
            Add project script
          </DropdownMenuItem>
        </>
      }
    >
      <ProjectScriptGlyph icon={primary.icon} muted />
      <RowLabel>{primary.name}</RowLabel>
      <span className="min-w-0 max-w-1/2 shrink truncate font-mono text-2xs text-muted-foreground">
        {commandSummary(primary.command)}
      </span>
    </DetailsSplit>
  );
}
