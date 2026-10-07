// The composer's model picker: a provider rail on the left (Favorites, then
// one mark per provider the agent's models come from), search on top, the
// list beneath, and a "Legacy models" fold at the bottom of a provider.
//
// It renders INSIDE the composer's grouped menu (`ComposerGroupsMenu` in
// `message-input.tsx`), which owns the surface, its height morph, outside
// click and Escape. This is only the panel's content.
//
// A model's provider is what its agent STATED (`SessionModeInfo.provider`:
// the gateway's publisher, an ACP model group's name). A model whose agent
// stated none is filed under the agent itself — never under a guess from its
// id. Every model belongs to the session's one agent, so picking across
// providers is an ordinary `set_model`.
//
// Keyboard, from the search box: ↑/↓ move (wrapping), Enter picks, ← (on an
// empty query) or ⇧⇥ moves to the rail, where ↑/↓ move between providers,
// Enter/Space shows one and → comes back. As registered keybinding actions in
// the `modelPicker` context — rebindable, and shadowing the global ⌘N tab
// chords while focus is inside THIS picker — ⌘1–⌘9 pick the Nth model row,
// ⌘⇧↑/⌘⇧↓ step through the rail and ⌘⇧S stars the highlighted row.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, ChevronRight, Search, Star } from "lucide-react";
import { AgentMark } from "@/components/agent-mark";
import { ProviderLogo } from "@/components/provider-logo";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import type { ActionId } from "@/features/keybindings/lib/actions";
import { displayLabel } from "@/features/keybindings/lib/combo";
import {
  useScopedHotkeys,
  type ScopedHandler,
} from "@/features/keybindings/lib/use-scoped-hotkeys";
import { useKeybindingsStore } from "@/features/keybindings/stores/keybindings-store";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Kbd } from "@/ui/kbd";
import { Hint } from "@/ui/tooltip";
import type { AgentType } from "@/types/agent";
import type { SessionModeInfo } from "@/types/agents";
import { modelLabel } from "../lib/model-label";
import { useModelFavorites } from "../lib/model-favorites";
import { providerDisplay } from "../lib/model-provider";

/** The rail key of models whose agent stated no provider. */
const AGENT_GROUP = "agent";
const FAVORITES = "favorites";

const JUMP_ACTIONS: ActionId[] = [
  "modelPicker.jump1",
  "modelPicker.jump2",
  "modelPicker.jump3",
  "modelPicker.jump4",
  "modelPicker.jump5",
  "modelPicker.jump6",
  "modelPicker.jump7",
  "modelPicker.jump8",
  "modelPicker.jump9",
];

/** One rail entry: a provider, or the agent itself (`logo: null`). */
interface RailGroup {
  key: string;
  label: string;
  /** A `ProviderLogo` id; `null` draws the agent's own mark. */
  logo: string | null;
}

/** A group's mark, at the rail's size or the row caption's. */
function GroupMark({
  group,
  agentType,
  small,
}: {
  group: RailGroup;
  agentType: string;
  small?: boolean;
}) {
  if (group.logo === null) {
    return (
      <AgentMark
        agentType={agentType as AgentType}
        className={small ? "!h-3 !w-3 !rounded-sm !text-3xs" : "!h-4 !w-4 !rounded"}
      />
    );
  }
  return (
    <ProviderLogo id={group.logo} size={small ? 10 : 14} className={cn(small && "-mx-0.75")} />
  );
}

/** What the list renders: a model row, or the Legacy fold's toggle. */
type Entry = { kind: "model"; model: SessionModeInfo } | { kind: "legacy"; count: number };

const LEGACY_KEY = "legacy";
const modelKey = (id: string) => `model:${id}`;
const entryKey = (e: Entry) => (e.kind === "model" ? modelKey(e.model.id) : LEGACY_KEY);

/** The highlighted row, held by identity so a reorder (a star, the Legacy
 *  fold, a refreshed list) keeps it on the same model; `index` is where it
 *  was, the clamp for when that model leaves the list. `key: null` means
 *  "the row at `index`" — a fresh search highlights its best match. */
interface Highlight {
  key: string | null;
  index: number;
}

const words = (s: string) => s.split(/[\s\-./_:]+/);

/** Ranks a model against the query; `null` when some token matches nothing.
 *  Every token scores its best field: the name first (a prefix above a word
 *  start above a substring), then the id, then the description, and the
 *  provider last — so typing "claude" ranks models NAMED Claude above models
 *  that merely come from it. Lower is better. */
export function searchScore(
  m: SessionModeInfo,
  providerLabel: string,
  query: string,
): number | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const name = modelLabel(m).toLowerCase();
  const id = m.id.toLowerCase();
  const description = (m.description ?? "").toLowerCase();
  const provider = `${providerLabel} ${m.provider ?? ""}`.toLowerCase();
  let total = 0;
  for (const t of tokens) {
    let best: number;
    if (name.startsWith(t)) best = 0;
    else if (words(name).some((w) => w.startsWith(t))) best = 1;
    else if (name.includes(t)) best = 2;
    else if (id.startsWith(t) || words(id).some((w) => w.startsWith(t))) best = 3;
    else if (id.includes(t)) best = 4;
    else if (description.includes(t)) best = 6;
    else if (provider.includes(t)) best = 8;
    else return null;
    total += best;
  }
  return total;
}

export function ModelPicker({
  agentType,
  models,
  currentModel,
  onPick,
  toolbar,
  emptyState,
}: {
  agentType: string;
  models: SessionModeInfo[];
  currentModel: string | undefined;
  onPick: (modelId: string) => void;
  /** Trailing controls in the search row (the native agent's Refresh). */
  toolbar?: ReactNode;
  /** What to say when the agent advertised no models at all. */
  emptyState?: ReactNode;
}) {
  const { favorites, toggle } = useModelFavorites(agentType);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const agentLabel = agentMeta(agentType).label;

  // Each model's rail group, and the groups in the order the agent listed them.
  const { groupOf, groups } = useMemo(() => {
    const groupOf = new Map<string, RailGroup>();
    const groups: RailGroup[] = [];
    const seen = new Map<string, RailGroup>();
    for (const m of models) {
      const p = providerDisplay(m.provider);
      const key = p?.key ?? AGENT_GROUP;
      let g = seen.get(key);
      if (!g) {
        g = p ? { key, label: p.label, logo: p.logo } : { key, label: agentLabel, logo: null };
        seen.set(key, g);
        groups.push(g);
      }
      groupOf.set(m.id, g);
    }
    return { groupOf, groups };
  }, [models, agentLabel]);

  const current = models.find((m) => m.id === currentModel);
  const currentGroup = current ? groupOf.get(current.id)?.key : undefined;
  const railKeys = useMemo(() => [FAVORITES, ...groups.map((g) => g.key)], [groups]);

  // Open on Favorites when there are any, else on the current model's group —
  // the reference's rule, so a starred shortlist is one keystroke from the
  // pill. Chosen once, from the first non-empty list: the native agent opens
  // on [] and fills in after a refresh, and the view must not stay stuck on
  // what an empty list implied.
  const pickInitialView = useCallback((): string => {
    if (models.some((m) => favoriteSet.has(m.id))) return FAVORITES;
    return currentGroup ?? groups[0]?.key ?? FAVORITES;
  }, [models, favoriteSet, currentGroup, groups]);
  const [view, setView] = useState<string>(() => (models.length > 0 ? pickInitialView() : ""));
  const viewChosen = useRef(models.length > 0);

  const [highlight_, setHighlightState] = useState<Highlight>(() => ({
    key: currentModel ? modelKey(currentModel) : null,
    index: 0,
  }));
  // Scroll the highlighted row into view only when the keyboard (or a
  // programmatic jump) moved it — never under a hovering mouse.
  const scrollNext = useRef(true);
  const highlightCurrent = useCallback(() => {
    scrollNext.current = true;
    setHighlightState({ key: currentModel ? modelKey(currentModel) : null, index: 0 });
  }, [currentModel]);

  useEffect(() => {
    if (models.length === 0) return;
    if (!viewChosen.current) {
      viewChosen.current = true;
      setView(pickInitialView());
      highlightCurrent();
      return;
    }
    // A refreshed list can drop the group on show; fall back to the first.
    if (!railKeys.includes(view)) setView(railKeys[1] ?? FAVORITES);
  }, [models.length, railKeys, view, pickInitialView, highlightCurrent]);

  // The Legacy fold is open wherever the current model lives in it — at
  // open, and whenever the current model arrives or changes later — so the
  // checked row is always on screen.
  const currentLegacyGroup = current?.legacy ? currentGroup : undefined;
  const [legacyOpen, setLegacyOpen] = useState<ReadonlySet<string>>(
    () => new Set(currentLegacyGroup ? [currentLegacyGroup] : []),
  );
  useEffect(() => {
    if (!currentLegacyGroup) return;
    setLegacyOpen((cur) =>
      cur.has(currentLegacyGroup) ? cur : new Set([...cur, currentLegacyGroup]),
    );
  }, [currentLegacyGroup]);

  const [q, setQ] = useState("");
  const searching = q.trim().length > 0;

  const entries = useMemo((): Entry[] => {
    const asModels = (list: SessionModeInfo[]): Entry[] =>
      list.map((model) => ({ kind: "model", model }));
    const favoritesFirst = (list: SessionModeInfo[]) => [
      ...list.filter((m) => favoriteSet.has(m.id)),
      ...list.filter((m) => !favoriteSet.has(m.id)),
    ];
    if (searching) {
      const ranked = models
        .map((m, i) => ({ m, i, score: searchScore(m, groupOf.get(m.id)?.label ?? "", q) }))
        .filter((r): r is typeof r & { score: number } => r.score !== null)
        .sort(
          (a, b) =>
            a.score - b.score ||
            Number(favoriteSet.has(b.m.id)) - Number(favoriteSet.has(a.m.id)) ||
            a.i - b.i,
        );
      return asModels(ranked.map((r) => r.m));
    }
    if (view === FAVORITES) return asModels(models.filter((m) => favoriteSet.has(m.id)));
    const inGroup = models.filter((m) => groupOf.get(m.id)?.key === view);
    const legacy = inGroup.filter((m) => m.legacy);
    const out = asModels(favoritesFirst(inGroup.filter((m) => !m.legacy)));
    if (legacy.length > 0) {
      out.push({ kind: "legacy", count: legacy.length });
      if (legacyOpen.has(view)) out.push(...asModels(legacy));
    }
    return out;
  }, [models, q, searching, view, favoriteSet, groupOf, legacyOpen]);

  // ⌘N numbers the model rows only — the Legacy toggle is not a pick.
  const { jumpIndexOf, jumpModels } = useMemo(() => {
    const jumpIndexOf = new Map<number, number>();
    const jumpModels: SessionModeInfo[] = [];
    entries.forEach((e, i) => {
      if (e.kind !== "model") return;
      jumpIndexOf.set(i, jumpModels.length);
      jumpModels.push(e.model);
    });
    return { jumpIndexOf, jumpModels };
  }, [entries]);

  // The row the highlight resolves to in THIS list: the same entry if it is
  // still here, else the slot it was in, clamped.
  const highlight = useMemo(() => {
    if (entries.length === 0) return -1;
    if (highlight_.key !== null) {
      const i = entries.findIndex((e) => entryKey(e) === highlight_.key);
      if (i >= 0) return i;
    }
    return Math.min(highlight_.index, entries.length - 1);
  }, [entries, highlight_]);
  // Pin the identity of whatever row ended up highlighted, so the next
  // reorder follows the row and not the slot.
  useEffect(() => {
    const e = entries[highlight];
    if (!e) return;
    const key = entryKey(e);
    if (key !== highlight_.key || highlight !== highlight_.index) {
      setHighlightState({ key, index: highlight });
    }
  }, [entries, highlight, highlight_]);

  const setHighlightAt = (i: number, fromKeyboard: boolean) => {
    const e = entries[i];
    if (!e) return;
    scrollNext.current = fromKeyboard;
    setHighlightState({ key: entryKey(e), index: i });
  };

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollNext.current || highlight < 0) return;
    scrollNext.current = false;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [highlight, entries]);

  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  // Keys belong to the search box; a click on the rail or a star hands focus
  // back to it, as the reference does.
  const focusSearch = useCallback(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);
  const refocus = useCallback(() => {
    requestAnimationFrame(focusSearch);
  }, [focusSearch]);

  const showView = (key: string) => {
    setView(key);
    highlightCurrent();
  };
  const selectView = (key: string) => {
    showView(key);
    refocus();
  };
  const step = (dir: 1 | -1) => {
    const i = railKeys.indexOf(view);
    showView(railKeys[(i + dir + railKeys.length) % railKeys.length]!);
  };
  const toggleLegacy = () =>
    setLegacyOpen((cur) => {
      const next = new Set(cur);
      if (next.has(view)) next.delete(view);
      else next.add(view);
      return next;
    });
  const activate = (i: number) => {
    const e = entries[i];
    if (!e) return;
    if (e.kind === "legacy") toggleLegacy();
    else onPick(e.model.id);
  };
  const toggleFavorite = (id: string) => {
    // Starring re-sorts the list; the highlight follows the starred row.
    setHighlightState({ key: modelKey(id), index: Math.max(highlight, 0) });
    toggle(id);
  };

  // Registered actions in the `modelPicker` context, dispatched in the capture
  // phase so the open picker shadows the global ⌘N tab chords. Each declines
  // unless focus is inside THIS picker: two composers can each have theirs
  // mounted, and only the one being typed in may answer.
  const inside = () => !!rootRef.current?.contains(document.activeElement);
  const handlers: Partial<Record<ActionId, ScopedHandler>> = {};
  JUMP_ACTIONS.forEach((id, n) => {
    handlers[id] = () => {
      const m = jumpModels[n];
      if (!inside() || !m) return false;
      onPick(m.id);
    };
  });
  handlers["modelPicker.previousProvider"] = () => {
    if (!inside() || searching) return false;
    step(-1);
  };
  handlers["modelPicker.nextProvider"] = () => {
    if (!inside() || searching) return false;
    step(1);
  };
  handlers["modelPicker.toggleFavorite"] = () => {
    const e = entries[highlight];
    if (!inside() || e?.kind !== "model") return false;
    toggleFavorite(e.model.id);
  };
  useScopedHotkeys({ handlers });

  const byAction = useKeybindingsStore.use.resolved().byAction;
  const chordLabel = (id: ActionId) => {
    const first = byAction.get(id)?.[0];
    return first ? displayLabel(first.combo) : null;
  };
  const favoriteChord = chordLabel("modelPicker.toggleFavorite");

  const showRail = !searching && models.length > 0;

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // An IME owns Enter and the arrows until the composition is committed.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (
      showRail &&
      ((e.key === "ArrowLeft" && !e.shiftKey && q.length === 0) || (e.key === "Tab" && e.shiftKey))
    ) {
      const rail = railRef.current;
      const target =
        rail?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ??
        rail?.querySelector<HTMLButtonElement>("button");
      if (target) {
        e.preventDefault();
        target.focus();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (entries.length === 0) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      const from = highlight < 0 ? (d > 0 ? -1 : 0) : highlight;
      setHighlightAt((from + d + entries.length) % entries.length, true);
    } else if (e.key === "Enter") {
      if (!entries[highlight]) return;
      e.preventDefault();
      activate(highlight);
    }
  };

  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;
  const active = entries[highlight] ? optionId(highlight) : undefined;

  return (
    <div ref={rootRef} className="flex max-h-80">
      {showRail && (
        <ProviderRail
          railRef={railRef}
          groups={groups}
          agentType={agentType}
          view={view}
          onView={selectView}
          onFocusSearch={focusSearch}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-control-lg shrink-0 items-center gap-1.5 border-b border-border-subtle px-2.5">
          <Search size={12} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            autoFocus
            value={q}
            onChange={(e) => {
              const next = e.target.value;
              setQ(next);
              if (next.trim().length > 0) {
                // A new query highlights its best match.
                scrollNext.current = true;
                setHighlightState({ key: null, index: 0 });
              } else {
                highlightCurrent();
              }
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search models…"
            spellCheck={false}
            role="combobox"
            aria-label="Search models"
            aria-autocomplete="list"
            aria-expanded={entries.length > 0}
            aria-controls={listId}
            aria-activedescendant={active}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          {toolbar}
        </div>

        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Models"
          className="min-h-0 flex-1 scroll-py-1 overflow-y-auto overscroll-contain p-1 hide-scrollbar"
        >
          {models.length === 0 ? (
            (emptyState ?? <Empty>No models</Empty>)
          ) : entries.length === 0 ? (
            searching ? (
              <Empty>No models match “{q.trim()}”</Empty>
            ) : view === FAVORITES ? (
              <Empty hint="Star a model to keep it here.">No favorites yet</Empty>
            ) : (
              <Empty>No models</Empty>
            )
          ) : (
            entries.map((e, i) => {
              const highlighted = i === highlight;
              if (e.kind === "legacy") {
                const open = legacyOpen.has(view);
                return (
                  <div
                    key={LEGACY_KEY}
                    id={optionId(i)}
                    role="option"
                    aria-selected={false}
                    aria-expanded={open}
                    data-index={i}
                    data-highlighted={highlighted || undefined}
                    onMouseMove={() => !highlighted && setHighlightAt(i, false)}
                    onClick={() => {
                      setHighlightAt(i, false);
                      toggleLegacy();
                      refocus();
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-secondary-foreground transition-colors duration-fast data-highlighted:bg-element-hover data-highlighted:text-foreground"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="label">Legacy models</div>
                      <div className="mt-0.5 caption">
                        {e.count} {e.count === 1 ? "model" : "models"}
                      </div>
                    </div>
                    <ChevronRight
                      size={12}
                      className={cn(
                        "shrink-0 text-muted-foreground transition-transform duration-base ease-out-strong",
                        open && "rotate-90",
                      )}
                    />
                  </div>
                );
              }
              const m = e.model;
              const group = groupOf.get(m.id);
              const favorite = favoriteSet.has(m.id);
              const jump = jumpIndexOf.get(i);
              const kbd = jump !== undefined ? chordLabel(JUMP_ACTIONS[jump]!) : null;
              const description = m.description?.trim();
              const starLabel = favorite ? "Remove from favorites" : "Add to favorites";
              // The option holds nothing interactive; the star is its
              // sibling inside a presentational row, so a screen reader
              // reads one option and the star stays a real button.
              return (
                <div
                  key={m.id}
                  role="presentation"
                  data-highlighted={highlighted || undefined}
                  onMouseMove={() => !highlighted && setHighlightAt(i, false)}
                  className="group/row flex items-center gap-2 rounded-md pr-2 text-secondary-foreground transition-colors duration-fast data-highlighted:bg-element-hover data-highlighted:text-foreground"
                >
                  <div
                    id={optionId(i)}
                    role="option"
                    aria-selected={m.id === currentModel}
                    data-index={i}
                    title={
                      description && description.toLowerCase() !== "recommended"
                        ? description
                        : undefined
                    }
                    onClick={() => onPick(m.id)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate label">{modelLabel(m)}</span>
                        {m.is_new && (
                          <Badge
                            variant="info"
                            size="sm"
                            className="uppercase"
                            aria-label="New model"
                          >
                            New
                          </Badge>
                        )}
                      </div>
                      {group && (
                        <div className="mt-0.5 flex min-w-0 items-center gap-1 caption">
                          <GroupMark group={group} agentType={agentType} small />
                          <span className="truncate">{group.label}</span>
                        </div>
                      )}
                    </div>
                    {m.id === currentModel && (
                      <Check size={12} className="shrink-0 text-foreground" aria-label="Current" />
                    )}
                    {kbd && <Kbd className="shrink-0">{kbd}</Kbd>}
                  </div>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={starLabel}
                    aria-pressed={favorite}
                    title={favoriteChord ? `${starLabel} (${favoriteChord})` : starLabel}
                    onClick={() => {
                      toggleFavorite(m.id);
                      refocus();
                    }}
                    className={cn(
                      "grid size-control-xs shrink-0 cursor-pointer place-items-center rounded-sm transition-opacity duration-fast hover:bg-element-active",
                      favorite
                        ? "text-foreground"
                        : "text-muted-foreground opacity-0 group-data-highlighted/row:opacity-100",
                    )}
                  >
                    <Star size={12} className={cn(favorite && "fill-current")} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** The left rail: Favorites, a rule, then one mark per group — a vertical
 *  toolbar of toggle buttons (`aria-pressed`), as the reference's is. One
 *  roving tab stop (the shown provider); ↑/↓/Home/End move focus along it,
 *  Enter/Space show the focused one, → returns to the search box. A bar on
 *  the rail's edge slides to the shown entry. */
function ProviderRail({
  railRef,
  groups,
  agentType,
  view,
  onView,
  onFocusSearch,
}: {
  railRef: RefObject<HTMLDivElement | null>;
  groups: RailGroup[];
  agentType: string;
  view: string;
  onView: (key: string) => void;
  onFocusSearch: () => void;
}) {
  const [indicatorTop, setIndicatorTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = railRef.current?.querySelector<HTMLElement>(`[data-rail-view="${view}"]`);
    setIndicatorTop(el ? el.offsetTop + el.offsetHeight / 2 : null);
  }, [railRef, view, groups]);

  const entries: RailGroup[] = [{ key: FAVORITES, label: "Favorites", logo: null }, ...groups];

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      onFocusSearch();
      return;
    }
    const buttons = Array.from(
      railRef.current?.querySelectorAll<HTMLButtonElement>("button[data-rail-view]") ?? [],
    );
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (at + 1) % buttons.length;
    else if (e.key === "ArrowUp") next = (Math.max(at, 0) - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    if (next === null) return;
    e.preventDefault();
    buttons[next]!.focus();
  };

  return (
    <div
      ref={railRef}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Providers"
      onKeyDown={onKeyDown}
      className="relative flex w-10 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-border-subtle py-1 hide-scrollbar"
    >
      {indicatorTop !== null && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 h-4 w-0.5 -translate-y-1/2 rounded-l-full bg-foreground transition-[top] duration-base ease-out-strong"
          style={{ top: indicatorTop }}
        />
      )}
      {entries.map((g) => (
        <div key={g.key} className="contents">
          <Hint label={g.label} side="left">
            <button
              type="button"
              aria-pressed={g.key === view}
              aria-label={g.label}
              tabIndex={g.key === view ? 0 : -1}
              data-rail-view={g.key}
              onClick={() => onView(g.key)}
              className={cn(
                "grid size-control-md shrink-0 cursor-pointer place-items-center rounded-md transition-colors duration-fast focus-visible:outline-none",
                g.key === view
                  ? "bg-element-selected text-foreground"
                  : "text-muted-foreground hover:bg-element-hover hover:text-foreground focus-visible:bg-element-hover focus-visible:text-foreground",
              )}
            >
              {g.key === FAVORITES ? (
                <Star size={12} className="fill-current" />
              ) : (
                <GroupMark group={g} agentType={agentType} />
              )}
            </button>
          </Hint>
          {g.key === FAVORITES && (
            <span aria-hidden className="my-0.5 h-px w-5 shrink-0 bg-border-subtle" />
          )}
        </div>
      ))}
    </div>
  );
}

function Empty({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="px-2 py-2 text-xs text-muted-foreground">
      {children}
      {hint && <span className="mt-0.5 block caption">{hint}</span>}
    </div>
  );
}
