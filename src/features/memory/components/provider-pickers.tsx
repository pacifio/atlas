import { useEffect, useMemo, useState } from "react";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { Loader2, ChevronDown, Search, Check } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import { providerById } from "@/features/settings/lib/providers";
import { modelchat } from "@/lib/byok/byok-chat";

// Provider + model selectors for Memory ▸ Chat's "Use Provider" mode. Visually
// identical to the general LLM chat composer's pickers; kept here (rather than
// importing model-chat internals) so model-chat stays untouched.

// Per-session model-id cache so switching provider doesn't re-hit the API.
const modelListCache = new Map<string, string[]>();
const modelListInFlight = new Map<string, Promise<string[]>>();
function loadModelIds(provider: string): Promise<string[]> {
  const cached = modelListCache.get(provider);
  if (cached) return Promise.resolve(cached);
  const inflight = modelListInFlight.get(provider);
  if (inflight) return inflight;
  const p = modelchat
    .models(provider)
    .then((list) => {
      const ids = list.map((m) => m.id);
      modelListCache.set(provider, ids);
      modelListInFlight.delete(provider);
      return ids;
    })
    .catch((e) => {
      modelListInFlight.delete(provider);
      throw e;
    });
  modelListInFlight.set(provider, p);
  return p;
}

function PickerDropdown({
  trigger,
  children,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        render={
          <button className="flex min-w-0 items-center gap-1.5 h-control-md rounded-full border border-border bg-card px-2 text-2xs font-medium text-secondary-foreground hover:bg-element-hover hover:text-foreground transition-colors outline-none cursor-pointer">
            {trigger}
          </button>
        }
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" align="start" side="top" sideOffset={6}>
          <DropdownMenu.Popup className="max-h-[340px] min-w-[180px] overflow-y-auto rounded-md border border-border bg-card py-1 shadow-md">
            {children}
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ModelCombo({
  models,
  value,
  loading,
  onSelect,
}: {
  models: string[];
  value: string;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? models.filter((m) => m.toLowerCase().includes(s)) : models;
  }, [models, q]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <Popover.Trigger
        render={
          <button className="flex min-w-0 items-center gap-1.5 h-control-md rounded-full border border-border bg-card px-2 text-2xs font-medium text-secondary-foreground hover:bg-element-hover hover:text-foreground transition-colors outline-none cursor-pointer">
            {loading && <Loader2 size={11} className="animate-spin text-muted-foreground" />}
            <span className="max-w-[160px] truncate font-mono">
              {value || (loading ? "Loading…" : "Select model")}
            </span>
            <ChevronDown size={11} className="text-muted-foreground" />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner className="z-popover" align="start" side="top" sideOffset={6}>
          <Popover.Popup className="w-[260px] overflow-hidden rounded-md border border-border bg-card shadow-md">
            <div className="flex items-center gap-1.5 h-8 border-b border-border-subtle px-2.5">
              <Search size={12} className="shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search models…"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-[300px] overflow-y-auto hide-scrollbar py-1">
              {filtered.length === 0 ? (
                <div className="px-2.5 py-2 text-xs text-muted-foreground">
                  {loading ? "Loading…" : "No models"}
                </div>
              ) : (
                filtered.map((id) => (
                  <button
                    key={id}
                    onClick={() => {
                      onSelect(id);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-2.5 h-control-md text-left text-xs font-mono text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-pointer outline-none"
                  >
                    <span className="flex-1 truncate">{id}</span>
                    {id === value && <Check size={11} className="text-foreground" />}
                  </button>
                ))
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Provider pill + searchable model combo. Loads the provider's model list and
 *  auto-selects the first model when none is chosen. */
export function ProviderModelSelector({
  configured,
  provider,
  model,
  onProvider,
  onModel,
}: {
  configured: { id: string; name: string }[];
  provider: string;
  model: string;
  onProvider: (id: string) => void;
  onModel: (id: string) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!provider) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadModelIds(provider)
      .then((ids) => {
        if (cancelled) return;
        setModels(ids);
        if (!model && ids.length > 0) onModel(ids[0]);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  return (
    <>
      <PickerDropdown
        trigger={
          <>
            {provider && <ProviderLogo id={provider} size={13} />}
            <span className="max-w-[100px] truncate">
              {provider ? (providerById(provider)?.name ?? provider) : "Provider"}
            </span>
            <ChevronDown size={11} className="text-muted-foreground" />
          </>
        }
      >
        {configured.map((p) => (
          <DropdownMenu.Item
            key={p.id}
            onClick={() => onProvider(p.id)}
            className="flex items-center gap-2 px-2.5 h-[28px] text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-pointer outline-none"
          >
            <ProviderLogo id={p.id} size={14} />
            <span className="flex-1 truncate">{p.name}</span>
            {p.id === provider && <Check size={12} className="text-foreground" />}
          </DropdownMenu.Item>
        ))}
      </PickerDropdown>
      <ModelCombo models={models} value={model} loading={loading} onSelect={onModel} />
    </>
  );
}
