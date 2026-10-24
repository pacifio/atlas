import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Select } from "@/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { PRESETS, type PresetId } from "../lib/presets";
import { exportProfile } from "../lib/profile-transfer";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { ImportProfileDialog } from "./import-profile-dialog";
import { PresetIcon } from "./preset-icon";

const ATLAS_KEYS = "atlas";

const KEYMAP_OPTIONS = [
  { value: ATLAS_KEYS, label: "Atlas" },
  ...PRESETS.map((p) => ({
    value: p.id,
    label: p.label,
    icon: <PresetIcon id={p.id} className="size-3" />,
  })),
];

/** "Start from: VS Code ▾" — the editor whose shortcuts sit under the
 *  user's own changes. On the built-in Default this forks it (the store's
 *  rule), so choosing a keymap never asks for a profile first. */
export function KeymapSelect() {
  const file = useKeybindingsStore.use.file();
  const { setProfilePreset } = useKeybindingsStore.use.actions();
  const active = file.profiles.find((p) => p.id === file.activeProfileId) ?? file.profiles[0]!;
  return (
    <Select
      value={active.basedOn ?? ATLAS_KEYS}
      options={KEYMAP_OPTIONS}
      aria-label="Start from keymap"
      onValueChange={(next) =>
        setProfilePreset(active.id, next === ATLAS_KEYS ? null : (next as PresetId))
      }
    />
  );
}

type Naming = { mode: "create" | "duplicate" | "rename" } | null;

const NAMING_COPY = {
  create: { title: "New profile", action: "Create", hint: "Starts from Atlas's shortcuts." },
  duplicate: { title: "Duplicate profile", action: "Duplicate", hint: "" },
  rename: { title: "Rename profile", action: "Rename", hint: "" },
} as const;

/**
 * Which profile is live, and everything else a profile can do, behind one
 * menu. Profiles are for people who keep several keymaps; everyone else
 * never needs to see them, because editing just works.
 */
export function ProfileControls() {
  const file = useKeybindingsStore.use.file();
  const {
    setActiveProfile,
    createProfile,
    duplicateProfile,
    renameProfile,
    deleteProfile,
    resetProfile,
  } = useKeybindingsStore.use.actions();
  const active = file.profiles.find((p) => p.id === file.activeProfileId) ?? file.profiles[0]!;
  const locked = !!active.builtIn;
  const changes = Object.keys(active.bindings).length;
  const [naming, setNaming] = useState<Naming>(null);
  const [draft, setDraft] = useState("");
  const [importing, setImporting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const startNaming = (mode: NonNullable<Naming>["mode"]) => {
    setDraft(mode === "rename" ? active.name : mode === "duplicate" ? `${active.name} copy` : "");
    setNaming({ mode });
  };

  const commitName = () => {
    if (!naming) return;
    const name = draft.trim();
    if (naming.mode === "rename") renameProfile(active.id, name);
    else if (naming.mode === "duplicate") duplicateProfile(active.id, name || undefined);
    else createProfile(name || "New profile");
    setNaming(null);
  };

  return (
    <div className="flex items-center gap-1">
      {file.profiles.length > 1 && (
        <Select
          value={active.id}
          options={file.profiles.map((p) => ({ value: p.id, label: p.name }))}
          aria-label="Active keybinding profile"
          onValueChange={setActiveProfile}
        />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<IconButton icon={MoreHorizontal} size="sm" label="Profile actions" />}
        />
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem onClick={() => startNaming("create")}>New profile…</DropdownMenuItem>
          <DropdownMenuItem onClick={() => startNaming("duplicate")}>
            Duplicate “{active.name}”…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={locked} onClick={() => startNaming("rename")}>
            Rename…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() =>
              void copyText(exportProfile(active)).then((ok) =>
                ok ? toast.success("Profile copied") : toast.error("Couldn't copy the profile"),
              )
            }
          >
            Copy as JSON
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setImporting(true)}>Import a profile…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={locked || changes === 0}
            onClick={() => setConfirmReset(true)}
          >
            Reset all shortcuts…
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={locked}
            onClick={() => setConfirmDelete(true)}
          >
            Delete profile…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={naming !== null} onOpenChange={(open) => !open && setNaming(null)}>
        <DialogContent className="max-w-sm">
          {naming && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                commitName();
              }}
            >
              <DialogHeader>
                <DialogTitle>{NAMING_COPY[naming.mode].title}</DialogTitle>
                {NAMING_COPY[naming.mode].hint && (
                  <DialogDescription>{NAMING_COPY[naming.mode].hint}</DialogDescription>
                )}
              </DialogHeader>
              <Input
                autoFocus
                value={draft}
                placeholder="Profile name"
                aria-label="Profile name"
                onChange={(e) => setDraft(e.target.value)}
              />
              <DialogFooter>
                <DialogClose render={<Button variant="ghost">Cancel</Button>} />
                <Button type="submit" disabled={naming.mode === "rename" && !draft.trim()}>
                  {NAMING_COPY[naming.mode].action}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset all shortcuts?</DialogTitle>
            <DialogDescription>
              {changes === 1 ? "The one change" : `All ${changes} changes`} in “{active.name}” go
              back to its keymap's defaults.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost">Cancel</Button>} />
            <Button
              onClick={() => {
                resetProfile(active.id);
                setConfirmReset(false);
              }}
            >
              Reset shortcuts
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{active.name}”?</DialogTitle>
            <DialogDescription>
              The profile and every shortcut in it are removed. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost">Cancel</Button>} />
            <Button
              variant="destructive"
              onClick={() => {
                deleteProfile(active.id);
                setConfirmDelete(false);
              }}
            >
              Delete profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportProfileDialog open={importing} onOpenChange={setImporting} />
    </div>
  );
}
