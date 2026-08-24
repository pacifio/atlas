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
  Eye,
  EyeOff,
  Lock,
} from "lucide-react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { SecretInput } from "@/ui/secret-input";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { tildePath } from "@/lib/paths";
import { AtlasLoader } from "@/components/atlas-loader";
import { ProviderLogo } from "@/components/provider-logo";
import {
  PROVIDERS,
  PROVIDER_CATEGORIES,
  type ProviderCategory,
  type ProviderDef,
} from "../lib/providers";
import { useByokStore } from "../stores/byok-store";
import { byok, type EnvEntry } from "../lib/byok-api";

/**
 * API keys — an editor for the provider keys in the user's shell profile.
 *
 * Atlas stores nothing. Every row here is an `export VAR=...` line in a real
 * file, and editing one rewrites that line. A key set somewhere Atlas can see
 * but not edit (launchd, `/etc/profile`, a wrapper script) is shown read-only
 * rather than duplicated — there is deliberately no Atlas-owned copy that could
 * drift from the environment the user's other tools read.
 */

type SortKey = "name" | "category" | "configured";

const SORT_LABELS: Record<SortKey, string> = {
  name: "Name (A–Z)",
  category: "Category",
  configured: "Set first",
};

// Column widths shared by the header + every row so cells line up. Fixed
// widths (Provider grows) inside a min-width track so columns never collapse
// or overlap — the table scrolls horizontally when the panel is narrow.
const COL = {
  provider: "flex-1 min-w-[200px]",
  env: "w-[200px] shrink-0",
  category: "w-[120px] shrink-0",
  key: "w-[100px] shrink-0",
  source: "w-[200px] shrink-0",
  chevron: "w-[32px] shrink-0",
} as const;

const TABLE_MIN_W = 200 + 200 + 120 + 100 + 200 + 32; // 852

export function ProvidersSettings() {
  const entries = useByokStore.use.entries();
  const profile = useByokStore.use.profile();
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

  /** provider id → the entry Atlas resolved for it (any recognised spelling). */
  const byProvider = useMemo(() => {
    const m: Record<string, EnvEntry> = {};
    for (const e of entries) if (!m[e.provider]) m[e.provider] = e;
    return m;
  }, [entries]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = PROVIDERS.filter((p) => {
      if (category !== "All" && p.category !== category) return false;
      if (configuredOnly && !byProvider[p.id]) return false;
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
        const ca = byProvider[a.id] ? 0 : 1;
        const cb = byProvider[b.id] ? 0 : 1;
        if (ca !== cb) return ca - cb;
      } else if (sortKey === "category" && a.category !== b.category) {
        return PROVIDER_CATEGORIES.indexOf(a.category) - PROVIDER_CATEGORIES.indexOf(b.category);
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [category, query, sortKey, configuredOnly, byProvider]);

  const tabs: Array<{ id: ProviderCategory | "All"; label: string; count: number }> = useMemo(
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
            <span className="text-[9px] text-text-tertiary tabular-nums">{t.count}</span>
          </button>
        ))}

        <div className="flex-1" />

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

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="flex items-center justify-center w-6 h-6 shrink-0 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer outline-none transition-colors"
              title="Filters & sort"
              aria-label="Filters & sort"
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
                  {configuredOnly && <Check size={11} className="text-text-primary" />}
                </span>
                Set only
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
                  {sortKey === k && <Check size={11} className="text-text-primary" />}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
        <div style={{ minWidth: TABLE_MIN_W }}>
          <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-border-default bg-bg-base px-3 text-[10px] uppercase tracking-wider text-text-tertiary">
            <span className={COL.provider}>Provider</span>
            <span className={COL.env}>Env Var</span>
            <span className={COL.category}>Category</span>
            <span className={COL.key}>Key</span>
            <span className={COL.source}>Source</span>
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
                entry={byProvider[p.id]}
                targetFile={profile?.target ?? null}
                expanded={expandedId === p.id}
                onToggle={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
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
  entry,
  targetFile,
  expanded,
  onToggle,
}: {
  provider: ProviderDef;
  entry: EnvEntry | undefined;
  targetFile: string | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-border-subtle">
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center h-[40px] px-3 text-left transition-colors",
          expanded ? "bg-[var(--bg-elevated)]/40" : "hover:bg-bg-hover",
        )}
      >
        <span className={cn(COL.provider, "flex items-center gap-2 min-w-0")}>
          <ProviderLogo id={provider.id} size={18} />
          <span className="truncate text-[12px] text-text-primary">{provider.name}</span>
        </span>
        {/* The var it was actually found as — which may be an alias spelling. */}
        <span className={cn(COL.env, "truncate font-mono text-[10px] text-text-tertiary")}>
          {entry?.envVar ?? provider.env}
        </span>
        <span className={cn(COL.category, "truncate text-[11px] text-text-secondary")}>
          {provider.category}
        </span>
        <span className={cn(COL.key, "font-mono text-[11px]")}>
          {entry ? (
            <span className="text-text-secondary">••••{entry.last4}</span>
          ) : (
            <span className="text-text-muted">—</span>
          )}
        </span>
        <span className={cn(COL.source, "flex items-center gap-1.5 min-w-0")}>
          {!entry ? (
            <>
              <Minus size={12} className="text-text-tertiary shrink-0" />
              <span className="text-[11px] text-text-tertiary">Not set</span>
            </>
          ) : entry.editable ? (
            <span
              className="truncate font-mono text-[10px] text-text-secondary"
              title={`${entry.file}${entry.line ? `:${entry.line}` : ""}`}
            >
              {tildePath(entry.file!)}
              {entry.line ? `:${entry.line}` : ""}
            </span>
          ) : (
            <span
              className="flex items-center gap-1 text-[10px] font-medium text-text-tertiary border border-border-default rounded-full px-1.5 h-[18px]"
              title="Set outside your shell profile — Atlas can read it but not edit it."
            >
              <Lock size={9} />
              environment
            </span>
          )}
        </span>
        <span className={cn(COL.chevron, "flex items-center justify-end text-text-tertiary")}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {expanded && <ProviderEditor provider={provider} entry={entry} targetFile={targetFile} />}
    </div>
  );
}

function ProviderEditor({
  provider,
  entry,
  targetFile,
}: {
  provider: ProviderDef;
  entry: EnvEntry | undefined;
  targetFile: string | null;
}) {
  const pending = useByokStore.use.pending();
  const { save, remove } = useByokStore.use.actions();
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);

  // The var an edit writes: whatever it was found as, else the canonical one.
  const envVar = entry?.envVar ?? provider.env;
  const busy = pending === envVar;
  const readOnly = !!entry && !entry.editable;
  const writesTo = entry?.file ?? targetFile;

  const onSave = async () => {
    try {
      const file = await save(envVar, draft);
      setDraft("");
      setRevealed(null);
      toast.success(`${provider.name} key written to ${tildePath(file)}`, {
        action: {
          label: "Reveal",
          onClick: () => {
            revealItemInDir(file).catch((err) => {
              toast.error(
                `Couldn't reveal in Finder: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          },
        },
      });
    } catch (e) {
      toast.error(`Couldn't save key: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onRemove = async () => {
    try {
      await remove(envVar);
      setRevealed(null);
      toast.success(`Removed ${envVar} from your shell profile`);
    } catch (e) {
      toast.error(`Couldn't remove key: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onReveal = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    try {
      setRevealed((await byok.reveal(envVar)) ?? "");
    } catch {
      toast.error("Couldn't read that value.");
    }
  };

  return (
    <div className="bg-[var(--bg-elevated)]/40 border-t border-border-subtle px-3 py-3">
      {readOnly && (
        <p className="mb-2.5 max-w-[640px] text-[10.5px] leading-snug text-text-tertiary">
          <span className="font-mono">{envVar}</span> is set outside your shell profile — Atlas
          found it in the environment but not in any file it reads, so it can&apos;t edit or remove
          it here. Change it wherever it&apos;s exported (a login script, launchd, or a wrapper).
        </p>
      )}

      {entry && (
        <div className="mb-2.5 flex items-center gap-2">
          <code className="flex-1 min-w-0 truncate rounded bg-[var(--bg-base)] border border-border-subtle px-2 py-1 font-mono text-[10.5px] text-text-secondary">
            {revealed !== null ? revealed || "(empty)" : `${envVar}=••••${entry.last4}`}
          </code>
          <button
            type="button"
            onClick={() => void onReveal()}
            title={revealed !== null ? "Hide" : "Reveal"}
            className="flex items-center justify-center h-6 w-6 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            {revealed !== null ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
          {revealed !== null && revealed && (
            <button
              type="button"
              onClick={() => void copyText(revealed)}
              className="h-6 rounded-md px-2 text-[10.5px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              Copy
            </button>
          )}
        </div>
      )}

      {!readOnly && (
        <div className="flex items-start gap-3 max-w-[640px]">
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium text-text-primary">
                {entry ? "Replace key" : "API key"}
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
                {entry ? "Update" : "Save"}
              </button>
              {entry && (
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
            </div>
            <p className="pt-0.5 font-mono text-[10px] text-text-tertiary">
              {entry ? "Rewrites" : "Appends"}{" "}
              <span className="text-text-secondary">export {envVar}=…</span>
              {writesTo ? ` in ${tildePath(writesTo)}` : ""}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
