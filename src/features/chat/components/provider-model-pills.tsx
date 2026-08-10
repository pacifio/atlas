//! Single model combo for the native Atlas (Cersei) agent composer.
//!
//! The ACP agents (Claude Code / Codex) advertise their own models through the
//! agent process, but the in-process Cersei agent picks its provider+model from
//! the user's BYOK keys. To keep the composer compact (it was growing a long
//! row of pills), provider + model are collapsed into ONE Cursor-style combo:
//! a pill showing the active model, opening a popover with provider chips + a
//! searchable model list (strong coding models pinned + starred via the shared
//! coding-model catalog).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Loader2, RefreshCw, Search, Star } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import {
  useModelPricingStore,
  priceFor,
  formatPrice,
} from "@/features/settings/stores/model-pricing-store";
import { CHAT_PROVIDERS, providerById } from "@/features/settings/lib/providers";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { modelchat } from "@/features/model-chat/lib/model-chat-api";
import {
  curateModels,
  defaultModelFor,
  isPreferredModel,
  preferredModels,
} from "@/features/review-agents/lib/model-catalog";
import { loadCerseiModelPref } from "../lib/cersei-model-pref";
import { cn } from "@/lib/utils";

// Curated model-list cache — `modelchat.models(provider)` hits the provider API,
// so cache the curated list per provider for the app session and dedupe
// in-flight requests. The list is run through `curateModels` so coding models
// rank first and embeddings/TTS/etc. are dropped.
const modelListCache = new Map<string, string[]>();
const modelListInFlight = new Map<string, Promise<string[]>>();
function loadModelIds(provider: string): Promise<string[]> {
  const cached = modelListCache.get(provider);
  if (cached) return Promise.resolve(cached);
  const inflight = modelListInFlight.get(provider);
  if (inflight) return inflight;
  const p = modelchat
    .models(provider)
    .then((rows) => {
      const curated = curateModels(
        provider,
        rows.map((r) => r.id),
      );
      modelListCache.set(provider, curated);
      modelListInFlight.delete(provider);
      return curated;
    })
    .catch((e) => {
      modelListInFlight.delete(provider);
      throw e;
    });
  modelListInFlight.set(provider, p);
  return p;
}

const PILL_CLASS =
  "flex min-w-0 items-center gap-1.5 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors outline-none cursor-pointer";

export function ProviderModelPills({
  provider,
  model,
  onProvider,
  onModel,
  compress = false,
  onCompress,
  showCompress = true,
}: {
  provider: string;
  model: string;
  onProvider: (id: string) => void;
  onModel: (id: string) => void;
  /** RTK compression toggle — agent-composer only. Omit for plain BYOK pickers. */
  compress?: boolean;
  onCompress?: (on: boolean) => void;
  showCompress?: boolean;
}) {
  const keys = useByokStore.use.keys();
  const loaded = useByokStore.use.loaded();
  const { load } = useByokStore.use.actions();

  // Self-heal: make sure the BYOK keys are loaded before we read them.
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const configuredIds = useMemo(
    () => CHAT_PROVIDERS.filter((p) => !!keys[p.id]).map((p) => p.id),
    [keys],
  );
  const hasKey = useCallback((id: string) => !!keys[id], [keys]);

  // Last-used selection (persisted) — seeds a fresh composer.
  const prefRef = useRef(loadCerseiModelPref());

  // Default the committed provider: remembered (if still keyed), else first keyed.
  useEffect(() => {
    if (provider || configuredIds.length === 0) return;
    const pref = prefRef.current;
    const next = pref && configuredIds.includes(pref.provider) ? pref.provider : configuredIds[0];
    onProvider(next);
  }, [provider, configuredIds, onProvider]);

  // The provider being BROWSED in the rail — defaults to the committed one but
  // can point at an unconfigured provider (to show the "Set up key" prompt).
  const [viewProvider, setViewProvider] = useState(provider);
  useEffect(() => {
    setViewProvider(provider || configuredIds[0] || CHAT_PROVIDERS[0]?.id || "");
  }, [provider, configuredIds]);

  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    // Only load when the browsed provider has a key; otherwise the main column
    // shows the setup-key prompt.
    if (!viewProvider || !hasKey(viewProvider)) {
      setModels([]);
      return;
    }
    let cancelled = false;
    const apply = (ids: string[]) => {
      if (cancelled) return;
      setModels(ids);
      // Auto-pick a default ONLY for the committed provider — browsing another
      // provider must never commit a model.
      if (viewProvider !== provider || model || ids.length === 0) return;
      const pref = prefRef.current;
      const remembered =
        pref && pref.provider === provider && ids.includes(pref.model) ? pref.model : null;
      onModel(remembered ?? defaultModelFor(provider, ids) ?? ids[0]);
    };
    const cached = modelListCache.get(viewProvider);
    if (cached) {
      apply(cached);
      setLoadingModels(false);
      return;
    }
    setLoadingModels(true);
    loadModelIds(viewProvider)
      .then(apply)
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewProvider, provider, model, onModel, hasKey]);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  // Commit a model pick — also commit the browsed provider if it changed.
  const pickModel = useCallback(
    (id: string) => {
      if (viewProvider && viewProvider !== provider) onProvider(viewProvider);
      onModel(id);
      setOpen(false);
    },
    [viewProvider, provider, onProvider, onModel],
  );

  const openApiKeys = useCallback(() => {
    void import("@/features/layout/stores/layout-store").then(({ useLayoutStore }) => {
      useLayoutStore.getState().actions.addTab({
        id: "settings",
        type: "settings",
        title: "Settings",
        closable: true,
        dirty: false,
        data: { section: "providers" },
      });
    });
    setOpen(false);
  }, []);

  // Model pricing (models.dev, cached by Rust) — shows $/1M per model.
  const prices = useModelPricingStore.use.prices();
  const pricingLoading = useModelPricingStore.use.loading();
  const { load: loadPricing, refresh: refreshPricing } = useModelPricingStore.use.actions();
  useEffect(() => {
    void loadPricing();
  }, [loadPricing]);

  const { pinned, rest } = useMemo(() => {
    const s = q.trim().toLowerCase();
    const match = (m: string) => (s ? m.toLowerCase().includes(s) : true);
    const order = preferredModels(viewProvider);
    const pinnedSet = new Set(models.filter((m) => isPreferredModel(viewProvider, m)));
    return {
      pinned: order.filter((m) => pinnedSet.has(m) && match(m)),
      rest: models.filter((m) => !pinnedSet.has(m) && match(m)),
    };
  }, [viewProvider, models, q]);

  const renderModel = (id: string, starred: boolean) => {
    const price = formatPrice(priceFor(prices, viewProvider, id), pricingLoading);
    return (
      <button
        key={id}
        onClick={() => pickModel(id)}
        className="flex w-full items-center gap-2 px-2.5 h-[26px] text-left text-[11px] font-mono text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer outline-none"
      >
        {starred && (
          <Star
            size={10}
            className="shrink-0 fill-[var(--accent-primary)] text-[var(--accent-primary)]"
          />
        )}
        <span className="min-w-0 flex-1 truncate">{id}</span>
        <span
          className="shrink-0 text-[10px] tabular-nums text-[var(--text-tertiary)]"
          title="Price per 1M tokens (input / output) — models.dev"
        >
          {price}
        </span>
        {viewProvider === provider && id === model && (
          <Check size={11} className="shrink-0 text-[var(--text-primary)]" />
        )}
      </button>
    );
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <Popover.Trigger asChild>
        <button className={PILL_CLASS} title="Model — click to choose provider + model">
          <ProviderLogo id={provider || viewProvider} size={13} />
          {loadingModels && (
            <Loader2 size={10} className="animate-spin text-[var(--text-tertiary)]" />
          )}
          <span className="max-w-[150px] truncate font-mono">
            {model || (loadingModels ? "Loading…" : "Select model")}
          </span>
          <ChevronDown size={11} className="text-[var(--text-tertiary)]" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={6}
          className="z-[9999] w-[360px] overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)]"
        >
          <div className="flex max-h-[420px]">
            {/* Provider rail — ALWAYS shown, lists every chat provider. Ones
                without a key are dimmed; selecting one shows the setup prompt. */}
            <div className="flex w-9 shrink-0 flex-col items-center gap-1 border-r border-[var(--border-subtle)] py-1.5 min-h-0 overflow-y-auto hide-scrollbar">
              {CHAT_PROVIDERS.map((p) => {
                const keyed = hasKey(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => setViewProvider(p.id)}
                    title={`${p.name}${keyed ? "" : " — no API key"}`}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-md transition-all",
                      p.id === viewProvider
                        ? "bg-[var(--bg-selected,var(--bg-hover))]"
                        : keyed
                          ? "opacity-60 hover:opacity-100 hover:bg-[var(--bg-hover)]"
                          : "opacity-25 hover:opacity-60 hover:bg-[var(--bg-hover)]",
                    )}
                  >
                    <ProviderLogo id={p.id} size={15} />
                  </button>
                );
              })}
            </div>

            <div className="flex min-w-0 flex-1 flex-col min-h-0">
              {hasKey(viewProvider) ? (
                <>
                  {/* Search + pricing refresh */}
                  <div className="flex items-center gap-1.5 h-8 border-b border-[var(--border-subtle)] px-2.5">
                    <Search size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                    <input
                      autoFocus
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search models…"
                      spellCheck={false}
                      className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
                    />
                    <button
                      onClick={() => void refreshPricing()}
                      disabled={pricingLoading}
                      title="Refresh model pricing (models.dev)"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer disabled:cursor-default"
                    >
                      <RefreshCw size={11} className={cn(pricingLoading && "animate-spin")} />
                    </button>
                  </div>

                  {/* Model list (name + $/1M) — fills the column height so the
                      popover has no dead "footer" gap below it. */}
                  <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar py-1">
                    {pinned.length === 0 && rest.length === 0 ? (
                      <div className="px-2.5 py-2 text-[11px] text-[var(--text-tertiary)]">
                        {loadingModels ? "Loading…" : "No models"}
                      </div>
                    ) : (
                      <>
                        {pinned.length > 0 && (
                          <>
                            <div className="px-2.5 pt-1 pb-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                              Recommended for coding
                            </div>
                            {pinned.map((id) => renderModel(id, true))}
                            {rest.length > 0 && (
                              <div className="my-1 h-px bg-[var(--border-subtle)]" />
                            )}
                          </>
                        )}
                        {rest.map((id) => renderModel(id, false))}
                      </>
                    )}
                  </div>
                </>
              ) : (
                /* No key for the browsed provider — prompt to set one up. */
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
                  <ProviderLogo id={viewProvider} size={22} />
                  <div className="text-[12px] text-[var(--text-secondary)]">
                    No API key for{" "}
                    <span className="text-[var(--text-primary)]">
                      {providerById(viewProvider)?.name ?? viewProvider}
                    </span>
                  </div>
                  <button
                    onClick={openApiKeys}
                    className="rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                  >
                    Set up key in Settings
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* RTK compression toggle (Cursor "MAX Mode"-style footer). */}
          {showCompress && (
            <button
              onClick={() => onCompress?.(!compress)}
              className="flex w-full items-center gap-2 border-t border-[var(--border-subtle)] px-2.5 py-2 text-left text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer outline-none"
              title="Tool-output compression — shrinks tool results to save tokens"
            >
              <span className="flex-1">Compress Tokens</span>
              <span
                className={cn(
                  "flex h-3.5 w-6 items-center rounded-full px-0.5 transition-colors",
                  compress
                    ? "bg-[var(--accent-primary)] justify-end"
                    : "bg-[var(--bg-base)] justify-start",
                )}
              >
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--bg-elevated)]" />
              </span>
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
