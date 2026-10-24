import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowUpRight, Lock, MoreHorizontal, X } from "lucide-react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { copyText } from "@/lib/clipboard";
import { tildePath } from "@/lib/paths";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { IconButton } from "@/ui/icon-button";
import { SecretInput } from "@/ui/secret-input";
import { Segmented } from "@/ui/segmented";
import { Hint } from "@/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { ProviderLogo } from "@/components/provider-logo";
import {
  PROVIDERS,
  PROVIDER_CATEGORIES,
  type ProviderCategory,
  type ProviderDef,
} from "../../lib/providers";
import { useByokStore } from "../../stores/byok-store";
import { byok, type EnvEntry } from "../../lib/byok-api";
import {
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "../layout/settings-layout";
import { SettingsSearch } from "../layout/settings-search";

/**
 * Settings → Agents → Provider keys: an editor for the provider keys in the
 * user's shell profile, which agents and Model Chat read.
 *
 * Atlas stores nothing. Every row is an `export VAR=...` line in a real file,
 * and editing one rewrites that line. A key set somewhere Atlas can see but
 * not edit (launchd, `/etc/profile`, a wrapper script) is shown read-only
 * rather than duplicated — there is deliberately no Atlas-owned copy that
 * could drift from the environment the user's other tools read.
 *
 * The section opens on the keys that are set, so the page leads with the
 * agents; All, or a search, lists every provider.
 */

const CATEGORY_NOTE: Record<ProviderCategory, string> = {
  Frontier: "The model labs' own APIs.",
  Inference: "Hosts that serve open-weight models.",
  Gateway: "One key for many providers' models.",
  Embeddings: "Models that turn text into vectors for search.",
};

type Filter = "all" | "set";

export function ProviderKeysSection() {
  const entries = useByokStore.use.entries();
  const profile = useByokStore.use.profile();
  const loaded = useByokStore.use.loaded();
  const { load } = useByokStore.use.actions();
  const [query, setQuery] = useState("");
  // Unpicked, it follows the keys: Set while any is, else All.
  const [picked, setPicked] = useState<Filter | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  /** provider id → the entry Atlas resolved for it (any recognised spelling). */
  const byProvider = useMemo(() => {
    const m: Record<string, EnvEntry> = {};
    for (const e of entries) if (!m[e.provider]) m[e.provider] = e;
    return m;
  }, [entries]);

  const setCount = PROVIDERS.filter((p) => byProvider[p.id]).length;
  // The last key removed empties "Set": fall back rather than show nothing.
  const filter: Filter = setCount === 0 ? "all" : (picked ?? "set");
  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const shown = PROVIDERS.filter(
      (p) =>
        // A search looks through every provider, set or not.
        (q || filter === "all" || byProvider[p.id]) &&
        (!q ||
          p.name.toLowerCase().includes(q) ||
          p.id.includes(q) ||
          p.env.toLowerCase().includes(q)),
    );
    return PROVIDER_CATEGORIES.map((category) => ({
      category,
      providers: shown
        .filter((p) => p.category === category)
        .sort((a, b) => a.name.localeCompare(b.name)),
    })).filter((g) => g.providers.length > 0);
  }, [q, filter, byProvider]);

  const target = profile?.target ?? null;
  const alsoRead = (profile?.scanned ?? []).filter((f) => f.exists && f.path !== target);

  return (
    <SettingsSection
      title="Provider keys"
      description="API keys in your shell profile, for agents and Model Chat. Atlas reads and writes the file and keeps no copy of its own."
      anchor="provider-keys"
    >
      <div className="flex flex-col gap-3">
        <SettingsGroup>
          <SettingsRow
            anchor="shell-profile"
            title="New keys go to"
            description={
              target ? <span className="font-mono">{tildePath(target)}</span> : "Finding it…"
            }
            status={
              alsoRead.length > 0
                ? `Keys are also read from ${alsoRead.map((f) => tildePath(f.path)).join(", ")}.`
                : undefined
            }
            control={
              target && (
                <Button variant="outline" size="sm" onClick={() => void showInFinder(target)}>
                  Show in Finder
                </Button>
              )
            }
          />
        </SettingsGroup>

        <div className="flex flex-wrap items-center gap-2">
          <SettingsSearch
            value={query}
            onValueChange={setQuery}
            label="Search providers"
            placeholder="Search by provider or variable, like “OPENAI”"
          />
          {setCount > 0 && !q && (
            <Segmented
              size="sm"
              aria-label="Show"
              value={filter}
              onValueChange={setPicked}
              options={[
                { value: "set", label: `Set ${setCount}` },
                { value: "all", label: `All ${PROVIDERS.length}` },
              ]}
            />
          )}
        </div>

        {!loaded ? (
          <SettingsGroup>
            <SettingsNote>Reading your shell profile…</SettingsNote>
          </SettingsGroup>
        ) : groups.length === 0 ? (
          <SettingsGroup>
            <SettingsNote>No provider matches “{query.trim()}”.</SettingsNote>
          </SettingsGroup>
        ) : (
          groups.map((g) => (
            <div key={g.category} className="flex flex-col gap-1.5">
              <p className="caption px-1">
                <span className="font-medium text-secondary-foreground">{g.category}</span>
                {` · ${CATEGORY_NOTE[g.category]}`}
              </p>
              <SettingsGroup>
                {g.providers.map((p) => (
                  <ProviderKeyRow key={p.id} provider={p} entry={byProvider[p.id]} />
                ))}
              </SettingsGroup>
            </div>
          ))
        )}
      </div>
    </SettingsSection>
  );
}

async function showInFinder(file: string) {
  try {
    await revealItemInDir(file);
  } catch (e) {
    toast.error(`Couldn't show it in Finder: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ProviderKeyRow({
  provider,
  entry,
}: {
  provider: ProviderDef;
  entry: EnvEntry | undefined;
}) {
  const pending = useByokStore.use.pending();
  const { save, remove } = useByokStore.use.actions();
  const [revealed, setRevealed] = useState<string | null>(null);

  // The var an edit writes: whatever it was found as, else the canonical one.
  const envVar = entry?.envVar ?? provider.env;
  const busy = pending === envVar;
  const readOnly = !!entry && !entry.editable;

  // A key that changes under a revealed value hides it again.
  const last4 = entry?.last4;
  useEffect(() => setRevealed(null), [last4]);

  // Every write rewrites the user's own file, so each one is undoable: the
  // value it replaces (or removes) is read first, and Undo writes it back.
  const restore = async (value: string) => {
    try {
      await save(envVar, value);
      toast(`Restored ${envVar}`);
    } catch (e) {
      toast.error(`Couldn't restore the key: ${errorText(e)}`);
    }
  };
  const undo = (previous: string | null) =>
    previous ? { label: "Undo", onClick: () => void restore(previous) } : undefined;

  const onSave = async (value: string) => {
    try {
      const previous = entry ? await byok.reveal(envVar) : null;
      if (previous === value) return;
      const file = await save(envVar, value);
      toast.success(
        `${provider.name} key ${previous ? "replaced" : "saved"} in ${tildePath(file)}`,
        { action: undo(previous) },
      );
    } catch (e) {
      toast.error(`Couldn't save the key: ${errorText(e)}`);
    }
  };

  const onRemove = async () => {
    try {
      const previous = await byok.reveal(envVar);
      await remove(envVar);
      toast(`Removed ${envVar}`, { action: undo(previous) });
    } catch (e) {
      toast.error(`Couldn't remove the key: ${errorText(e)}`);
    }
  };

  const reveal = async () => {
    try {
      setRevealed((await byok.reveal(envVar)) ?? "");
    } catch {
      toast.error("Couldn't read that key.");
    }
  };

  const copy = async () => {
    try {
      const value = await byok.reveal(envVar);
      if (value && (await copyText(value))) toast(`Copied ${envVar}`);
    } catch {
      toast.error("Couldn't read that key.");
    }
  };

  const where = entry?.file
    ? `${tildePath(entry.file)}${entry.line ? `:${entry.line}` : ""}`
    : "your environment";
  const status = entry ? (
    <>
      <span className="font-mono">
        {revealed !== null ? revealed || "(empty)" : `••••${entry.last4}`}
      </span>
      {` · ${where}`}
    </>
  ) : undefined;

  return (
    <SettingsRow
      anchor={`key-${provider.id}`}
      title={
        <span className="flex items-center gap-2">
          <ProviderLogo id={provider.id} size={14} />
          {provider.name}
        </span>
      }
      description={
        <>
          <span className="font-mono">{envVar}</span>
          {provider.docsUrl && (
            <>
              {" · "}
              <button
                type="button"
                onClick={() => void openUrl(provider.docsUrl!)}
                className="inline-flex items-center gap-0.5 hover:text-foreground"
              >
                Get a key
                <Icon icon={ArrowUpRight} size="xs" />
              </button>
            </>
          )}
        </>
      }
      status={status}
      control={
        <>
          {readOnly ? (
            <Hint label="Exported outside your shell profile (a login script, launchd or a wrapper). Change it there.">
              <Badge variant="outline" tabIndex={0}>
                <Icon icon={Lock} size="xs" />
                Set in environment
              </Badge>
            </Hint>
          ) : (
            <SecretInput
              size="sm"
              className="w-56"
              configured={!!entry}
              placeholder={provider.placeholder ?? "Not set"}
              disabled={busy}
              aria-label={`${provider.name} API key`}
              onCommit={(value) => void onSave(value)}
            />
          )}
          {/* A fixed slot, so every row's field ends at the same edge. */}
          <span className="flex w-15 shrink-0 justify-end gap-1">
            {entry && !readOnly && (
              <IconButton
                icon={X}
                size="sm"
                label={`Remove ${envVar}`}
                disabled={busy}
                onClick={() => void onRemove()}
              />
            )}
            {entry && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <IconButton
                      icon={MoreHorizontal}
                      size="sm"
                      label={`${provider.name} key actions`}
                    />
                  }
                />
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem
                    onClick={() => (revealed !== null ? setRevealed(null) : void reveal())}
                  >
                    {revealed !== null ? "Hide key" : "Reveal key"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void copy()}>Copy key</DropdownMenuItem>
                  {entry.file && (
                    <DropdownMenuItem onClick={() => void showInFinder(entry.file!)}>
                      Show in Finder
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        </>
      }
    />
  );
}
