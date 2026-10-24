// One palette view inside the command shell: the field, the virtualised
// list, and the key legend. ⌘K (root and every submenu), ⌘P and the new-tab
// palette all render through this, so they share one keyboard model.
//
// The keyboard model: the field keeps focus; ↑/↓ step the highlight over the
// selectable rows (wrapping), Enter runs it, Backspace on an empty field
// goes back out of a submenu. A query change highlights the first row again.
// The pointer highlights a row only when it actually moves — content
// scrolling under a resting mouse must not steal the highlight from the keys.

import {
  createContext,
  useContext,
  useEffect,
  useId,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon } from "@/ui/icon";
import { Kbd, KbdGroup } from "@/ui/kbd";
import {
  CommandEmpty,
  CommandFooter,
  CommandFooterHint,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandPanel,
  CommandShortcut,
  CommandSubmenuChevron,
} from "@/ui/command";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import type { ActionId } from "@/features/keybindings/lib/actions";
import {
  buildCommandPaletteRows,
  stepHighlight,
  type CommandPaletteEntry,
  type CommandPaletteGroup,
  type CommandPaletteRow,
} from "../lib/command-palette-logic";

/** The host dialog's slot for the mounted view's Escape handler: set, the
 *  dialog calls it and stays open instead of closing. */
export const CommandEscapeContext = createContext<RefObject<(() => void) | null> | null>(null);

/** For the host: the slot, and the `onOpenChange` guard that consults it. */
export function useCommandEscape() {
  const ref = useRef<(() => void) | null>(null);
  /** True when Escape was taken by the view (go back) and the close was
   *  cancelled. */
  const interceptEscape = (open: boolean, details: { reason: string; cancel: () => void }) => {
    if (open || details.reason !== "escape-key" || !ref.current) return false;
    details.cancel();
    ref.current();
    return true;
  };
  return { ref, interceptEscape };
}

const LABEL_ROW_HEIGHT = 30;
const ITEM_ROW_HEIGHT = 32;
const TWO_LINE_ROW_HEIGHT = 50;

export interface CommandPaletteContentProps {
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onExecute: (item: CommandPaletteEntry) => void;
  readonly placeholder: string;
  /** Shown when there are no rows. */
  readonly emptyMessage: string;
  /** The Enter hint's label; omitted, the hint is left out. */
  readonly footerActionLabel?: string;
  readonly escapeLabel?: string;
  /** Sits at the right end of the footer (⌘P's "Reindex"). */
  readonly footerTrailing?: ReactNode;
  /** Backspace on an empty field calls this (a submenu's way out). */
  readonly onBack?: () => void;
  /** Escape calls this instead of closing the dialog (a submenu's way out). */
  readonly onEscape?: () => void;
  /** Replaces the magnifier: a submenu's back arrow. */
  readonly startAddon?: ReactNode;
  readonly size?: "default" | "tall";
  readonly disabled?: boolean;
  /** For the tests and the screenshots. */
  readonly testId?: string;
}

export function CommandPaletteContent(props: CommandPaletteContentProps) {
  const { groups, query, onQueryChange, onExecute, onBack } = props;
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { rows, itemValues, rowIndexByItemIndex } = buildCommandPaletteRows(groups);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  // The highlight shown: the tracked one while it is still listed, else the
  // first row — so a filter that drops the highlighted row moves it to the
  // top rather than leaving nothing lit.
  const active =
    highlighted !== null && itemValues.includes(highlighted)
      ? highlighted
      : (itemValues[0] ?? null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateRowHeight(rows[index]),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 8,
  });

  // A new query starts at the top, on the first row.
  const lastQuery = useRef(query);
  useLayoutEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    setHighlighted(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [query]);

  // Escape belongs to the dialog (Base UI dismisses before a keydown on the
  // field could stop it), so the view hands its way out to the host, which
  // asks before closing.
  const escapeRef = useContext(CommandEscapeContext);
  const onEscape = props.onEscape;
  useLayoutEffect(() => {
    if (!escapeRef) return;
    escapeRef.current = onEscape ?? null;
    return () => {
      if (escapeRef.current === onEscape) escapeRef.current = null;
    };
  }, [escapeRef, onEscape]);

  // A view that replaces another (a submenu, the file search) takes focus
  // back once it mounts, so typing never lands behind the dialog.
  // The dialog's focus trap reacts to the old field unmounting a frame
  // later, so focus is claimed now and again once that has run.
  useEffect(() => {
    inputRef.current?.focus();
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inner = requestAnimationFrame(() => inputRef.current?.focus());
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  const scrollToValue = (value: string | null) => {
    if (value === null) return;
    const itemIndex = itemValues.indexOf(value);
    const rowIndex = rowIndexByItemIndex[itemIndex];
    if (rowIndex === undefined) return;
    // The first row also brings its group's label back into view.
    const target = itemIndex === 0 ? 0 : rowIndex;
    virtualizer.scrollToIndex(target, { align: "auto" });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      const next = stepHighlight(itemValues, active, event.key === "ArrowDown" ? 1 : -1);
      setHighlighted(next);
      scrollToValue(next);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = rows.find(
        (row): row is Extract<CommandPaletteRow, { kind: "item" }> =>
          row.kind === "item" && row.item.value === active && !row.item.disabled,
      )?.item;
      if (item) onExecute(item);
      return;
    }
    if (event.key === "Backspace" && query === "" && onBack) {
      event.preventDefault();
      onBack();
    }
  };

  // The pointer's last position: a `pointermove` at the same spot is the
  // list moving under a resting mouse, not the user pointing.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const pointTo = (value: string, x: number, y: number) => {
    const last = lastPointer.current;
    lastPointer.current = { x, y };
    if (last && last.x === x && last.y === y) return;
    if (value !== active) setHighlighted(value);
  };

  const activeRowId = active === null ? undefined : `${listId}-${active}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={props.testId}>
      <CommandInput
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={props.placeholder}
        disabled={props.disabled}
        aria-controls={listId}
        aria-activedescendant={activeRowId}
        startAddon={props.startAddon}
      />
      {rows.length === 0 ? (
        <CommandEmpty>{props.emptyMessage}</CommandEmpty>
      ) : (
        <CommandPanel ref={scrollRef} id={listId} size={props.size}>
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]!;
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.kind === "label" ? (
                    <div className={row.first ? undefined : "pt-2"}>
                      <CommandGroupLabel>{row.label}</CommandGroupLabel>
                    </div>
                  ) : (
                    <CommandPaletteRowView
                      id={`${listId}-${row.item.value}`}
                      item={row.item}
                      active={row.item.value === active}
                      onPoint={(x, y) => pointTo(row.item.value, x, y)}
                      onExecute={onExecute}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </CommandPanel>
      )}
      <CommandFooter>
        <div className="flex items-center gap-4">
          <CommandFooterHint>
            <KbdGroup>
              <Kbd variant="soft" size="sm">
                <Icon icon={ArrowUp} size="sm" />
              </Kbd>
              <Kbd variant="soft" size="sm">
                <Icon icon={ArrowDown} size="sm" />
              </Kbd>
            </KbdGroup>
            <span>Navigate</span>
          </CommandFooterHint>
          {props.footerActionLabel !== undefined && (
            <CommandFooterHint>
              <Kbd variant="soft" size="sm">
                Enter
              </Kbd>
              <span>{props.footerActionLabel}</span>
            </CommandFooterHint>
          )}
          <CommandFooterHint>
            <Kbd variant="soft" size="sm">
              Esc
            </Kbd>
            <span>{props.escapeLabel ?? "Close"}</span>
          </CommandFooterHint>
        </div>
        {props.footerTrailing}
      </CommandFooter>
    </div>
  );
}

function estimateRowHeight(row: CommandPaletteRow | undefined): number {
  if (!row) return ITEM_ROW_HEIGHT;
  if (row.kind === "label") return LABEL_ROW_HEIGHT;
  return row.item.description ? TWO_LINE_ROW_HEIGHT : ITEM_ROW_HEIGHT;
}

function CommandPaletteRowView(props: {
  id: string;
  item: CommandPaletteEntry;
  active: boolean;
  onPoint: (x: number, y: number) => void;
  onExecute: (item: CommandPaletteEntry) => void;
}) {
  const { item } = props;
  const title = (
    <span className="flex min-w-0 items-center gap-1.5 text-foreground">
      {item.titleLeadingContent}
      <span className="truncate">{item.title}</span>
    </span>
  );
  return (
    <CommandItem
      id={props.id}
      active={props.active}
      disabled={item.disabled}
      onPointerMove={(event) => props.onPoint(event.clientX, event.clientY)}
      // Keep focus in the field: a mousedown on a row would blur it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!item.disabled) props.onExecute(item);
      }}
    >
      <CommandItemIcon>{item.icon}</CommandItemIcon>
      {item.description ? (
        <span className="flex min-w-0 flex-1 flex-col">
          {title}
          <span className="min-w-0 truncate text-xs text-muted-foreground">{item.description}</span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center">{title}</span>
      )}
      {item.titleTrailingContent}
      {item.timestamp && (
        <span className="ms-auto min-w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {item.timestamp}
        </span>
      )}
      {item.shortcutAction && <ActionShortcut id={item.shortcutAction} />}
      {item.kind === "submenu" && <CommandSubmenuChevron />}
    </CommandItem>
  );
}

/** The action's live chord in the active keybinding profile, as glyphs. */
function ActionShortcut({ id }: { id: ActionId }) {
  const shortcut = useActionShortcut(id);
  if (!shortcut) return null;
  return <CommandShortcut>{shortcut.label}</CommandShortcut>;
}
