//! Single model combo for the native Atlas agent composer.
//!
//! The ACP agents (Claude Code / Codex) advertise their own models through the
//! agent process, but the in-process native agent picks its provider+model from
//! the user's BYOK keys. To keep the composer compact (it was growing a long
//! row of pills), provider + model are collapsed into ONE Cursor-style combo:
//! a pill showing the active model, opening a popover with provider chips + a
//! searchable model list (strong coding models pinned + starred via the shared
//! coding-model catalog).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useModelPricingStore,
  priceFor,
  formatPrice,
} from "@/features/settings/stores/model-pricing-store";
import { CHAT_PROVIDERS } from "@/features/settings/lib/providers";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { modelchat } from "@/lib/byok/byok-chat";
import {
  curateModels,
  defaultModelFor,
  isPreferredModel,
  preferredModels,
} from "@/features/settings/lib/model-catalog";
import { loadNativeModelPref } from "../lib/native-model-pref";
import { ProviderModelPillsView } from "./views/provider-model-pills-view";

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

export function ProviderModelPills({
  provider,
  model,
  onProvider,
  onModel,
}: {
  provider: string;
  model: string;
  onProvider: (id: string) => void;
  onModel: (id: string) => void;
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
  const prefRef = useRef(loadNativeModelPref());

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
      const remembered = pref?.provider === provider ? pref.model : undefined;
      onModel(defaultModelFor(provider, ids, remembered) ?? ids[0]);
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
    void import("@/features/settings/lib/open-settings").then(({ openSettingsSection }) =>
      openSettingsSection("agents", "provider-keys"),
    );
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

  const providers = useMemo(
    () => CHAT_PROVIDERS.map((p) => ({ id: p.id, name: p.name, keyed: hasKey(p.id) })),
    [hasKey],
  );
  const onOpenChange = useCallback((o: boolean) => {
    setOpen(o);
    if (!o) setQ("");
  }, []);
  const pricing = useMemo(
    () => ({
      label: (id: string) => formatPrice(priceFor(prices, viewProvider, id), pricingLoading),
      loading: pricingLoading,
      onRefresh: () => void refreshPricing(),
    }),
    [prices, viewProvider, pricingLoading, refreshPricing],
  );

  return (
    <ProviderModelPillsView
      provider={provider}
      model={model}
      viewProvider={viewProvider}
      providers={providers}
      hasKey={hasKey(viewProvider)}
      models={{ pinned, rest }}
      loadingModels={loadingModels}
      query={q}
      onQuery={setQ}
      open={open}
      onOpenChange={onOpenChange}
      onBrowse={setViewProvider}
      onPick={pickModel}
      onSetUpKey={openApiKeys}
      pricing={pricing}
    />
  );
}
