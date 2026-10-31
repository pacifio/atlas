// An agent's models in Settings → Agents: star, hide, reorder, and add a model
// by id, on what an ACP agent advertises.
//
// An agent states its models in a session, so the list is the last one it
// gave (`acp-models-cache`); before its first chat only the user's own custom
// models are known. Starring is the composer's favourites; hiding, order and
// custom models are the agent's settings, written through `agents_configure`.

import { forwardRef, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Star, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";
import { Hint } from "@/ui/tooltip";
import { arrangeModels, type ArrangedModel } from "@/features/agents/lib/agent-models";
import { profileFor } from "@/features/agents/lib/agent-profiles";
import { favoriteKey, useModelFavorites } from "@/features/chat/lib/model-favorites";
import { loadCachedAcpModels } from "@/features/chat/lib/acp-models-cache";
import {
  priceForModel,
  useModelPricingStore,
  type ModelPrice,
} from "../../stores/model-pricing-store";
import { SettingsGroup, SettingsSection } from "../layout/settings-layout";
import { configureAgent, type AgentItem } from "./agent-install";

/** A starred model's star, filled. */
const StarFilled: LucideIcon = forwardRef((props, ref) => (
  <Star ref={ref} {...props} fill="currentColor" />
));
StarFilled.displayName = "StarFilled";

/** Past this many models, a filter box. */
const FILTER_THRESHOLD = 8;

type Group = "favorite" | "visible" | "hidden";

/** What models.dev says the model can do, for the row's muted labels. */
function capabilityLabels(info: ModelPrice | null): string[] {
  if (!info) return [];
  const labels: string[] = [];
  if (info.reasoning) labels.push("Reasoning");
  if (info.images) labels.push("Images");
  if (info.context) {
    labels.push(
      info.context >= 1_000_000
        ? `${+(info.context / 1_000_000).toFixed(1)}M context`
        : `${Math.round(info.context / 1000)}K context`,
    );
  }
  return labels;
}

export function AgentModelsSection({ item }: { item: AgentItem }) {
  const catalog = item.catalog;
  const { favorites, toggle } = useModelFavorites();
  const prices = useModelPricingStore.use.prices();
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const advertised = useMemo(
    () => loadCachedAcpModels(item.agentType)?.availableModels ?? [],
    [item.agentType],
  );
  if (!catalog || item.state === "detected") return null;
  const native = item.state === "native";

  const hidden = new Set(catalog.hiddenModels);
  const isFavorite = (id: string) => favorites.has(favoriteKey(item.agentType, id));
  const arranged = arrangeModels(catalog, advertised);
  const groupOf = (m: ArrangedModel): Group =>
    isFavorite(m.id) ? "favorite" : !m.custom && hidden.has(m.id) ? "hidden" : "visible";
  const order: Group[] = ["favorite", "visible", "hidden"];
  const display = order.flatMap((g) => arranged.filter((m) => groupOf(m) === g));

  const query = filter.trim().toLowerCase();
  const filtering = display.length > FILTER_THRESHOLD && query !== "";
  const visible = filtering
    ? display.filter(
        (m) => m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query),
      )
    : display;
  const builtIn = arranged.filter((m) => !m.custom);
  const allHidden = builtIn.length > 0 && builtIn.every((m) => hidden.has(m.id));
  const favoriteCount = display.filter((m) => groupOf(m) === "favorite").length;
  const hiddenCount = builtIn.filter((m) => hidden.has(m.id)).length;

  const setHidden = (ids: string[], hide: boolean) => {
    const next = hide
      ? [...new Set([...catalog.hiddenModels, ...ids])]
      : catalog.hiddenModels.filter((id) => !ids.includes(id));
    void configureAgent(item, { hiddenModels: next });
  };
  const move = (id: string, direction: -1 | 1) => {
    const index = display.findIndex((m) => m.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= display.length) return;
    if (groupOf(display[index]!) !== groupOf(display[target]!)) return;
    const next = display.map((m) => m.id);
    [next[index], next[target]] = [next[target]!, next[index]!];
    void configureAgent(item, { modelOrder: next });
  };
  const add = async () => {
    const id = draft.trim();
    if (!id) return setError("Enter a model id.");
    if (builtIn.some((m) => m.id === id))
      return setError(`${item.name} already offers that model.`);
    if (catalog.customModels.some((m) => m.id === id))
      return setError("That model is already added.");
    if (await configureAgent(item, { customModels: [...catalog.customModels, { id }] })) {
      setDraft("");
      setError(null);
      setAdding(false);
      setFilter("");
    }
  };
  const removeCustom = (id: string) =>
    void configureAgent(item, {
      customModels: catalog.customModels.filter((m) => m.id !== id),
      modelOrder: catalog.modelOrder.filter((m) => m !== id),
    });

  const canAdd = !native;
  const placeholder = profileFor(item.id)?.customModelPlaceholder ?? "model-id";
  const groupLabel = (label: string, first: boolean) => (
    <div className={cn("px-2 pb-1.5 text-2xs text-muted-foreground", first ? "pt-1" : "pt-5")}>
      {label}
    </div>
  );

  return (
    <SettingsSection title="Models">
      <SettingsGroup>
        <div className="flex flex-col px-4 py-3">
          <p className="mb-3 text-xs text-muted-foreground">
            {native
              ? "Stars, order and what's hidden shape the composer's model picker."
              : "Stars, order and what's hidden shape the composer's model picker. A custom model is sent to the agent as is; it decides whether to accept it."}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {display.length > FILTER_THRESHOLD && (
              <Input
                size="sm"
                className="w-56 max-w-full"
                spellCheck={false}
                placeholder="Filter models"
                aria-label="Filter models"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            )}
            <div className="flex items-center gap-2">
              {builtIn.length > 0 && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    setHidden(
                      builtIn.map((m) => m.id),
                      !allHidden,
                    )
                  }
                >
                  {allHidden ? "Enable all" : "Disable all"}
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                {display.length} model{display.length === 1 ? "" : "s"}
                {favoriteCount > 0 ? ` · ${favoriteCount} starred` : ""}
                {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
              </span>
            </div>
            {canAdd && !adding && (
              <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setAdding(true)}>
                <Icon icon={Plus} size="xs" />
                Add custom model
              </Button>
            )}
          </div>

          <div className="-mx-2 mt-2 max-h-80 overflow-y-auto">
            {visible.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {filtering
                  ? "No models match."
                  : "No models yet. They show up here after its first chat."}
              </p>
            )}
            {visible.map((model, index) => {
              const group = groupOf(model);
              const previous = visible[index - 1];
              const startsGroup = previous === undefined || groupOf(previous) !== group;
              const at = display.indexOf(model);
              return (
                <div key={model.id}>
                  {startsGroup &&
                    favoriteCount > 0 &&
                    group === "favorite" &&
                    groupLabel("Starred", index === 0)}
                  {startsGroup &&
                    favoriteCount > 0 &&
                    group === "visible" &&
                    groupLabel("All", index === 0)}
                  {startsGroup &&
                    group === "hidden" &&
                    groupLabel("Hidden from picker", index === 0)}
                  <ModelRow
                    model={model}
                    capabilities={capabilityLabels(priceForModel(prices, model.id))}
                    starred={group === "favorite"}
                    hidden={group === "hidden"}
                    canMoveUp={!filtering && at > 0 && groupOf(display[at - 1]!) === group}
                    canMoveDown={
                      !filtering && at < display.length - 1 && groupOf(display[at + 1]!) === group
                    }
                    showMove={!filtering}
                    onStar={() => toggle(item.agentType, model.id)}
                    onMove={(direction) => move(model.id, direction)}
                    onShow={(show) => setHidden([model.id], !show)}
                    onRemove={() => removeCustom(model.id)}
                  />
                </div>
              );
            })}
          </div>

          {adding && (
            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                void add();
              }}
            >
              <Input
                size="sm"
                autoFocus
                spellCheck={false}
                className="font-mono"
                placeholder={placeholder}
                aria-label="Custom model id"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setAdding(false);
                  setDraft("");
                  setError(null);
                }}
              />
              <div className="flex shrink-0 gap-2">
                <Button type="submit" size="sm" variant="outline">
                  Add
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAdding(false);
                    setDraft("");
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}

function ModelRow({
  model,
  capabilities,
  starred,
  hidden,
  canMoveUp,
  canMoveDown,
  showMove,
  onStar,
  onMove,
  onShow,
  onRemove,
}: {
  model: ArrangedModel;
  capabilities: string[];
  starred: boolean;
  hidden: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  showMove: boolean;
  onStar: () => void;
  onMove: (direction: -1 | 1) => void;
  onShow: (show: boolean) => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "grid h-8 grid-cols-[1.5rem_minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded-md px-2 transition-colors duration-fast hover:bg-element-hover",
        hidden && "opacity-50",
      )}
    >
      <Hint label={starred ? "Unstar" : "Star"}>
        <IconButton
          icon={starred ? StarFilled : Star}
          size="xs"
          active={starred}
          aria-pressed={starred}
          label={`${starred ? "Unstar" : "Star"} ${model.name}`}
          aria-label={`${starred ? "Unstar" : "Star"} ${model.name}`}
          onClick={onStar}
        />
      </Hint>
      <span className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 truncate text-xs",
            hidden ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {model.name}
        </span>
        {model.name !== model.id && (
          <code className="truncate font-mono text-2xs text-muted-foreground">{model.id}</code>
        )}
        {model.custom && <span className="shrink-0 text-2xs text-muted-foreground">custom</span>}
      </span>
      <span className="hidden text-2xs text-muted-foreground sm:inline">
        {capabilities.join(" · ")}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        {showMove && !hidden && (
          <>
            <Hint label="Move up">
              <IconButton
                icon={ArrowUp}
                size="xs"
                label={`Move ${model.name} up`}
                aria-label={`Move ${model.name} up`}
                disabled={!canMoveUp}
                onClick={() => onMove(-1)}
              />
            </Hint>
            <Hint label="Move down">
              <IconButton
                icon={ArrowDown}
                size="xs"
                label={`Move ${model.name} down`}
                aria-label={`Move ${model.name} down`}
                disabled={!canMoveDown}
                onClick={() => onMove(1)}
              />
            </Hint>
          </>
        )}
        {model.custom && (
          <Hint label="Remove custom model">
            <IconButton icon={X} size="xs" label={`Remove ${model.id}`} onClick={onRemove} />
          </Hint>
        )}
      </span>
      <Hint
        label={
          model.custom
            ? "A custom model is always in the picker"
            : hidden
              ? "Hidden from picker"
              : "In the picker"
        }
      >
        <span className="flex shrink-0 items-center">
          <Switch
            size="sm"
            checked={!hidden}
            disabled={model.custom}
            aria-label={`Show ${model.name} in the model picker`}
            onCheckedChange={onShow}
          />
        </span>
      </Hint>
    </div>
  );
}
