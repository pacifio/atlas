import { useRef, type FormEvent } from "react";
import {
  CloudUpload,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Pencil,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  SplitButton,
} from "@tryatlas/design";

export type ShipChoice = "commit" | "commit_push" | "commit_push_pr";

export interface ShipChoiceItem {
  choice: ShipChoice;
  label: string;
  /** Why it is off; `null` when it can run. */
  disabledReason: string | null;
  shortcut?: string;
}

export interface PrDraftFields {
  title: string;
  /** What the title falls back to: the commit summary. */
  titlePlaceholder: string;
  base: string;
  /** The branch the work moves onto first, when it needs one; else `null`. */
  newBranch: string | null;
  /** The branch it is on, for the "needs a branch" note. */
  currentBranch: string | null;
}

export interface ShipButtonViewProps {
  primary: ShipChoiceItem;
  items: ShipChoiceItem[];
  /** Something is running: the primary shows a spinner and nothing starts. */
  busy: boolean;
  busyLabel: string;
  onRun: (choice: ShipChoice) => void;
  /** The pull request popover. */
  draftOpen: boolean;
  onDraftOpenChange: (open: boolean) => void;
  draft: PrDraftFields;
  onDraftChange: (patch: Partial<Pick<PrDraftFields, "title" | "base" | "newBranch">>) => void;
  /** Whether the PR variant can run, for the popover's own button. */
  prDisabledReason: string | null;
}

const ICON: Record<ShipChoice, LucideIcon> = {
  commit: GitCommitHorizontal,
  commit_push: CloudUpload,
  commit_push_pr: GitPullRequestArrow,
};

/**
 * The commit box's action: the primary choice beside a ⌄ listing every
 * choice, each disabled with its reason, and "Edit pull request…" — a small
 * popover on the same anchor for the title, the base and, from the default
 * branch, the new branch. Renders from its props alone.
 */
export function ShipButtonView({
  primary,
  items,
  busy,
  busyLabel,
  onRun,
  draftOpen,
  onDraftOpenChange,
  draft,
  onDraftChange,
  prDisabledReason,
}: ShipButtonViewProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (prDisabledReason || busy) return;
    onDraftOpenChange(false);
    onRun("commit_push_pr");
  };

  return (
    <>
      <SplitButton
        ref={groupRef}
        label="Commit actions"
        icon={ICON[primary.choice]}
        onClick={() => onRun(primary.choice)}
        disabledReason={primary.disabledReason}
        busy={busy}
        busyLabel={busyLabel}
        menuLabel="More commit actions"
        menu={
          <>
            {items.map((item) => {
              const Icon = ICON[item.choice];
              return (
                <DropdownMenuItem
                  key={item.choice}
                  disabled={item.disabledReason !== null}
                  title={item.disabledReason ?? undefined}
                  onClick={() => onRun(item.choice)}
                >
                  <Icon />
                  {item.label}
                  {item.shortcut && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onDraftOpenChange(true)}>
              <Pencil />
              Edit pull request…
            </DropdownMenuItem>
          </>
        }
      >
        {primary.label}
      </SplitButton>

      <Popover open={draftOpen} onOpenChange={onDraftOpenChange}>
        <PopoverContent anchor={groupRef} align="end" side="top" className="w-80">
          <form onSubmit={submit} className="space-y-3">
            <PopoverHeader>
              <PopoverTitle>Pull request</PopoverTitle>
              <PopoverDescription>
                Commits, pushes and opens it with these. The body is the commit description.
              </PopoverDescription>
            </PopoverHeader>
            <div className="space-y-1">
              <Label htmlFor="ship-pr-title">Title</Label>
              <Input
                id="ship-pr-title"
                autoFocus
                value={draft.title}
                placeholder={draft.titlePlaceholder || "The commit summary"}
                onChange={(e) => onDraftChange({ title: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ship-pr-base">Base</Label>
              <Input
                id="ship-pr-base"
                className="font-mono"
                value={draft.base}
                placeholder="The repository's default branch"
                onChange={(e) => onDraftChange({ base: e.target.value })}
              />
            </div>
            {draft.newBranch !== null && (
              <div className="space-y-1">
                <Label htmlFor="ship-pr-branch">New branch</Label>
                <Input
                  id="ship-pr-branch"
                  className="font-mono"
                  value={draft.newBranch}
                  onChange={(e) => onDraftChange({ newBranch: e.target.value })}
                />
                <p className="caption">
                  {draft.currentBranch ? `${draft.currentBranch} is` : "This is"} the default
                  branch, so the work moves onto this branch first.
                </p>
              </div>
            )}
            <div className="flex items-center justify-end gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onDraftOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={busy || prDisabledReason !== null}
                title={prDisabledReason ?? undefined}
              >
                <GitPullRequestArrow size={12} />
                Commit, push & PR
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </>
  );
}
