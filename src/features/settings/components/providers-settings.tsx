import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Search,
  Check,
  Minus,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Trash2,
  MoreHorizontal,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SecretInput } from "@/ui/secret-input";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { AtlasLoader } from "@/components/atlas-loader";
import { ProviderLogo } from "@/components/provider-logo";
import {
  PROVIDERS,
  PROVIDER_CATEGORIES,
  type ProviderCategory,
  type ProviderDef,
} from "../lib/providers";
import { useByokStore } from "../stores/byok-store";
import type { ProviderKeyMeta } from "../lib/byok-api";

/**
 * BYOK provider/key manager — a full-bleed, monochromatic data table inspired
 * by the Vercel AI Gateway model browser: category tabs + search + sort in a
 * top toolbar, then a dense table of every supported provider. Each row expands
 * inline to add / replace / remove its key. Secrets live in the OS keychain
 * (Rust `byok.rs`); this UI only ever shows metadata (last-4 + added-at).
 */

type SortKey = "name" | "category" | "configured";

const SORT_LABELS: Record<SortKey, string> = {
  name: "Name (A–Z)",
  category: "Category",
  configured: "Configured first",
};

// Column widths shared by the header + every row so cells line up. Fixed
// widths (Provider grows) inside a min-width track so columns never collapse
// or overlap — the table scrolls horizontally when the panel is narrow.
const COL = {
  provider: "flex-1 min-w-[200px]",
  env: "w-[200px] shrink-0",
  category: "w-[130px] shrink-0",
  key: "w-[110px] shrink-0",
  added: "w-[100px] shrink-0",
  status: "w-[120px] shrink-0",
  chevron: "w-[32px] shrink-0",
} as const;

// Sum of the fixed columns (+ Provider's min) — the horizontal scroll track.
const TABLE_MIN_W = 200 + 200 + 130 + 110 + 100 + 120 + 32; // 892

export function ProvidersSettings() {
  const keys = useByokStore.use.keys();
  const loaded = useByokStore.use.loaded();
  const { load } = useByokStore.use.actions();

  const [category, setCategory] = useState<ProviderCategory | "All">("All");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [configuredOnly, setConfiguredOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = PROVIDERS.filter((p) => {
      if (category !== "All" && p.category !== category) return false;
      if (configuredOnly && !keys[p.id]) return false;
      if (
        q &&
        !p.name.toLowerCase().includes(q) &&
        !p.id.includes(q) &&
        !p.env.toLowerCase().includes(q)
      )
        return false;
      return true;
    });

    list = [...list].sort((a, b) => {
      if (sortKey === "configured") {
        const ca = keys[a.id] ? 0 : 1;
        const cb = keys[b.id] ? 0 : 1;
        if (ca !== cb) return ca - cb;
      } else if (sortKey === "category" && a.category !== b.category) {
        return (
          PROVIDER_CATEGORIES.indexOf(a.category) -
          PROVIDER_CATEGORIES.indexOf(b.category)
        );
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [category, query, sortKey, configuredOnly, keys]);

  const tabs: Array<{
    id: ProviderCategory | "All";
    label: string;
    count: number;
  }> = useMemo(
    () => [
      { id: "All", label: "All", count: PROVIDERS.length },
      ...PROVIDER_CATEGORIES.map((c) => ({
        id: c,
        label: c,
        count: PROVIDERS.filter((p) => p.category === c).length,
      })),
    ],
    [],
  );

  return (
    <div className="h-full flex flex-col bg-bg-base">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 h-[40px] shrink-0 border-b border-border-default">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setCategory(t.id)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 h-[40px] text-[11px] font-medium transition-colors border-b-2 -mb-px",
              category === t.id
                ? "text-text-primary border-b-[var(--accent-primary)]"
                : "text-text-secondary hover:text-text-primary border-b-transparent",
            )}
          >
            {t.label}
            <span className="text-[9px] text-text-tertiary tabular-nums">
              {t.count}
            </span>
          </button>
        ))}

        <div className="flex-1" />

        {/* Search */}
        <div className="flex items-center gap-1.5 h-6 rounded-md border border-border-default bg-bg-elevated px-2 min-w-[200px] focus-within:border-[var(--border-focus)]">
          <Search size={11} className="text-text-tertiary shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search providers…"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary"
          />
        </div>

        {/* Filters + sort — collapsed into a dotted menu next to the search,
            so the toolbar never overflows in the narrow settings pane. */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="flex items-center justify-center w-6 h-6 shrink-0 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer outline-none transition-colors"
              title="Filters & sort"
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)] py-1 min-w-[180px]"
              style={{ zIndex: 9999 }}
            >
              <DropdownMenu.CheckboxItem
                checked={configuredOnly}
                onCheckedChange={(c) => setConfiguredOnly(!!c)}
                className="flex items-center gap-2 px-3 h-[26px] text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none"
              >
                <span className="inline-flex w-3.5 justify-center">
                  {configuredOnly && (
                    <Check size={11} className="text-text-primary" />
                  )}
                </span>
                Configured only
              </DropdownMenu.CheckboxItem>

              <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />

              <DropdownMenu.Label className="px-3 pb-1 pt-1 text-[9px] uppercase tracking-wider text-text-tertiary">
                Sort by
              </DropdownMenu.Label>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <DropdownMenu.Item
                  key={k}
                  onSelect={() => setSortKey(k)}
                  className="flex items-center justify-between gap-2 px-3 h-[26px] text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none"
                >
                  {SORT_LABELS[k]}
                  {sortKey === k && (
                    <Check size={11} className="text-text-primary" />
                  )}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* Table — both-axis scroll. The min-width track keeps columns from
          collapsing/overlapping when the panel is narrow; the header sticks. */}
      <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
        <div style={{ minWidth: TABLE_MIN_W }}>
          {/* Header row (sticky) */}
          <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-border-default bg-bg-base px-3 text-[10px] uppercase tracking-wider text-text-tertiary">
            <span className={COL.provider}>Provider</span>
            <span className={COL.env}>Env Var</span>
            <span className={COL.category}>Category</span>
            <span className={COL.key}>Key</span>
            <span className={COL.added}>Added</span>
            <span className={COL.status}>Status</span>
            <span className={COL.chevron} />
          </div>

          {rows.length === 0 ? (
            <div className="grid place-items-center h-[160px] text-[11px] text-text-tertiary">
              No providers match.
            </div>
          ) : (
            rows.map((p) => (
              <ProviderTableRow
                key={p.id}
                provider={p}
                meta={keys[p.id]}
                expanded={expandedId === p.id}
                onToggle={() =>
                  setExpandedId((cur) => (cur === p.id ? null : p.id))
                }
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderTableRow({
  provider,
  meta,
  expanded,
  onToggle,
}: {
  provider: ProviderDef;
  meta: ProviderKeyMeta | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const configured = !!meta;

  return (
    <div className="border-b border-border-subtle">
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center h-[40px] px-3 text-left transition-colors",
          expanded ? "bg-[var(--bg-elevated)]/40" : "hover:bg-bg-hover",
        )}
      >
        {/* Provider */}
        <span className={cn(COL.provider, "flex items-center gap-2 min-w-0")}>
          <ProviderLogo id={provider.id} size={18} />
          <span className="truncate text-[12px] text-text-primary">
            {provider.name}
          </span>
        </span>
        {/* Env var */}
        <span
          className={cn(
            COL.env,
            "truncate font-mono text-[10px] text-text-tertiary",
          )}
        >
          {provider.env}
        </span>
        {/* Category */}
        <span
          className={cn(
            COL.category,
            "truncate text-[11px] text-text-secondary",
          )}
        >
          {provider.category}
        </span>
        {/* Key */}
        <span className={cn(COL.key, "font-mono text-[11px]")}>
          {configured ? (
            <span className="text-text-secondary">••••{meta!.last4}</span>
          ) : (
            <span className="text-text-muted">—</span>
          )}
        </span>
        {/* Added */}
        <span className={cn(COL.added, "text-[10px] text-text-tertiary")}>
          {configured ? timeAgo(meta!.addedAt, { suffix: true }) : "—"}
        </span>
        {/* Status */}
        <span className={cn(COL.status, "flex items-center gap-1.5")}>
          {configured ? (
            <>
              <Check size={12} className="text-text-primary" />
              <span className="text-[11px] text-text-primary">Configured</span>
            </>
          ) : (
            <>
              <Minus size={12} className="text-text-tertiary" />
              <span className="text-[11px] text-text-tertiary">Not set</span>
            </>
          )}
        </span>
        {/* Chevron */}
        <span
          className={cn(
            COL.chevron,
            "flex items-center justify-end text-text-tertiary",
          )}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {expanded && <ProviderEditor provider={provider} meta={meta} />}
    </div>
  );
}

function ProviderEditor({
  provider,
  meta,
}: {
  provider: ProviderDef;
  meta: ProviderKeyMeta | undefined;
}) {
  const pending = useByokStore.use.pending();
  const { save, remove } = useByokStore.use.actions();
  const [draft, setDraft] = useState("");
  const busy = pending === provider.id;
  const configured = !!meta;

  const onSave = async () => {
    try {
      await save(provider.id, draft);
      setDraft("");
      toast.success(`${provider.name} key saved`);
    } catch (e) {
      toast.error(
        `Couldn't save key: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const onRemove = async () => {
    try {
      await remove(provider.id);
      toast.success(`${provider.name} key removed`);
    } catch (e) {
      toast.error(
        `Couldn't remove key: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  return (
    <div className="bg-[var(--bg-elevated)]/40 border-t border-border-subtle px-3 py-3">
      <div className="flex items-start gap-3 max-w-[640px]">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-medium text-text-primary">
              {configured ? "Replace key" : "API key"}
            </label>
            {provider.docsUrl && (
              <button
                type="button"
                onClick={() => void openUrl(provider.docsUrl!)}
                className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
              >
                Get key
                <ExternalLink size={10} />
              </button>
            )}
          </div>
          <SecretInput
            value={draft}
            onValueChange={setDraft}
            onSubmit={() => void onSave()}
            placeholder={provider.placeholder ?? "Paste your API key"}
            disabled={busy}
            autoFocus
          />
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={busy || !draft.trim()}
              className={cn(
                "flex items-center gap-1.5 h-7 rounded-md px-3 text-[11px] font-medium",
                "bg-[var(--accent-primary)] text-[var(--bg-base)]",
                "hover:opacity-90 transition-opacity",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              {busy && <AtlasLoader size={11} />}
              {configured ? "Update" : "Save"}
            </button>
            {configured && (
              <button
                type="button"
                onClick={() => void onRemove()}
                disabled={busy}
                className="flex items-center gap-1 h-7 rounded-md px-2.5 text-[11px] text-text-tertiary hover:text-[var(--danger,#e5484d)] hover:bg-bg-hover transition-colors disabled:opacity-50"
              >
                <Trash2 size={12} />
                Remove
              </button>
            )}
            <span className="text-[10px] text-text-tertiary font-mono pl-1">
              {provider.env}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
