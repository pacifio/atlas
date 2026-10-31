/**
 * The Settings screen's sidebar: the window's bar slice on
 * top (under the traffic lights), a search box over every setting, the
 * sections in two foldable groups, and `Back` to the workspace at the foot.
 *
 * Search is the registry's: each `config.toml` key with a row is an item,
 * titled exactly as its row is (`settings-sections.ts`). Picking a result
 * opens its section and scrolls to the row, which flashes.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DevBadge, useWindowDrag } from "@/components/titlebar";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { isMac } from "@/lib/platform";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { Hint } from "@/ui/tooltip";
import { Icon } from "@/ui/icon";
import { IconButton } from "@/ui/icon-button";
import { Kbd } from "@/ui/kbd";
import {
  SIDEBAR,
  searchSettings,
  type SearchItem,
  type SidebarEntry,
} from "../lib/settings-sections";
import type { SettingsSection } from "../stores/settings-nav-store";

export function SettingsSidebar({
  active,
  onSelect,
  onSearchPick,
  onBack,
  badges,
}: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onSearchPick: (item: SearchItem) => void;
  onBack: () => void;
  badges: Partial<Record<SettingsSection, number>>;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchSettings(query), [query]);
  // Groups folded shut, by label. Per visit, like the project rail's
  // sections are per session: a fold is a glance, not a preference.
  const [folded, setFolded] = useState<Record<string, boolean>>({});

  // `/` focuses search while Settings is on screen, unless something editable
  // has focus already — never steal a keystroke from a field.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const drag = useWindowDrag();
  const isFullscreen = useFullscreen();
  // The key that opened Settings closes it again (`app.settings` toggles).
  const backShortcut = useActionShortcut("app.settings")?.label;

  const pick = (item: SearchItem) => {
    onSearchPick(item);
    setQuery("");
    inputRef.current?.blur();
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (query) setQuery("");
      else inputRef.current?.blur();
      event.preventDefault();
    } else if (event.key === "ArrowDown") {
      setCursor((c) => Math.min(c + 1, results.length - 1));
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      setCursor((c) => Math.max(c - 1, 0));
      event.preventDefault();
    } else if (event.key === "Enter" && results[cursor]) {
      pick(results[cursor]);
      event.preventDefault();
    }
  };

  return (
    <nav
      ref={rootRef}
      aria-label="Settings sections"
      className="flex w-64 shrink-0 flex-col border-r border-border bg-background"
    >
      {/* This column's slice of the window bar: it drags the window and sits
          under the macOS traffic lights, which it clears the same way the
          workspace bar does. */}
      <div
        {...drag}
        className={cn(
          "flex h-titlebar shrink-0 select-none items-center text-sm font-medium text-foreground",
          isMac && !isFullscreen ? "pl-[calc(78px/var(--ui-zoom,1))]" : "pl-4",
        )}
      >
        Atlas
        <DevBadge className="ml-2" />
      </div>
      <div className="shrink-0 px-2 pb-1">
        <div className="relative w-full">
          {/* Shaped like a nav row (height, inset, icon column), so the
                search icon lines up with the section icons below it. */}
          <div
            className={cn(
              "flex h-control-lg items-center gap-2.5 rounded-md px-2",
              "transition-colors duration-fast ease-out-strong",
              "hover:bg-element-hover focus-within:bg-element-hover",
            )}
          >
            <Icon icon={Search} size="md" className="shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={onSearchKey}
              placeholder="Search settings"
              aria-label="Search settings"
              role="combobox"
              aria-expanded={query.length > 0}
              aria-controls="settings-search-results"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-disabled"
            />
            {query ? (
              <IconButton icon={X} size="xs" label="Clear search" onClick={() => setQuery("")} />
            ) : (
              <Kbd>/</Kbd>
            )}
          </div>
          {query && (
            <ul
              id="settings-search-results"
              role="listbox"
              className="absolute inset-x-0 top-full z-popover mt-1 max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-0.5 shadow-md"
            >
              {results.length === 0 ? (
                <li className="px-2 py-2 caption">No settings found</li>
              ) : (
                results.map((item, index) => (
                  <li
                    key={item.id}
                    role="option"
                    aria-selected={index === cursor}
                    onMouseEnter={() => setCursor(index)}
                    onMouseDown={(e) => {
                      // Before the input blurs, which would hide the list.
                      e.preventDefault();
                      pick(item);
                    }}
                    className={cn(
                      "flex cursor-pointer flex-col rounded px-2 py-1.5",
                      index === cursor && "bg-element-hover",
                    )}
                  >
                    <span className="text-xs text-foreground">{item.title}</span>
                    <span className="caption">{item.where}</span>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 py-2">
        {SIDEBAR.map((group) => {
          const shut = !!folded[group.label];
          return (
            <div key={group.label} className="flex flex-col gap-0.5">
              <GroupHeader
                label={group.label}
                shut={shut}
                onToggle={() => setFolded((f) => ({ ...f, [group.label]: !f[group.label] }))}
              />
              {!shut &&
                group.entries.map((entry) => (
                  <NavItem
                    key={entry.id}
                    entry={entry}
                    active={active === entry.id}
                    badge={badges[entry.id] ?? 0}
                    onSelect={onSelect}
                  />
                ))}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col border-t border-border px-2 py-2">
        <Hint label="Back to the workspace" shortcut={backShortcut} side="right">
          <button
            type="button"
            onClick={onBack}
            className={cn(
              "flex h-7 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground",
              "transition-colors duration-fast ease-out-strong hover:bg-element-hover hover:text-foreground",
            )}
          >
            <Icon icon={ArrowLeft} size="md" />
            Back
          </button>
        </Hint>
      </div>
    </nav>
  );
}

/**
 * A group's heading, drawn as the project rail's section header
 * (`SectionHeaderRow`): sentence case, semibold, in the secondary colour, with
 * a small disclosure after the label that folds the group.
 */
function GroupHeader({
  label,
  shut,
  onToggle,
}: {
  label: string;
  shut: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!shut}
      className="group/s flex h-7 w-full items-center gap-1 rounded-md px-2 hover:bg-element-hover"
    >
      <span className="text-xs leading-none font-semibold text-secondary-foreground group-hover/s:text-foreground">
        {label}
      </span>
      {/* Promoted: a rotating unpromoted icon re-rasterises in WebKit, which
          is the hover wobble the project rail fixed the same way. */}
      <span className="flex items-center transform-gpu [backface-visibility:hidden]">
        <ChevronDown
          size={10}
          className={cn("text-muted-foreground transition-transform", shut && "-rotate-90")}
        />
      </span>
    </button>
  );
}

function NavItem({
  entry,
  active,
  badge,
  onSelect,
}: {
  entry: SidebarEntry;
  active: boolean;
  badge: number;
  onSelect: (section: SettingsSection) => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(entry.id)}
      // A sidebar nav row: the same height, type and icon colours as the
      // app sidebar's rows, so the two sidebars read as one app.
      className={cn(
        "group/nav flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-sm leading-none whitespace-nowrap",
        "transition-colors duration-fast ease-out-strong",
        active
          ? "bg-element-active text-foreground"
          : "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
      )}
    >
      <Icon
        icon={entry.icon}
        size="md"
        className={cn(
          "shrink-0",
          active
            ? "text-foreground"
            : "text-muted-foreground group-hover/nav:text-secondary-foreground",
        )}
      />
      {entry.label}
      {badge > 0 && (
        <span className="ml-auto h-4 min-w-4 rounded-full bg-primary px-1 text-center text-3xs leading-4 text-primary-foreground tabular-nums">
          {badge}
        </span>
      )}
    </button>
  );
}
