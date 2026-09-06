import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  ACTIONS,
  type ActionDef,
  type ActionId,
  CATEGORY_ORDER,
  WHEN_LABELS,
} from "../lib/actions";
import { type Combo, comboEquals, displayLabel } from "../lib/combo";
import { findConflicts } from "../lib/resolve";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { KeybindingRecorder, type RecorderMode } from "./keybinding-recorder";
import { KeybindingsSearch, type SearchState } from "./keybindings-search";
import { KeybindingsTable, type RowGroup, type TableRow } from "./keybindings-table";
import { ProfileBar } from "./profile-bar";

/**
 * Settings → Keybindings. Profile bar, search row, the table, and the
 * recorder overlay — VS Code's Keyboard Shortcuts editor with Atlas chrome.
 */
export function KeybindingsEditor() {
  const resolved = useKeybindingsStore.use.resolved();
  const warnings = useKeybindingsStore.use.warnings();
  const [search, setSearch] = useState<SearchState>({
    query: "",
    recordKeys: false,
    recorded: null,
    sortAlpha: false,
  });
  const [selectedId, setSelectedId] = useState<ActionId | null>(null);
  const [recorder, setRecorder] = useState<{ id: ActionId; mode: RecorderMode } | null>(null);

  const conflicts = useMemo(() => findConflicts(resolved.list), [resolved]);

  const rows: TableRow[] = useMemo(
    () =>
      (ACTIONS as readonly ActionDef[]).map((def) => {
        const id = def.id as ActionId;
        const state = resolved.perAction.get(id);
        return {
          def,
          id,
          bindings: resolved.byAction.get(id) ?? [],
          overridden: state?.overridden ?? false,
          invalid: state?.invalid ?? [],
        };
      }),
    [resolved],
  );

  const filtered = useMemo(() => {
    if (search.recordKeys) {
      const chord = search.recorded;
      if (!chord) return rows;
      return rows.filter((r) => r.bindings.some((b) => comboEquals(b.combo, chord)));
    }
    const q = search.query.trim().toLowerCase();
    if (!q) return rows;
    const terms = q.split(/\s+/);
    return rows.filter((r) => {
      const hay = [
        r.def.title,
        r.id,
        r.def.category,
        WHEN_LABELS[r.def.when],
        ...r.bindings.flatMap((b) => [b.serialized, displayLabel(b.combo)]),
        r.overridden ? "user" : "default",
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [rows, search]);

  const groups: RowGroup[] = useMemo(() => {
    if (search.sortAlpha) {
      return [
        { title: "", rows: [...filtered].sort((a, b) => a.def.title.localeCompare(b.def.title)) },
      ];
    }
    return CATEGORY_ORDER.map((c) => ({
      title: c,
      rows: filtered.filter((r) => r.def.category === c),
    })).filter((g) => g.rows.length > 0);
  }, [filtered, search.sortAlpha]);

  const showSame = (combo: Combo) => {
    setRecorder(null);
    setSearch((s) => ({ ...s, recordKeys: true, recorded: combo }));
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col @container">
      <ProfileBar />
      <KeybindingsSearch state={search} onChange={setSearch} />
      {warnings.length > 0 && (
        <div className="flex items-start gap-2 border-b border-border-default bg-[var(--status-warning-muted)] px-3 py-1.5 text-[10.5px] text-text-secondary">
          <AlertTriangle size={11} className="mt-0.5 shrink-0 text-[var(--status-warning)]" />
          <div className="space-y-0.5">
            {warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        </div>
      )}
      <KeybindingsTable
        groups={groups}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onRecord={(id, mode) => {
          setSelectedId(id);
          setRecorder({ id, mode });
        }}
        conflicts={conflicts}
        onShowSame={showSame}
        unknownIds={search.query || search.recordKeys ? [] : resolved.unknownActionIds}
        emptyHint={
          search.recordKeys && search.recorded
            ? `Nothing is bound to ${displayLabel(search.recorded)}`
            : null
        }
      />
      {recorder && (
        <KeybindingRecorder
          actionId={recorder.id}
          mode={recorder.mode}
          onClose={() => setRecorder(null)}
          onShowSame={showSame}
        />
      )}
    </div>
  );
}
