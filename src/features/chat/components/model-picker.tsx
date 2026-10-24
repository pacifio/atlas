// The composer's agent + model picker: one surface for both choices. A rail
// on the left (Pinned, then one mark per switchable agent, then "add"),
// search on top, and the shown agent's models beneath — its starred models
// pinned first, the rest by the provider the agent stated, and a "Legacy
// models" fold at the bottom.
//
// It renders INSIDE the composer's grouped menu (`ComposerGroupsMenu` in
// `message-input.tsx`), which owns the surface, its height morph, outside
// click and Escape. This is only the panel's content.
//
// A model's provider is what its agent STATED (`SessionModeInfo.provider`:
// the gateway's publisher, an ACP model group's name), never a guess from its
// id. The session's own agent supplies its live list; every other agent shows
// the list it advertised the last time it was bound (`acp-models-cache`), so
// picking one of its models is "switch agent, then start on this model".
//
// Keyboard, from the search box: ↑/↓ move (wrapping), Enter picks, ← (on an
// empty query) or ⇧⇥ moves to the rail, where ↑/↓ move between entries,
// Enter/Space shows one and → comes back. As registered keybinding actions in
// the `modelPicker` context — rebindable, and shadowing the global ⌘N tab
// chords while focus is inside THIS picker — ⌘1–⌘9 pick the Nth model row,
// ⌘⇧↑/⌘⇧↓ step through the rail and ⌘⇧S stars the highlighted row.

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, ChevronRight, Pin, Plus, Search } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import { AgentGlyph } from "@/features/artifacts/components/agent-glyph";
import type { ActionId } from "@/features/keybindings/lib/actions";
import { displayLabel } from "@/features/keybindings/lib/combo";
import {
  useScopedHotkeys,
  type ScopedHandler,
} from "@/features/keybindings/lib/use-scoped-hotkeys";
import { useKeybindingsStore } from "@/features/keybindings/stores/keybindings-store";
import { cn } from "@/lib/utils";
import { catalogEntry } from "@/features/agents/lib/agent-meta";
import { arrangeModels } from "@/features/agents/lib/agent-models";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { Hint } from "@/ui/tooltip";
import type { SessionModeInfo } from "@/types/agents";
import { modelLabel } from "../lib/model-label";
import { favoriteKey, useModelFavorites } from "../lib/model-favorites";
import { providerDisplay } from "../lib/model-provider";

const FAVORITES = "favorites";
const ADD = "add";

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

/** One agent the picker offers, with the models it advertised (`[]` when it
 *  has never been bound, or advertises no model select). */
export interface PickerAgent {
  agentType: string;
  label: string;
  models: SessionModeInfo[];
}

/** A heading above a run of rows: the pinned favourites, a provider the agent
 *  stated, or (in the Pinned view) an agent. */
interface Section {
  key: string;
  label: string;
  mark: { kind: "pin" } | { kind: "provider"; logo: string } | { kind: "agent"; agentType: string };
}

/** What the list renders: a model row, or an agent's Legacy fold toggle. */
type Entry =
  | { kind: "model"; agent: PickerAgent; model: SessionModeInfo; section?: Section }
  | { kind: "legacy"; agent: PickerAgent; count: number };

const modelKey = (agentType: string, id: string) => `model:${agentType}:${id}`;
const legacyKey = (agentType: string) => `legacy:${agentType}`;
const entryKey = (e: Entry) =>
  e.kind === "model" ? modelKey(e.agent.agentType, e.model.id) : legacyKey(e.agent.agentType);

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
 *  agent/provider last — so typing "claude" ranks models NAMED Claude above
 *  models that merely come from it. Lower is better. */
export function searchScore(m: SessionModeInfo, sourceLabel: string, query: string): number | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const name = modelLabel(m).toLowerCase();
  const id = m.id.toLowerCase();
  const description = (m.description ?? "").toLowerCase();
  const source = `${sourceLabel} ${m.provider ?? ""}`.toLowerCase();
  let total = 0;
  for (const t of tokens) {
    let best: number;
    if (name.startsWith(t)) best = 0;
    else if (words(name).some((w) => w.startsWith(t))) best = 1;
    else if (name.includes(t)) best = 2;
    else if (id.startsWith(t) || words(id).some((w) => w.startsWith(t))) best = 3;
    else if (id.includes(t)) best = 4;
    else if (description.includes(t)) best = 6;
    else if (source.includes(t)) best = 8;
    else return null;
    total += best;
  }
  return total;
}

/** The rows of one agent's view: starred models pinned on top, then the rest
 *  under the providers the agent stated (headed only when it stated more than
 *  one), then the Legacy fold. */
function agentEntries(
  agent: PickerAgent,
  favorites: ReadonlySet<string>,
  legacyOpen: boolean,
): Entry[] {
  const isFav = (m: SessionModeInfo) => favorites.has(favoriteKey(agent.agentType, m.id));
  const models = agent.models;
  const pinned = models.filter(isFav);
  const rest = models.filter((m) => !isFav(m) && !m.legacy);
  const legacy = models.filter((m) => !isFav(m) && m.legacy);

  const out: Entry[] = [];
  const pinnedSection: Section = { key: "pinned", label: "Pinned", mark: { kind: "pin" } };
  for (const model of pinned) out.push({ kind: "model", agent, model, section: pinnedSection });

  // Providers in the order the agent listed them; a model with none stated is
  // filed under the agent itself.
  const byProvider = new Map<string, { section: Section; models: SessionModeInfo[] }>();
  for (const m of rest) {
    const p = providerDisplay(m.provider);
    const key = p?.key ?? "agent";
    let g = byProvider.get(key);
    if (!g) {
      g = {
        section: p
          ? { key, label: p.label, mark: { kind: "provider", logo: p.logo } }
          : { key, label: agent.label, mark: { kind: "agent", agentType: agent.agentType } },
        models: [],
      };
      byProvider.set(key, g);
    }
    g.models.push(m);
  }
  const headed = byProvider.size > 1;
  for (const { section, models } of byProvider.values()) {
    for (const model of models) {
      out.push({
        kind: "model",
        agent,
        model,
        // One provider needs no heading — unless favourites sit above it, when
        // the rest still need to read as a separate run.
        ...(headed
          ? { section }
          : pinned.length > 0
            ? { section: { key: "all", label: "All models", mark: section.mark } }
            : {}),
      });
    }
  }
  if (legacy.length > 0) {
    out.push({ kind: "legacy", agent, count: legacy.length });
    if (legacyOpen) for (const model of legacy) out.push({ kind: "model", agent, model });
  }
  return out;
}

export function ModelPicker({
  agents: advertised,
  currentAgent,
  currentModel,
  onPick,
  toolbar,
  emptyState,
  addView,
}: {
  /** Every agent the tab can switch to, in rail order. */
  agents: PickerAgent[];
  /** The session's agent: the view the picker opens on. */
  currentAgent: string;
  currentModel: string | undefined;
  /** A model of `agentType`, or `null` for "switch to it on its default". */
  onPick: (agentType: string, modelId: string | null) => void;
  /** Trailing controls in the search row for the shown agent (the native
   *  agent's Refresh). */
  toolbar?: (agentType: string) => ReactNode;
  /** What to say when the shown agent advertised no models; `undefined`
   *  falls back to the default. */
  emptyState?: (agentType: string) => ReactNode;
  /** The rail's trailing "+" view: agents that could be added. */
  addView?: ReactNode;
}) {
  const { favorites, toggle } = useModelFavorites();
  // Each agent's models as arranged in Settings → Agents: its own order, the
  // models the user added by id, and without the ones hidden there — in
  // every view, search included. A starred model stays, being asked for.
  const agents = useMemo(
    () =>
      advertised.map((a) => {
        const entry = catalogEntry(a.agentType);
        const hidden = new Set(entry?.hiddenModels);
        return {
          ...a,
          models: arrangeModels(entry, a.models).filter(
            (m) => !hidden.has(m.id) || favorites.has(favoriteKey(a.agentType, m.id)),
          ),
        };
      }),
    [advertised, favorites],
  );
  const agentOf = useMemo(() => new Map(agents.map((a) => [a.agentType, a])), [agents]);
  const homeView = agentOf.has(currentAgent) ? currentAgent : (agents[0]?.agentType ?? FAVORITES);

  const railKeys = useMemo(
    () => [FAVORITES, ...agents.map((a) => a.agentType), ...(addView ? [ADD] : [])],
    [agents, addView],
  );
  const [view, setView] = useState<string>(homeView);
  // An agent can leave the list while it is shown (uninstalled elsewhere).
  useEffect(() => {
    if (!railKeys.includes(view)) setView(homeView);
  }, [railKeys, view, homeView]);
  const shownAgent = agentOf.get(view);

  const currentKey = currentModel ? modelKey(currentAgent, currentModel) : null;
  const [highlight_, setHighlightState] = useState<Highlight>(() => ({
    key: currentKey,
    index: 0,
  }));
  // Scroll the highlighted row into view only when the keyboard (or a
  // programmatic jump) moved it — never under a hovering mouse.
  const scrollNext = useRef(true);
  const highlightCurrent = useCallback(() => {
    scrollNext.current = true;
    setHighlightState({ key: currentKey, index: 0 });
  }, [currentKey]);

  // The current model's list arrives after open on a cold bind: highlight it
  // then, once.
  const currentListed = !!agentOf.get(currentAgent)?.models.some((m) => m.id === currentModel);
  useEffect(() => {
    if (currentListed) highlightCurrent();
  }, [currentListed, highlightCurrent]);

  // An agent's Legacy fold is open wherever the current model lives in it —
  // at open, and whenever the current model arrives or changes later — so
  // the checked row is always on screen.
  const currentIsLegacy = !!agentOf.get(currentAgent)?.models.find((m) => m.id === currentModel)
    ?.legacy;
  const [legacyOpen, setLegacyOpen] = useState<ReadonlySet<string>>(
    () => new Set(currentIsLegacy ? [currentAgent] : []),
  );
  useEffect(() => {
    if (!currentIsLegacy) return;
    setLegacyOpen((cur) => (cur.has(currentAgent) ? cur : new Set([...cur, currentAgent])));
  }, [currentIsLegacy, currentAgent]);

  const [q, setQ] = useState("");
  const searching = q.trim().length > 0;

  const entries = useMemo((): Entry[] => {
    if (searching) {
      const ranked: { e: Entry; score: number; fav: boolean; order: number }[] = [];
      let order = 0;
      for (const agent of agents) {
        for (const model of agent.models) {
          const p = providerDisplay(model.provider);
          const score = searchScore(model, `${agent.label} ${p?.label ?? ""}`, q);
          if (score === null) continue;
          ranked.push({
            e: { kind: "model", agent, model },
            score,
            fav: favorites.has(favoriteKey(agent.agentType, model.id)),
            order: order++,
          });
        }
      }
      ranked.sort(
        (a, b) => a.score - b.score || Number(b.fav) - Number(a.fav) || a.order - b.order,
      );
      return ranked.map((r) => r.e);
    }
    if (view === FAVORITES) {
      // Every agent's starred models, headed by agent, in rail order.
      const out: Entry[] = [];
      for (const agent of agents) {
        const section: Section = {
          key: agent.agentType,
          label: agent.label,
          mark: { kind: "agent", agentType: agent.agentType },
        };
        for (const model of agent.models) {
          if (favorites.has(favoriteKey(agent.agentType, model.id))) {
            out.push({ kind: "model", agent, model, section });
          }
        }
      }
      return out;
    }
    return shownAgent ? agentEntries(shownAgent, favorites, legacyOpen.has(view)) : [];
  }, [agents, q, searching, view, shownAgent, favorites, legacyOpen]);

  // ⌘N numbers the model rows only — the Legacy toggle is not a pick.
  const { jumpIndexOf, jumpEntries } = useMemo(() => {
    const jumpIndexOf = new Map<number, number>();
    const jumpEntries: Extract<Entry, { kind: "model" }>[] = [];
    entries.forEach((e, i) => {
      if (e.kind !== "model") return;
      jumpIndexOf.set(i, jumpEntries.length);
      jumpEntries.push(e);
    });
    return { jumpIndexOf, jumpEntries };
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
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    if (list && row) scrollWithin(list, row);
  }, [highlight, entries]);

  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  // Keys belong to the search box; a click on the rail or a star hands focus
  // back to it.
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
  const toggleLegacy = (agentType: string) =>
    setLegacyOpen((cur) => {
      const next = new Set(cur);
      if (next.has(agentType)) next.delete(agentType);
      else next.add(agentType);
      return next;
    });
  const activate = (i: number) => {
    const e = entries[i];
    if (!e) return;
    if (e.kind === "legacy") toggleLegacy(e.agent.agentType);
    else onPick(e.agent.agentType, e.model.id);
  };
  const toggleFavorite = (agentType: string, id: string) => {
    // Starring re-sorts the list; the highlight follows the starred row.
    setHighlightState({ key: modelKey(agentType, id), index: Math.max(highlight, 0) });
    toggle(agentType, id);
  };

  // Registered actions in the `modelPicker` context, dispatched in the capture
  // phase so the open picker shadows the global ⌘N tab chords. Each declines
  // unless focus is inside THIS picker: two composers can each have theirs
  // mounted, and only the one being typed in may answer.
  const inside = () => !!rootRef.current?.contains(document.activeElement);
  const handlers: Partial<Record<ActionId, ScopedHandler>> = {};
  JUMP_ACTIONS.forEach((id, n) => {
    handlers[id] = () => {
      const e = jumpEntries[n];
      if (!inside() || !e) return false;
      onPick(e.agent.agentType, e.model.id);
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
    toggleFavorite(e.agent.agentType, e.model.id);
  };
  useScopedHotkeys({ handlers });

  const byAction = useKeybindingsStore.use.resolved().byAction;
  const chordLabel = (id: ActionId) => {
    const first = byAction.get(id)?.[0];
    return first ? displayLabel(first.combo) : null;
  };
  const favoriteChord = chordLabel("modelPicker.toggleFavorite");

  const showRail = !searching;
  // An agent with nothing to list is still a pick: switching to it.
  const switchOnly =
    !searching && shownAgent && shownAgent.models.length === 0 && view !== currentAgent;

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
      if (switchOnly) {
        e.preventDefault();
        onPick(shownAgent.agentType, null);
        return;
      }
      if (!entries[highlight]) return;
      e.preventDefault();
      activate(highlight);
    }
  };

  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;
  const active = entries[highlight] ? optionId(highlight) : undefined;

  const renderEmpty = (): ReactNode => {
    if (searching) return <Empty>No models match “{q.trim()}”</Empty>;
    if (view === FAVORITES)
      return <Empty hint="Pin a model to keep it here.">Nothing pinned yet</Empty>;
    if (!shownAgent) return null;
    const custom = emptyState?.(shownAgent.agentType);
    if (custom !== undefined) return custom;
    if (view === currentAgent) return <Empty>No models</Empty>;
    return (
      <div className="flex flex-col items-start gap-2 px-2 py-2">
        <span className="text-xs text-muted-foreground">
          {shownAgent.label}'s models show here once it has connected.
          <span className="mt-0.5 block caption">Switch to it to start on its default.</span>
        </span>
        <Button size="sm" variant="outline" onClick={() => onPick(shownAgent.agentType, null)}>
          <AgentGlyph agent={shownAgent.agentType} size={12} />
          Switch to {shownAgent.label}
        </Button>
      </div>
    );
  };

  return (
    // Two surfaces, the project sidebar's recipe: a tinted surround carrying
    // the rail — the foreground at 6.3% over the background, so 16/255 off
    // pure black or pure white — and the search + list in an inset card on the
    // app's own background, its edge carried by a hairline ring and a shadow.
    <div
      ref={rootRef}
      data-when-scope="modelPickerOpen"
      className={cn("flex h-110 bg-foreground/[6.3%] py-1.5 pr-1.5", !showRail && "pl-1.5")}
    >
      {showRail && (
        <AgentRail
          railRef={railRef}
          agents={agents}
          withAdd={!!addView}
          currentAgent={currentAgent}
          view={view}
          onView={selectView}
          onFocusSearch={focusSearch}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-background shadow-lg ring-1 ring-border">
        <div className="flex h-control-lg shrink-0 items-center gap-1.5 border-b border-foreground/8 px-2.5">
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
            placeholder="Search agents and models…"
            spellCheck={false}
            role="combobox"
            aria-label="Search models"
            aria-autocomplete="list"
            aria-expanded={entries.length > 0}
            aria-controls={listId}
            aria-activedescendant={active}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          {!searching && shownAgent && toolbar?.(shownAgent.agentType)}
        </div>

        {view === ADD && !searching ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain hide-scrollbar">
            {addView}
          </div>
        ) : (
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Models"
            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 hide-scrollbar"
          >
            {entries.length === 0
              ? renderEmpty()
              : entries.map((e, i) => {
                  const prev = entries[i - 1];
                  const section = e.kind === "model" ? e.section : undefined;
                  const prevSection = prev?.kind === "model" ? prev.section : undefined;
                  const heading =
                    section && section.key !== prevSection?.key ? (
                      <SectionHeading section={section} first={i === 0} />
                    ) : null;
                  return (
                    <Fragment key={entryKey(e)}>
                      {heading}
                      {e.kind === "legacy" ? (
                        <LegacyRow
                          id={optionId(i)}
                          index={i}
                          count={e.count}
                          open={legacyOpen.has(e.agent.agentType)}
                          highlighted={i === highlight}
                          onHover={() => i !== highlight && setHighlightAt(i, false)}
                          onToggle={() => {
                            setHighlightAt(i, false);
                            toggleLegacy(e.agent.agentType);
                            refocus();
                          }}
                        />
                      ) : (
                        <ModelRow
                          id={optionId(i)}
                          index={i}
                          entry={e}
                          showAgent={searching}
                          current={
                            e.agent.agentType === currentAgent && e.model.id === currentModel
                          }
                          favorite={favorites.has(favoriteKey(e.agent.agentType, e.model.id))}
                          highlighted={i === highlight}
                          kbd={(() => {
                            const jump = jumpIndexOf.get(i);
                            return jump !== undefined ? chordLabel(JUMP_ACTIONS[jump]!) : null;
                          })()}
                          favoriteChord={favoriteChord}
                          onHover={() => i !== highlight && setHighlightAt(i, false)}
                          onPick={() => onPick(e.agent.agentType, e.model.id)}
                          onPin={() => {
                            toggleFavorite(e.agent.agentType, e.model.id);
                            refocus();
                          }}
                        />
                      )}
                    </Fragment>
                  );
                })}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeading({ section, first }: { section: Section; first: boolean }) {
  return (
    <div
      role="presentation"
      className={cn(
        "flex h-6 items-center gap-1.5 px-2 text-3xs font-medium uppercase tracking-wide text-muted-foreground",
        !first && "mt-1",
      )}
    >
      {section.mark.kind === "pin" ? (
        <Pin size={9} className="shrink-0 fill-current" />
      ) : section.mark.kind === "provider" ? (
        <ProviderLogo id={section.mark.logo} size={10} className="-mx-0.75" />
      ) : (
        <AgentGlyph agent={section.mark.agentType} size={10} />
      )}
      <span className="truncate">{section.label}</span>
    </div>
  );
}

/** One model: its name, and under it the agent's description of it, muted
 *  and clamped to two lines. The option holds nothing interactive; the pin is
 *  its sibling inside a presentational row, so a screen reader reads one
 *  option and the pin stays a real button.
 *
 *  The trailing slot is a FIXED width holding the row's ⌘N chord, and the
 *  pin in its place under the highlight. Fixed, because a slot that changed
 *  width with its content re-wrapped the description on every hover — the
 *  row's text jumped under the pointer. */
function ModelRow({
  id,
  index,
  entry,
  showAgent,
  current,
  favorite,
  highlighted,
  kbd,
  favoriteChord,
  onHover,
  onPick,
  onPin,
}: {
  id: string;
  index: number;
  entry: Extract<Entry, { kind: "model" }>;
  showAgent: boolean;
  current: boolean;
  favorite: boolean;
  highlighted: boolean;
  kbd: string | null;
  favoriteChord: string | null;
  onHover: () => void;
  onPick: () => void;
  onPin: () => void;
}) {
  const { agent, model: m } = entry;
  const description = m.description?.trim();
  const pinLabel = favorite ? "Unpin" : "Pin";
  const showPin = highlighted || (favorite && !kbd);
  return (
    <div
      role="presentation"
      data-highlighted={highlighted || undefined}
      onMouseMove={onHover}
      className="flex items-center rounded-md pr-1 data-highlighted:bg-foreground/6"
    >
      <div
        id={id}
        role="option"
        aria-selected={current}
        data-index={index}
        onClick={onPick}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-2"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate label">{modelLabel(m)}</span>
            {showAgent && favorite && (
              <Pin size={9} className="shrink-0 fill-current text-muted-foreground" aria-hidden />
            )}
          </div>
          {(showAgent || description) && (
            <p className="mt-0.5 line-clamp-2 caption" title={description}>
              {showAgent && (
                <span className="mr-1 inline-flex items-center gap-1 align-bottom">
                  <AgentGlyph agent={agent.agentType} size={10} />
                  {agent.label}
                  {description && <span aria-hidden> ·</span>}
                </span>
              )}
              {description && <span>{description}</span>}
            </p>
          )}
        </div>
        {current && <Check size={12} className="shrink-0 text-foreground" aria-label="Current" />}
      </div>
      <div className="grid w-9 shrink-0 place-items-center">
        {showPin ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={pinLabel}
            aria-pressed={favorite}
            title={favoriteChord ? `${pinLabel} (${favoriteChord})` : pinLabel}
            onClick={onPin}
            className={cn(
              "grid size-control-xs cursor-pointer place-items-center rounded-sm transition-colors duration-fast hover:bg-foreground/8",
              favorite ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Pin size={12} className={cn(favorite && "fill-current")} />
          </button>
        ) : (
          kbd && <Kbd>{kbd}</Kbd>
        )}
      </div>
    </div>
  );
}

function LegacyRow({
  id,
  index,
  count,
  open,
  highlighted,
  onHover,
  onToggle,
}: {
  id: string;
  index: number;
  count: number;
  open: boolean;
  highlighted: boolean;
  onHover: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={false}
      aria-expanded={open}
      data-index={index}
      data-highlighted={highlighted || undefined}
      onMouseMove={onHover}
      onClick={onToggle}
      className="mt-1 flex h-7 cursor-pointer items-center gap-2 rounded-md pr-2.5 pl-2 text-muted-foreground data-highlighted:bg-foreground/6"
    >
      <span className="label">Legacy models</span>
      <span className="flex-1 caption">
        {count} {count === 1 ? "model" : "models"}
      </span>
      <ChevronRight
        size={12}
        className={cn(
          "shrink-0 transition-transform duration-base ease-out-strong",
          open && "rotate-90",
        )}
      />
    </div>
  );
}

/** The left rail: Pinned, a rule, one mark per agent, and "+" at the foot — a vertical
 *  toolbar of toggle buttons (`aria-pressed`). One roving tab stop (the shown
 *  entry); ↑/↓/Home/End move focus along it, Enter/Space show the focused
 *  one, → returns to the search box. The shown entry is marked by its fill
 *  alone; which agent the session is on, by the list's check. */
function AgentRail({
  railRef,
  agents,
  withAdd,
  currentAgent,
  view,
  onView,
  onFocusSearch,
}: {
  railRef: RefObject<HTMLDivElement | null>;
  agents: PickerAgent[];
  withAdd: boolean;
  currentAgent: string;
  view: string;
  onView: (key: string) => void;
  onFocusSearch: () => void;
}) {
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

  const railButton = (key: string, label: string, icon: ReactNode) => (
    <Hint label={label} side="left">
      <button
        type="button"
        aria-pressed={key === view}
        aria-label={label}
        tabIndex={key === view ? 0 : -1}
        data-rail-view={key}
        onClick={() => onView(key)}
        className={cn(
          "relative grid size-control-md shrink-0 cursor-pointer place-items-center rounded-md transition-colors duration-fast focus-visible:outline-none",
          key === view
            ? "bg-foreground/8 text-foreground"
            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:bg-foreground/5 focus-visible:text-foreground",
        )}
      >
        {icon}
      </button>
    </Hint>
  );

  return (
    <div
      ref={railRef}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Agents"
      onKeyDown={onKeyDown}
      className="relative flex w-10 shrink-0 flex-col items-center gap-0.5 overflow-y-auto hide-scrollbar"
    >
      {railButton(FAVORITES, "Pinned", <Pin size={12} className="fill-current" />)}
      <span aria-hidden className="my-0.5 h-px w-5 shrink-0 bg-foreground/8" />
      {agents.map((a) => (
        <Fragment key={a.agentType}>
          {railButton(
            a.agentType,
            a.agentType === currentAgent ? `${a.label} (current)` : a.label,
            // The vendor's own colours — the rail is where agents are told
            // apart at a glance (`agent-brand.ts`).
            <AgentGlyph agent={a.agentType} size={15} />,
          )}
        </Fragment>
      ))}
      {withAdd && (
        <>
          {/* Last, at the rail's foot: the one entry that is not an
              agent you have, but a way to get another. */}
          <span aria-hidden className="min-h-1 flex-1" />
          {railButton(ADD, "Add agents", <Plus size={13} />)}
        </>
      )}
    </div>
  );
}

/** Scroll `row` into view inside `list` and nowhere else. `scrollIntoView`
 *  scrolls EVERY scrollable ancestor, and the composer's menu surface is one
 *  (`overflow-hidden`, mid height-tween while it opens): it scrolled the
 *  search bar out of the panel. */
function scrollWithin(list: HTMLElement, row: HTMLElement) {
  const pad = 4;
  const top = row.offsetTop - pad;
  const bottom = row.offsetTop + row.offsetHeight + pad;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

function Empty({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="px-2 py-2 text-xs text-muted-foreground">
      {children}
      {hint && <span className="mt-0.5 block caption">{hint}</span>}
    </div>
  );
}
