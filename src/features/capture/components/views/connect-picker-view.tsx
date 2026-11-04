import { Check, ChevronDown, Lock } from "lucide-react";

import { cn } from "@/lib/utils";

import type { ConnectOptions, RemoteWorkspace } from "../../types";
import { GhostButton, PrimaryButton } from "./controls";
import { GROUP } from "./styles";
import {
  Button,
  Callout,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
} from "@tryatlas/design";

/** Connect is unavailable: the reason, in place of the picker. */
export function ConnectLockedView({ reason }: { reason: string }) {
  return (
    <p className={cn(GROUP, "flex items-start gap-1.5 text-xs text-muted-foreground")}>
      <Lock size={11} className="mt-px shrink-0" />
      {reason}
    </p>
  );
}

/** The Organisation's Projects as a dropdown, plus the actions. */
export function ConnectPickerView({
  options,
  listError,
  workspaces,
  project,
  selected,
  excludeId,
  busy,
  primaryLabel,
  onSelect,
  onCancel,
  onSubmit,
}: {
  /** `undefined` while listing, `null` once the listing failed. */
  options: ConnectOptions | null | undefined;
  listError: string | null;
  /** The listing minus `excludeId`. */
  workspaces: RemoteWorkspace[];
  /** The selected entry of `workspaces`, if any. */
  project: RemoteWorkspace | undefined;
  selected: string | null;
  excludeId: string | null;
  busy: boolean;
  primaryLabel: string;
  onSelect: (id: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-2">
      {options === undefined ? (
        <p className="flex items-center gap-1.5 py-2 text-xs text-muted-foreground">
          <Spinner size="xs" label="" />
          Fetching this Organization's Projects…
        </p>
      ) : options === null ? (
        <Callout tone="warning" icon={false}>
          {listError
            ? `Could not list this Organization's Projects: ${listError}`
            : "Could not reach the server. Check the connection and reopen this tab."}
        </Callout>
      ) : workspaces.length === 0 ? (
        <p className={cn(GROUP, "text-xs text-muted-foreground")}>
          {excludeId
            ? "This Organization has no other Projects to sync to."
            : "This Organization has no Projects yet. Create one from the Create tab instead."}
        </p>
      ) : (
        <>
          {options.warning && (
            <Callout tone="warning" icon={false}>
              {options.warning}
            </Callout>
          )}
          {/* A dropdown rather than an inline list: the Organisation's Project
           *  count is unbounded and unpaged, and a scroller of them pushed the
           *  Connect button off the popover. The trigger states the current
           *  pick, which is the only part that has to be visible at rest. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="sm" />}
              className="w-full justify-between text-left"
              aria-label="Project to connect to"
            >
              <span className="min-w-0 flex-1 truncate">
                {project ? (
                  <span className="font-mono text-xs text-foreground">{project.slug}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">Choose a Project…</span>
                )}
              </span>
              <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-[220px] w-(--anchor-width)">
              {workspaces.map((remote) => (
                <DropdownMenuItem
                  key={remote.id}
                  onClick={() => onSelect(remote.id)}
                  className="items-start"
                >
                  <Check
                    size={11}
                    className={cn(
                      "mt-0.5 shrink-0",
                      selected === remote.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">{remote.slug}</span>
                    {remote.gitUrl && (
                      <span className="block truncate text-2xs text-muted-foreground">
                        {remote.gitUrl}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
        <PrimaryButton busy={busy} disabled={!project} onClick={onSubmit} label={primaryLabel} />
      </div>
    </div>
  );
}
