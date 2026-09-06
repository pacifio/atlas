import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  Copy,
  FileJson,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { openKeybindingsFile } from "../lib/keybindings-api";
import { useKeybindingsStore } from "../stores/keybindings-store";

// Same recipe as the account menu so every Atlas dropdown reads alike.
const CONTENT_CLASS =
  "z-[var(--z-max)] min-w-[200px] max-w-[280px] rounded-md border border-[var(--border-default)] " +
  "bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] py-1";
const ITEM_CLASS =
  "flex items-center gap-2 px-3 h-[26px] text-[11px] cursor-pointer outline-none " +
  "text-[var(--text-secondary)] data-[highlighted]:bg-[var(--bg-hover)] " +
  "data-[highlighted]:text-[var(--text-primary)]";

/** The three ways the inline name field is used. */
type NamingMode = "create" | "duplicate" | "rename";

const NAMING_PLACEHOLDER: Record<NamingMode, string> = {
  create: "Name this profile…",
  duplicate: "Name the copy…",
  rename: "Profile name",
};

/** What an unnamed new profile falls back to when Enter is pressed on an
 *  empty field — the placeholder promises a profile, so make one. */
const DEFAULT_NEW_NAME = "New profile";

/**
 * The 29px header of the keybindings editor: which profile is live, and the
 * profile-level operations. The built-in Default profile is locked — its
 * edit buttons are disabled with a "Duplicate to edit" hint rather than
 * hidden, so the affordance is discoverable.
 */
export function ProfileBar() {
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
  const overrideCount = Object.keys(active.bindings).length;

  // One inline input serves all three ways a profile gets a name: renaming an
  // existing one, and naming a new/duplicated one BEFORE it exists. Creating
  // first and renaming after would litter the list with "New profile 3".
  const [naming, setNaming] = useState<{ mode: NamingMode; sourceId: string } | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Set while a dropdown item is opening the input: Radix restores focus to
  // its trigger on close, which would pull it straight back out of the field.
  const openingInput = useRef(false);

  const startNaming = (mode: NamingMode, sourceId = active.id) => {
    const source = file.profiles.find((p) => p.id === sourceId) ?? active;
    setDraft(mode === "rename" ? source.name : mode === "duplicate" ? `${source.name} copy` : "");
    setNaming({ mode, sourceId });
  };

  useEffect(() => {
    if (!naming) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
      openingInput.current = false;
    });
    return () => cancelAnimationFrame(id);
  }, [naming]);

  const commitName = () => {
    if (!naming) return;
    const name = draft.trim();
    if (naming.mode === "rename") renameProfile(naming.sourceId, name);
    else if (naming.mode === "duplicate") duplicateProfile(naming.sourceId, name || undefined);
    else createProfile(name || DEFAULT_NEW_NAME);
    setNaming(null);
  };

  return (
    <div className="flex h-[29px] shrink-0 items-center gap-1 border-b border-border-default px-2">
      {naming ? (
        <div className="flex items-center gap-1.5 px-2">
          <span className="text-[11px] font-normal text-text-tertiary">Profile</span>
          <input
            ref={inputRef}
            value={draft}
            placeholder={NAMING_PLACEHOLDER[naming.mode]}
            onChange={(e) => setDraft(e.target.value)}
            // Empty means "never mind" — blurring an untouched field must not
            // conjure a profile the user never named.
            onBlur={() => (draft.trim() ? commitName() : setNaming(null))}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") setNaming(null);
              e.stopPropagation();
            }}
            className={cn(
              "h-6 w-[200px] rounded-md border border-border-strong bg-bg-elevated px-2 text-[11px]",
              "text-text-primary outline-none placeholder:text-text-muted",
            )}
          />
        </div>
      ) : (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium",
                "text-text-primary hover:bg-bg-hover transition-colors cursor-pointer",
              )}
            >
              <span className="text-text-tertiary font-normal">Profile</span>
              <span className="max-w-[180px] truncate">{active.name}</span>
              {locked && <Lock size={10} className="text-text-tertiary" />}
              <ChevronDown size={11} className="text-text-tertiary" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={4}
              className={CONTENT_CLASS}
              onCloseAutoFocus={(e) => {
                if (openingInput.current) e.preventDefault();
              }}
            >
              {file.profiles.map((p) => (
                <DropdownMenu.Item
                  key={p.id}
                  onSelect={() => setActiveProfile(p.id)}
                  className={ITEM_CLASS}
                >
                  <span className="flex w-3 justify-center">
                    {p.id === active.id && <Check size={11} />}
                  </span>
                  <span className="flex-1 truncate">{p.name}</span>
                  {p.builtIn ? (
                    <Lock size={10} className="text-text-tertiary" />
                  ) : (
                    <span className="text-[9.5px] tabular-nums text-text-muted">
                      {Object.keys(p.bindings).length || ""}
                    </span>
                  )}
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />
              <DropdownMenu.Item
                onSelect={() => {
                  openingInput.current = true;
                  startNaming("create");
                }}
                className={ITEM_CLASS}
              >
                <span className="flex w-3 justify-center">
                  <Plus size={11} />
                </span>
                <span className="flex-1">New profile…</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => {
                  openingInput.current = true;
                  startNaming("duplicate");
                }}
                className={ITEM_CLASS}
              >
                <span className="flex w-3 justify-center">
                  <Copy size={10} />
                </span>
                <span className="flex-1 truncate">Duplicate “{active.name}”…</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}

      {!locked && overrideCount > 0 && (
        <span className="text-[10px] tabular-nums text-text-tertiary">
          {overrideCount} {overrideCount === 1 ? "override" : "overrides"}
        </span>
      )}

      <div className="ml-auto flex items-center gap-0.5">
        <IconButton label="New profile…" onClick={() => startNaming("create")}>
          <Plus size={13} />
        </IconButton>
        <IconButton label={`Duplicate “${active.name}”…`} onClick={() => startNaming("duplicate")}>
          <Copy size={12} />
        </IconButton>
        <IconButton
          label={locked ? "Default can't be renamed — duplicate to edit" : "Rename profile"}
          disabled={locked}
          onClick={() => startNaming("rename")}
        >
          <Pencil size={12} />
        </IconButton>
        <IconButton
          label={
            locked
              ? "Default can't be reset — it has no overrides"
              : "Reset all bindings in this profile"
          }
          disabled={locked || overrideCount === 0}
          onClick={() => resetProfile(active.id)}
        >
          <RotateCcw size={12} />
        </IconButton>
        <IconButton
          label={locked ? "Default can't be deleted" : "Delete profile"}
          disabled={locked}
          onClick={() => deleteProfile(active.id)}
        >
          <Trash2 size={12} />
        </IconButton>
        <span className="mx-1 h-3.5 w-px bg-border-default" />
        <IconButton label="Open keybindings.json" onClick={() => void openKeybindingsFile()}>
          <FileJson size={12} />
        </IconButton>
      </div>
    </div>
  );
}

export function IconButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
            active
              ? "bg-bg-selected text-text-primary"
              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
            disabled ? "opacity-35 cursor-not-allowed" : "cursor-pointer",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
