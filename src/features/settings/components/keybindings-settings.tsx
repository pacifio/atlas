import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileJson, Keyboard, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { IconButton } from "@/ui/icon-button";
import { KbdKeys } from "@/ui/kbd";
import { Segmented } from "@/ui/segmented";
import { Hint } from "@/ui/tooltip";
import { type ActionId } from "@/features/keybindings/lib/actions";
import {
  type Combo,
  comboFromEvent,
  displayKeys,
  displayLabel,
} from "@/features/keybindings/lib/combo";
import {
  type RowFilter,
  buildRows,
  filterRows,
  groupRows,
  rowClash,
} from "@/features/keybindings/lib/keybindings-view";
import { findConflicts } from "@/features/keybindings/lib/resolve";
import { useKeybindingsStore } from "@/features/keybindings/stores/keybindings-store";
import {
  KeybindingRow,
  type Recording,
  copyRow,
} from "@/features/keybindings/components/keybinding-row";
import { KeymapSelect, ProfileControls } from "@/features/keybindings/components/keymap-controls";
import { NewKeybindingRow } from "@/features/keybindings/components/new-keybinding-row";
import { openKeybindingsFile } from "@/features/keybindings/lib/keybindings-api";
import {
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "./layout/settings-layout";

/**
 * Settings → Keybindings: an ordinary settings page. One card per category,
 * one row per command, the shortcut hard-right — click it and press the new
 * keys. The search above takes a name or a shortcut ("cmd k"), or, with the
 * keyboard toggle on, the shortcut itself.
 *
 * Profiles stay, behind the Keymap section's menu: editing never needs one,
 * because a change to the built-in Default forks it (see the store).
 */
export function KeybindingsSettings() {
  const resolved = useKeybindingsStore.use.resolved();
  const fileWarnings = useKeybindingsStore.use.warnings();
  const { removeBinding } = useKeybindingsStore.use.actions();
  const [query, setQuery] = useState("");
  const [pressing, setPressing] = useState(false);
  const [pressed, setPressed] = useState<Combo | null>(null);
  const [filter, setFilter] = useState<RowFilter>("all");
  const [selectedId, setSelectedId] = useState<ActionId | null>(null);
  const [recording, setRecording] = useState<{ id: ActionId; which: Recording } | null>(null);
  const [adding, setAdding] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const conflicts = useMemo(() => findConflicts(resolved.list), [resolved]);
  const rows = useMemo(() => buildRows(resolved), [resolved]);
  const changedCount = rows.filter((r) => r.changed).length;
  const clashCount = rows.filter((r) => rowClash(r, conflicts)).length;
  const shown = useMemo(
    () => filterRows(rows, { query, pressed: pressing ? pressed : null, filter }, conflicts),
    [rows, query, pressing, pressed, filter, conflicts],
  );
  const groups = useMemo(() => groupRows(shown), [shown]);
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  // A filter that empties out (the last clash fixed) falls back to all.
  useEffect(() => {
    if ((filter === "changed" && !changedCount) || (filter === "clashes" && !clashCount)) {
      setFilter("all");
    }
  }, [filter, changedCount, clashCount]);

  useEffect(() => {
    if (!selectedId) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-action-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const warnings = resolved.unknownPresetId
    ? [
        ...fileWarnings,
        `This profile's keymap “${resolved.unknownPresetId}” isn't in this version of Atlas; its shortcuts come from Atlas's defaults.`,
      ]
    : fileWarnings;

  const showSame = (combo: Combo) => {
    setRecording(null);
    setFilter("all");
    setQuery("");
    setPressing(true);
    setPressed(combo);
    toolbarRef.current?.scrollIntoView({ block: "nearest" });
  };

  // Only keys pressed on the list itself: a row's buttons and its portaled
  // context menu bubble here too, and act on their own row, not the selection.
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (recording || e.target !== e.currentTarget) return;
    const idx = selectedId ? flat.findIndex((r) => r.id === selectedId) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!flat.length) return;
      const next =
        e.key === "ArrowDown" ? Math.min(flat.length - 1, idx + 1) : Math.max(0, idx - 1);
      setSelectedId(flat[next]!.id);
      return;
    }
    const row = flat[idx];
    if (!row) return;
    if (e.key === "Enter") {
      e.preventDefault();
      setRecording({ id: row.id, which: row.bindings.length ? 0 : "add" });
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      removeBinding(row.id);
    } else if (e.key === "Escape") {
      setSelectedId(null);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void copyRow(row);
    }
  };

  const emptyHint =
    pressing && pressed
      ? `Nothing is bound to ${displayLabel(pressed)}.`
      : query
        ? `No command matches “${query.trim()}”.`
        : "Nothing to show.";

  return (
    <SettingsPage
      title="Keybindings"
      description="A shortcut for every command. Click one and press the keys you want."
    >
      <SettingsSection title="Keymap" action={<ProfileControls />}>
        <SettingsGroup>
          <SettingsRow
            anchor="keymap"
            title="Start from"
            description="Use another editor's shortcuts underneath your own changes."
            control={<KeymapSelect />}
          />
        </SettingsGroup>
      </SettingsSection>

      <div className="flex flex-col gap-3">
        <div
          ref={toolbarRef}
          className="sticky top-0 z-10 -mx-1 flex scroll-mt-4 flex-wrap items-center gap-2 bg-background px-1 py-2"
        >
          <SearchField
            query={query}
            onQuery={setQuery}
            pressing={pressing}
            onPressing={(on) => {
              setPressing(on);
              setPressed(null);
            }}
            pressed={pressed}
            onPressed={setPressed}
          />
          {(changedCount > 0 || clashCount > 0) && (
            <Segmented
              size="sm"
              aria-label="Show"
              value={filter}
              onValueChange={setFilter}
              options={[
                { value: "all", label: "All" },
                ...(changedCount
                  ? [{ value: "changed" as const, label: `Changed ${changedCount}` }]
                  : []),
                ...(clashCount
                  ? [{ value: "clashes" as const, label: `Clashes ${clashCount}` }]
                  : []),
              ]}
            />
          )}
          <Button variant="outline" disabled={adding} onClick={() => setAdding(true)}>
            <Icon icon={Plus} size="xs" />
            Add keybinding
          </Button>
          <Hint label="Open keybindings.json">
            <IconButton
              icon={FileJson}
              variant="outline"
              size="md"
              label="Open keybindings.json"
              onClick={() => void openKeybindingsFile()}
            />
          </Hint>
        </div>

        {warnings.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-secondary-foreground">
            <Icon icon={AlertTriangle} size="xs" className="mt-0.5 text-warning" />
            <div className="flex flex-col gap-0.5">
              {warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          </div>
        )}

        <div
          ref={listRef}
          tabIndex={0}
          role="group"
          aria-label="Keybindings"
          onKeyDown={onListKeyDown}
          className="group/list flex flex-col gap-8 outline-none"
        >
          {adding && (
            <SettingsGroup>
              <NewKeybindingRow
                onDone={(saved) => {
                  setAdding(false);
                  if (!saved) return;
                  // Show where it landed.
                  setFilter("all");
                  setQuery("");
                  setPressing(false);
                  setSelectedId(saved);
                }}
              />
            </SettingsGroup>
          )}
          {groups.length === 0 && (
            <SettingsGroup>
              <SettingsNote>{emptyHint}</SettingsNote>
            </SettingsGroup>
          )}
          {groups.map((g) => (
            <SettingsSection key={g.title} title={g.title}>
              <SettingsGroup>
                {g.rows.map((row) => (
                  <KeybindingRow
                    key={row.id}
                    row={row}
                    conflicts={conflicts}
                    selected={row.id === selectedId}
                    recording={recording?.id === row.id ? recording.which : null}
                    onSelect={() => setSelectedId(row.id)}
                    onRecord={(which) => {
                      setSelectedId(row.id);
                      setRecording(which === null ? null : { id: row.id, which });
                      // Back to the list, so ↑↓ keep working after a save.
                      if (which === null) listRef.current?.focus({ preventScroll: true });
                    }}
                    onShowSame={showSame}
                  />
                ))}
              </SettingsGroup>
            </SettingsSection>
          ))}
          {!query && !pressing && filter === "all" && resolved.unknownActionIds.length > 0 && (
            <UnknownCommands ids={resolved.unknownActionIds} />
          )}
        </div>
      </div>
    </SettingsPage>
  );
}

/**
 * Search by name or by shortcut. With the keyboard toggle on, the field
 * takes a pressed chord instead of text and lists what it is bound to —
 * the quickest answer to "is ⌥⌘J free?".
 */
function SearchField({
  query,
  onQuery,
  pressing,
  onPressing,
  pressed,
  onPressed,
}: {
  query: string;
  onQuery: (q: string) => void;
  pressing: boolean;
  onPressing: (on: boolean) => void;
  pressed: Combo | null;
  onPressed: (c: Combo | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pressing) inputRef.current?.focus();
  }, [pressing]);
  const clearable = pressing ? pressed !== null : query !== "";

  return (
    <div
      className={cn(
        "flex h-control-md min-w-60 flex-1 items-center gap-1.5 rounded-md border bg-panel-input pr-0.5 pl-2",
        "transition-colors duration-fast ease-out-strong",
        pressing ? "border-border-strong" : "border-border focus-within:border-border-strong",
      )}
    >
      <Icon icon={pressing ? Keyboard : Search} size="xs" className="text-muted-foreground" />
      {pressing && pressed && <KbdKeys keys={displayKeys(pressed)} />}
      {pressing ? (
        <input
          ref={inputRef}
          readOnly
          aria-label="Press a shortcut to find it"
          value=""
          placeholder={pressed ? "" : "Press a shortcut to see what it does…"}
          onKeyDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const bare = !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey;
            if (e.key === "Escape" && bare) return onPressing(false);
            if (e.key === "Backspace" && bare) return onPressed(null);
            const combo = comboFromEvent(e.nativeEvent);
            if (combo) onPressed(combo);
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-xs caret-transparent outline-none placeholder:text-muted-foreground"
        />
      ) : (
        <input
          ref={inputRef}
          aria-label="Search keybindings"
          value={query}
          placeholder="Search by name or shortcut, like “cmd k”"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              onQuery("");
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      )}
      {clearable && (
        <IconButton
          icon={X}
          size="xs"
          label="Clear search"
          onClick={() => (pressing ? onPressed(null) : onQuery(""))}
        />
      )}
      <Hint label={pressing ? "Search by name instead" : "Search by pressing a shortcut"}>
        <IconButton
          icon={Keyboard}
          size="xs"
          label="Search by pressing a shortcut"
          aria-pressed={pressing}
          onClick={() => onPressing(!pressing)}
        />
      </Hint>
    </div>
  );
}

function UnknownCommands({ ids }: { ids: string[] }) {
  const { removeUnknown } = useKeybindingsStore.use.actions();
  return (
    <SettingsSection
      title="Unknown commands"
      description="In keybindings.json, but not in this version of Atlas. Kept unless you remove them."
    >
      <SettingsGroup>
        {ids.map((id) => (
          <SettingsRow
            key={id}
            title={<span className="font-mono">{id}</span>}
            control={
              <IconButton
                icon={X}
                size="sm"
                label={`Remove ${id}`}
                onClick={() => removeUnknown(id)}
              />
            }
          />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}
