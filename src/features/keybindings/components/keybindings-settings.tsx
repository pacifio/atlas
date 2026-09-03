import { useMemo, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { KbdCombo } from "@/ui/kbd";
import { copyText } from "@/lib/clipboard";
import { openConfigFile } from "@/features/settings/lib/atlas-config-api";
import { ACTION_GROUPS, type ActionDef, type ActionId, type Chord } from "../lib/actions";
import { formatCombo, serializeCombo, type Combo } from "../lib/combo";
import { exportKeymap, importKeymap } from "../lib/keymap-file";
import { PRESETS, type PresetId } from "../lib/presets";
import { reservedReason } from "../lib/reserved";
import type { ResolvedBinding } from "../lib/resolve";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { ShortcutRecorder } from "./shortcut-recorder";

/**
 * Settings → Keybindings: every command, what runs it, and how to change that.
 *
 * This replaced a printed table of chords that Settings had no way to keep
 * true — it documented ⌘⌥B as "Toggle Status Bar" while the key toggled the
 * bottom panel. Everything here reads from the same resolved keymap the
 * dispatcher matches against, so what it shows is what the keys do.
 */
export function KeybindingsSettings() {
  const preset = useKeybindingsStore.use.preset();
  const keymap = useKeybindingsStore.use.keymap();
  const overrides = useKeybindingsStore.use.overrides();
  const actions = useKeybindingsStore.use.actions();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [pendingConflict, setPendingConflict] = useState<{
    actionId: ActionId;
    combo: Combo;
    heldBy: ActionDef;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bindingOf = useMemo(
    () => new Map(keymap.bindings.map((b) => [b.action.id, b])),
    [keymap.bindings],
  );

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return ACTION_GROUPS;
    return ACTION_GROUPS.map((g) => ({
      group: g.group,
      actions: g.actions.filter(
        (a) =>
          a.label.toLowerCase().includes(needle) ||
          a.id.includes(needle) ||
          // Searching by the chord itself: "shift+b" finds what it runs.
          chordOf(bindingOf.get(a.id)).includes(needle),
      ),
    })).filter((g) => g.actions.length > 0);
  }, [query, bindingOf]);

  const run = (work: Promise<void>) => {
    setError(null);
    void work.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  /** Commit a recorded chord, asking first if another command in the same
   *  scope already holds it. */
  const record = (actionId: ActionId, combo: Combo) => {
    setRecording(null);
    const action = bindingOf.get(actionId)?.action;
    const clash = keymap.bindings.find(
      (b) =>
        b.action.id !== actionId &&
        b.action.scope === action?.scope &&
        b.combos.some((c) => serializeCombo(c) === serializeCombo(combo)),
    );
    if (clash) {
      setPendingConflict({ actionId, combo, heldBy: clash.action });
      return;
    }
    run(actions.setBinding(actionId, serializeCombo(combo)));
  };

  const resolveConflict = () => {
    if (!pendingConflict) return;
    const { actionId, combo, heldBy } = pendingConflict;
    setPendingConflict(null);
    // One write: taking the chord and freeing it from its previous owner is a
    // single decision, and a half-applied version of it is a keymap with a
    // conflict in it.
    run(
      actions.setBindings({
        [heldBy.id]: null,
        [actionId]: serializeCombo(combo),
      } as Partial<Record<ActionId, Chord>>),
    );
  };

  const exportToClipboard = async () => {
    const ok = await copyText(exportKeymap(preset, overrides));
    if (ok) toast.success("Keymap copied to the clipboard");
    else toast.error("Could not copy the keymap");
  };

  const importFromClipboard = async () => {
    const text = await navigator.clipboard.readText().catch(() => "");
    if (!text.trim()) {
      toast.error("The clipboard has no keymap in it");
      return;
    }
    const parsed = importKeymap(text);
    if (!parsed.ok) {
      toast.error(`That isn't a keymap Atlas can read: ${parsed.error}`);
      return;
    }
    run(
      actions.replaceKeymap(parsed.preset, parsed.overrides).then(() => {
        toast.success(
          parsed.skipped.length
            ? `Keymap imported. ${parsed.skipped.length} command(s) this Atlas doesn't have were skipped.`
            : "Keymap imported",
        );
      }),
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-text-primary">Keybindings</h2>
        <p className="mt-0.5 text-[11px] text-text-tertiary">
          Every command and the shortcut that runs it. Changes are saved to{" "}
          <button
            type="button"
            onClick={() => void openConfigFile()}
            className="underline decoration-dotted underline-offset-2 hover:text-text-secondary"
          >
            config.toml
          </button>
          , where you can also edit them by hand.
        </p>
      </div>

      <div className="space-y-2">
        <div className="px-1 text-[10px] uppercase tracking-wider text-text-tertiary">Preset</div>
        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => p.id !== preset && run(actions.setPreset(p.id as PresetId))}
              className={cn(
                "rounded-xl border p-3 text-left transition-colors outline-none",
                p.id === preset
                  ? "border-[var(--accent)] bg-bg-elevated"
                  : "border-border-default bg-bg-secondary hover:border-[var(--border-strong)]",
              )}
            >
              <div className="text-[12px] font-medium text-text-primary">{p.label}</div>
              <div className="mt-0.5 text-[10px] leading-snug text-text-tertiary">
                {p.description}
              </div>
            </button>
          ))}
        </div>
        <p className="px-1 text-[10px] text-text-tertiary">
          A preset only moves the commands the other editor has an equivalent for. Your own changes
          below sit on top of it, and switching preset keeps them.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 px-3 py-2 text-[11px] text-text-secondary">
          {error}
        </div>
      )}

      {keymap.problems.length > 0 && (
        <div className="space-y-1 rounded-lg border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-3 py-2 text-[11px] text-text-secondary">
          <p className="font-medium text-text-primary">
            Some lines in config.toml couldn&apos;t be used:
          </p>
          {keymap.problems.map((p) => (
            <p key={`${p.actionId}:${p.binding}`} className="font-mono text-[10px]">
              {p.actionId} = &quot;{p.binding}&quot; —{" "}
              {p.reason === "unknown-action"
                ? "no such command in this version of Atlas"
                : "not a shortcut Atlas can read"}
            </p>
          ))}
          <p className="text-[10px] text-text-tertiary">
            They are still in the file exactly as you wrote them; nothing was deleted.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search commands"
          className={cn(
            "h-[28px] flex-1 rounded-lg border border-border-default bg-bg-secondary px-2.5",
            "text-[11px] text-text-primary outline-none placeholder:text-text-tertiary",
            "focus:border-[var(--border-strong)]",
          )}
        />
        <ToolbarButton onClick={() => void exportToClipboard()}>Copy keymap</ToolbarButton>
        <ToolbarButton onClick={() => void importFromClipboard()}>Paste keymap</ToolbarButton>
        <ToolbarButton
          disabled={Object.keys(overrides).length === 0}
          onClick={() => run(actions.resetAllBindings())}
        >
          Reset all
        </ToolbarButton>
      </div>

      {pendingConflict && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-3 py-2">
          <p className="text-[11px] text-text-secondary">
            <KbdCombo combo={formatCombo(pendingConflict.combo)} /> already runs{" "}
            <span className="font-medium text-text-primary">{pendingConflict.heldBy.label}</span>.
            Give it to this command instead?
          </p>
          <div className="flex shrink-0 gap-2">
            <ToolbarButton onClick={resolveConflict}>Reassign</ToolbarButton>
            <ToolbarButton onClick={() => setPendingConflict(null)}>Keep as is</ToolbarButton>
          </div>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.group} className="space-y-2">
          <div className="px-1 text-[10px] uppercase tracking-wider text-text-tertiary">
            {g.group}
          </div>
          <div className="overflow-hidden rounded-lg border border-border-default">
            {g.actions.map((action, i) => (
              <CommandRow
                key={action.id}
                binding={bindingOf.get(action.id)}
                action={action}
                first={i === 0}
                recording={recording === action.id}
                onRecord={() => setRecording(action.id as ActionId)}
                onRecorded={(combo) => record(action.id as ActionId, combo)}
                onCancel={() => setRecording(null)}
                onUnbind={() => run(actions.setBinding(action.id as ActionId, null))}
                onReset={() => run(actions.resetBinding(action.id as ActionId))}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function chordOf(binding: ResolvedBinding | undefined): string {
  return (binding?.combos ?? []).map(serializeCombo).join(" ");
}

function ToolbarButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-[28px] shrink-0 rounded-lg border border-border-default px-2.5",
        "text-[11px] text-text-secondary hover:border-[var(--border-strong)]",
        "disabled:opacity-40 disabled:hover:border-border-default",
      )}
    >
      {children}
    </button>
  );
}

function CommandRow({
  action,
  binding,
  first,
  recording,
  onRecord,
  onRecorded,
  onCancel,
  onUnbind,
  onReset,
}: {
  action: ActionDef;
  binding: ResolvedBinding | undefined;
  first: boolean;
  recording: boolean;
  onRecord: () => void;
  onRecorded: (combo: Combo) => void;
  onCancel: () => void;
  onUnbind: () => void;
  onReset: () => void;
}) {
  const combos = binding?.combos ?? [];
  // Only the first is checked: it is the one a reader takes as "the" shortcut,
  // and a warning per chord would crowd the row it belongs to.
  const reserved = combos[0] && reservedReason(combos[0]);
  return (
    <div
      className={cn(
        "group flex min-h-[34px] items-center justify-between gap-3 px-3 py-1.5",
        !first && "border-t border-border-subtle",
      )}
    >
      <div className="min-w-0">
        <span className="text-[11px] text-text-secondary">{action.label}</span>
        {action.scope !== "global" && (
          <span className="ml-2 rounded-[4px] bg-bg-elevated px-1 text-[9px] text-text-tertiary">
            {action.scope}
          </span>
        )}
        {reserved && (
          <span className="ml-2 text-[9px] text-[var(--status-warning)]">{reserved}</span>
        )}
      </div>

      {recording ? (
        <ShortcutRecorder onRecorded={onRecorded} onCancel={onCancel} />
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onRecord}
            title="Record a new shortcut"
            className="outline-none"
          >
            {combos.length ? (
              <span className="flex items-center gap-1.5">
                {combos.map((c) => (
                  <KbdCombo key={serializeCombo(c)} combo={formatCombo(c)} />
                ))}
              </span>
            ) : (
              <span className="text-[10px] text-text-tertiary">Add shortcut</span>
            )}
          </button>
          <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {combos.length > 0 && (
              <RowAction
                onClick={onUnbind}
                title={combos.length > 1 ? "Remove these shortcuts" : "Remove this shortcut"}
              >
                Unbind
              </RowAction>
            )}
            {binding?.source === "user" && (
              <RowAction onClick={onReset} title="Back to the preset's shortcut">
                Reset
              </RowAction>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RowAction({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-[4px] px-1 text-[10px] text-text-tertiary hover:text-text-secondary"
    >
      {children}
    </button>
  );
}
