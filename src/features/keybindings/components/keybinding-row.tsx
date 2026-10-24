import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { Icon } from "@/ui/icon";
import { IconButton } from "@/ui/icon-button";
import { KbdKeys } from "@/ui/kbd";
import { Hint } from "@/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { ACTION_BY_ID, type ActionId } from "../lib/actions";
import {
  type Combo,
  comboFromEvent,
  displayKeys,
  displayLabel,
  modifiersFromEvent,
  serializeCombo,
} from "../lib/combo";
import { WHEN_PHRASES, type KeybindingRow as Row, rowClash } from "../lib/keybindings-view";
import { reservedReason } from "../lib/reserved";
import { bindingsForCombo, type Conflict } from "../lib/resolve";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { defaultWhenExpression, neverMatches, parseWhen, whenToExpression } from "../lib/when";
import { WhenClauseControl } from "./when-clause-control";

/** Which of a row's shortcuts is being recorded: an index into its bindings,
 *  or "add" for a new one next to them. */
export type Recording = number | "add";

/**
 * One command in Settings → Keybindings, drawn like a settings row: its title
 * (and, once changed, the reset button every setting has), where it works
 * when that isn't everywhere, and its shortcuts hard-right. A shortcut is a
 * button: click it and press the new keys, and it saves as they land —
 * there is no Save step anywhere in Settings.
 */
export function KeybindingRow({
  row,
  conflicts,
  selected,
  recording,
  onSelect,
  onRecord,
  onShowSame,
}: {
  row: Row;
  conflicts: Map<string, Conflict>;
  selected: boolean;
  recording: Recording | null;
  onSelect: () => void;
  onRecord: (which: Recording | null) => void;
  onShowSame: (combo: Combo) => void;
}) {
  const { resetBinding, removeBinding, setWhen } = useKeybindingsStore.use.actions();
  const clash = rowClash(row, conflicts);
  const phrase = WHEN_PHRASES[row.def.when];
  const first = row.bindings[0]?.combo ?? null;
  const whenAst = parseWhen(row.whenExpr) ?? undefined;
  const whenWarning = neverMatches(whenAst, row.def.when)
    ? phrase
      ? `This shortcut only runs ${phrase.toLowerCase()}, and this condition is never true there.`
      : "This condition is never true, so the shortcut never runs."
    : null;

  return (
    <ContextMenu onOpenChange={(open) => open && onSelect()}>
      <ContextMenuTrigger
        render={
          <div
            data-action-id={row.id}
            onClick={onSelect}
            // The trigger stays layout-only; the row's look is on its child.
            className="@container/settings-row group/row select-none"
          >
            <div
              className={cn(
                "flex items-center justify-between gap-6 px-4 py-2.5",
                "transition-colors duration-fast ease-out-strong",
                // The selection is for ↑↓ and Enter: shown only while the list has
                // focus, so a click doesn't leave a row lit after you move on.
                "hover:bg-element-hover",
                selected && "group-focus-within/list:bg-element-selected",
              )}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex min-h-5 items-center gap-1">
                  <h3 className="truncate text-sm font-medium text-foreground">{row.def.title}</h3>
                  {row.changed && (
                    <Hint label="Reset to default">
                      <IconButton
                        icon={Undo2}
                        size="xs"
                        label={`${row.def.title}: reset to default`}
                        onClick={(e) => {
                          e.stopPropagation();
                          resetBinding(row.id);
                        }}
                      />
                    </Hint>
                  )}
                </div>
                <WhenClauseControl
                  label={row.def.title}
                  expression={row.whenExpr}
                  value={whenAst}
                  warning={whenWarning}
                  scope={phrase}
                  onChange={(next) => {
                    const expression = whenToExpression(next);
                    const own = whenToExpression(
                      parseWhen(defaultWhenExpression(row.def.when)) ?? undefined,
                    );
                    setWhen(row.id, expression === own ? null : expression);
                  }}
                />
                {row.invalidWhen && (
                  <p className="text-xs text-error">
                    Not understood in keybindings.json: {row.invalidWhen}
                  </p>
                )}
                {row.invalid.length > 0 && (
                  <p className="text-xs text-error">
                    Not understood in keybindings.json: {row.invalid.join(", ")}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {clash && (
                  <Hint
                    label={`${clash.kind === "hard" ? "Also" : "Also, elsewhere,"} ${displayLabel(clash.combo)}: ${clash.with
                      .map((id) => ACTION_BY_ID[id].title)
                      .join(", ")}`}
                  >
                    <button
                      type="button"
                      aria-label="Show the clashing shortcuts"
                      onClick={(e) => {
                        e.stopPropagation();
                        onShowSame(clash.combo);
                      }}
                      className={cn(
                        "flex size-control-xs cursor-pointer items-center justify-center rounded",
                        clash.kind === "hard" ? "text-error" : "text-warning",
                      )}
                    >
                      <Icon icon={AlertTriangle} size="xs" />
                    </button>
                  </Hint>
                )}
                {row.bindings.map((b, i) =>
                  recording === i ? (
                    <ShortcutCapture
                      key={b.serialized}
                      actionId={row.id}
                      replace={b.serialized}
                      onDone={() => onRecord(null)}
                    />
                  ) : (
                    <ShortcutButton
                      key={b.serialized}
                      keys={displayKeys(b.combo)}
                      label={`${row.def.title}: change ${displayLabel(b.combo)}`}
                      onClick={() => onRecord(i)}
                    />
                  ),
                )}
                {recording === "add" ? (
                  <ShortcutCapture actionId={row.id} onDone={() => onRecord(null)} />
                ) : (
                  row.bindings.length === 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRecord("add");
                      }}
                      className={cn(
                        "h-control-sm cursor-pointer rounded-md px-2 text-xs text-muted-foreground",
                        "transition-colors duration-fast ease-out-strong",
                        "hover:bg-element-hover hover:text-foreground",
                      )}
                    >
                      Set shortcut
                    </button>
                  )
                )}
              </div>
            </div>
          </div>
        }
      />
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onRecord(row.bindings.length ? 0 : "add")}>
          Change shortcut…
          <ContextMenuShortcut>↩</ContextMenuShortcut>
        </ContextMenuItem>
        {row.bindings.length > 0 && (
          <ContextMenuItem onClick={() => onRecord("add")}>Add another shortcut…</ContextMenuItem>
        )}
        <ContextMenuItem disabled={!row.bindings.length} onClick={() => removeBinding(row.id)}>
          Remove {row.bindings.length > 1 ? "shortcuts" : "shortcut"}
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!row.changed} onClick={() => resetBinding(row.id)}>
          Reset to default
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!first} onClick={() => first && onShowSame(first)}>
          Show commands with this shortcut
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyRow(row)}>
          Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyText(row.id)}>Copy command ID</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export async function copyRow(row: Row) {
  const label = row.bindings.map((b) => displayLabel(b.combo)).join(", ") || "no shortcut";
  const ok = await copyText(`${row.def.title} — ${label} (${row.id})`);
  if (!ok) toast.error("Couldn't copy");
}

/** A shortcut at rest: its keycaps, as a button that starts recording. */
function ShortcutButton({
  keys,
  label,
  onClick,
}: {
  keys: string[];
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex h-control-sm cursor-pointer items-center rounded-md border border-transparent px-1",
        "transition-colors duration-fast ease-out-strong",
        "hover:border-border hover:bg-element-hover",
        "outline-none focus-visible:border-border-strong",
      )}
    >
      <KbdKeys keys={keys} />
    </button>
  );
}

/**
 * The shortcut slot while recording. It owns the keyboard in the capture
 * phase and flips the store's `recording` flag, so no dispatcher in the app
 * acts on the keys being pressed. The first complete chord saves; Esc, Tab
 * or a click elsewhere cancels; ⌫ removes the shortcut being replaced.
 *
 * A chord that clashes, or that the OS keeps for itself, still saves — the
 * user may mean it — but says so in a toast with an Undo.
 */
function ShortcutCapture({
  actionId,
  replace,
  onDone,
}: {
  actionId: ActionId;
  /** The shortcut being replaced; absent when adding one. */
  replace?: string;
  onDone: () => void;
}) {
  const { setRecording, setBinding, addBinding, removeBinding, resetChords } =
    useKeybindingsStore.use.actions();
  const [held, setHeld] = useState<string[]>([]);
  const ref = useRef<HTMLSpanElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    setRecording(true);
    return () => setRecording(false);
  }, [setRecording]);

  useEffect(() => {
    const bare = (e: KeyboardEvent) => !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if ((e.key === "Escape" || e.key === "Tab") && bare(e)) return done.current();
      if ((e.key === "Backspace" || e.key === "Delete") && bare(e)) {
        if (replace) removeBinding(actionId, replace);
        return done.current();
      }
      const combo = comboFromEvent(e);
      if (!combo) {
        setHeld(displayKeys({ code: "", ...modifiersFromEvent(e) }).slice(0, -1));
        return;
      }
      save(combo);
      done.current();
    };
    const onKeyUp = () => setHeld([]);
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) done.current();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    };
    // `save` reads the store fresh on every call; re-subscribing per render
    // would drop a keydown that lands between two effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionId, replace]);

  const save = (combo: Combo) => {
    const before = useKeybindingsStore.getState();
    const wasChanged = before.resolved.perAction.get(actionId)?.overridden ?? false;
    const previous = (before.resolved.byAction.get(actionId) ?? []).map((b) => b.serialized);
    const next = serializeCombo(combo);
    if (replace === undefined) addBinding(actionId, next);
    else setBinding(actionId, [...new Set(previous.map((s) => (s === replace ? next : s)))]);

    const def = ACTION_BY_ID[actionId];
    const undo = {
      label: "Undo",
      onClick: () => (wasChanged ? setBinding(actionId, previous) : resetChords(actionId)),
    };
    const reserved = reservedReason(combo);
    if (reserved) {
      toast.warning(`${displayLabel(combo)} may never reach Atlas`, {
        description: reserved,
        action: undo,
      });
      return;
    }
    const others = bindingsForCombo(
      useKeybindingsStore.getState().resolved.list,
      combo,
      actionId,
    ).filter((b) => b.when === def.when || b.when === "global" || def.when === "global");
    const ownWhen = useKeybindingsStore.getState().resolved.perAction.get(actionId)?.whenExpr;
    if (others.length) {
      const sameContext = others.some((b) => b.whenExpr === ownWhen);
      const more = others.length > 1 ? ` (and ${others.length - 1} more)` : "";
      toast.warning(
        `${displayLabel(combo)} is also ${ACTION_BY_ID[others[0]!.actionId].title}${more}`,
        {
          description: sameContext
            ? "Only one of them can run. Change either shortcut to keep both."
            : "Where both apply, the more specific one runs.",
          action: undo,
        },
      );
    }
  };

  return (
    <span
      ref={ref}
      role="status"
      aria-live="polite"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "flex h-control-sm min-w-32 items-center justify-center gap-1.5 rounded-md px-2",
        "border border-border-strong bg-panel-input text-xs text-muted-foreground",
      )}
    >
      {held.length ? <KbdKeys keys={held} /> : "Press a shortcut…"}
    </span>
  );
}
