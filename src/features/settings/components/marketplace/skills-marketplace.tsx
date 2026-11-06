// Settings → Skills → Discover. The skills.sh registry: the most installed
// skills, or a live search, one row each with Install. A name opens a dialog
// with the description fetched from the repo.
//
// DATA NOTE: the registry `search` API returns only { id, name, installs,
// source } and 400s on an empty query — no time-series, trending feed, or
// description (the latter needs a repo clone via `pack_remote_preview`). So the
// default view is a cached "Popular" merge of a few seed queries, and detail is
// fetched lazily on open.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { copyText } from "@/lib/clipboard";
import { packs as packsApi } from "@/features/packs/lib/packs-api";
import { skills as skillsApi } from "@/features/skills/lib/skills-api";
import { SKILLS_CHANGED_EVENT } from "@/features/skills/lib/skills-events";
import {
  detailFromPreview,
  githubUrlFor,
  hitMarkdown,
  mergePopular,
} from "@/features/skills/lib/skills-view-model";
import { installTrend } from "@/features/packs/lib/install-trends";
import type { Pack, PackSearchHit, Scope } from "@/features/packs/lib/types";
import { SkillDetailDialogView, SkillsMarketplaceView } from "./views/skills-marketplace-view";

const POPULAR_SEEDS = ["agent", "react", "design", "review", "database", "python"];
const POPULAR_LS_KEY = "atlas:skills:popular:v1";

// Cache the first popular fetch so re-entering Discover (or restarting the app)
// shows results instantly instead of re-running the seed searches.
let popularCache: PackSearchHit[] | null = null;

// Cache `pack_remote_preview` results (a repo clone — slow) by source, so
// re-opening a skill's detail modal is instant. Lives for the app session.
const previewCache = new Map<string, Pack>();

// In-flight installs, keyed by registry hit id ("source/skillId"). Lifted to
// MODULE scope (not component state) so the spinner survives unmount — switching
// settings sub-tabs / sections away mid-install no longer loses the loading
// state; returning to Discover shows the install still running, then completes.
const installingIds = new Set<string>();
let installVersion = 0;
const installSubs = new Set<() => void>();
function notifyInstalling() {
  installVersion++;
  installSubs.forEach((f) => f());
}
async function runInstall(hit: PackSearchHit, scope: Scope, projectPath: string | null) {
  if (installingIds.has(hit.id)) return;
  installingIds.add(hit.id);
  notifyInstalling();
  try {
    // Install just THIS skill (not the whole repo) — the registry is skill-level.
    await packsApi.installSkill(scope, hit.source, hit.skillId || hit.name, projectPath);
  } catch (e) {
    toast.error(`Couldn't install ${hit.name}: ${String(e)}`);
  } finally {
    installingIds.delete(hit.id);
    notifyInstalling();
  }
  // `installSkill` fires `atlas:skills-changed`; the component refetches installed.
}

function loadPopularCache(): PackSearchHit[] | null {
  if (popularCache) return popularCache;
  try {
    const raw = localStorage.getItem(POPULAR_LS_KEY);
    if (raw) {
      popularCache = JSON.parse(raw) as PackSearchHit[];
      return popularCache;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function savePopularCache(hits: PackSearchHit[]): void {
  popularCache = hits;
  try {
    localStorage.setItem(POPULAR_LS_KEY, JSON.stringify(hits));
  } catch {
    /* ignore */
  }
}

const PAGE_SIZE = 20;

export function SkillsMarketplace({
  scope,
  projectPath,
}: {
  scope: Scope;
  projectPath: string | null;
}) {
  const effectiveProject = scope === "project" ? projectPath : null;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PackSearchHit[]>([]);
  const [popular, setPopular] = useState<PackSearchHit[]>(() => loadPopularCache() ?? []);
  const [loading, setLoading] = useState(false);
  // Re-render whenever the module-level install registry changes.
  useSyncExternalStore(
    (cb) => {
      installSubs.add(cb);
      return () => installSubs.delete(cb);
    },
    () => installVersion,
  );
  const [selected, setSelected] = useState<PackSearchHit | null>(null);
  // The set of installed skill NAMES (each registry hit is one skill; `skillId`
  // is its name). We check installed-state per skill, NOT per source repo — a
  // repo holds many skills, so "is the repo installed" wrongly marks all of them.
  const [installedSkills, setInstalledSkills] = useState<Set<string>>(new Set());

  const refreshInstalled = useCallback(async () => {
    try {
      const metas = await skillsApi.list(scope, effectiveProject);
      setInstalledSkills(new Set(metas.map((m) => m.name)));
    } catch {
      /* installed badges just won't show */
    }
  }, [scope, effectiveProject]);

  const isHitInstalled = useCallback(
    (hit: PackSearchHit) => installedSkills.has(hit.skillId || hit.name),
    [installedSkills],
  );

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  // Refresh installed badges when a skill/pack mutation lands (incl. an install
  // that completed while this component was unmounted).
  useEffect(() => {
    const onChanged = () => void refreshInstalled();
    window.addEventListener(SKILLS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, onChanged);
  }, [refreshInstalled]);

  // Default "Popular" view — only fetched once (then cached). Merge a few broad
  // searches, dedupe by id keeping the highest install count.
  useEffect(() => {
    if (loadPopularCache()) return; // already have it
    let cancelled = false;
    void (async () => {
      const batches = await Promise.allSettled(POPULAR_SEEDS.map((q) => packsApi.search(q)));
      if (cancelled) return;
      const merged = mergePopular(
        batches.flatMap((b) => (b.status === "fulfilled" ? [b.value] : [])),
      );
      savePopularCache(merged);
      setPopular(merged);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced live search.
  const debRef = useRef<number | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (debRef.current) window.clearTimeout(debRef.current);
    debRef.current = window.setTimeout(() => {
      void packsApi
        .search(q)
        .then((r) => setResults(r.sort((a, b) => b.installs - a.installs)))
        .catch((e) => toast.error(String(e)))
        .finally(() => setLoading(false));
    }, 220);
    return () => {
      if (debRef.current) window.clearTimeout(debRef.current);
    };
  }, [query]);

  const rows = query.trim() ? results : popular;

  const install = useCallback(
    (hit: PackSearchHit) => void runInstall(hit, scope, effectiveProject),
    [scope, effectiveProject],
  );

  const [limit, setLimit] = useState(PAGE_SIZE);
  useEffect(() => setLimit(PAGE_SIZE), [query]);
  const more = Math.min(PAGE_SIZE, rows.length - limit);

  return (
    <SkillsMarketplaceView
      query={query}
      onQueryChange={setQuery}
      loading={loading}
      rows={rows.slice(0, limit).map((hit) => ({
        hit,
        installed: isHitInstalled(hit),
        installing: installingIds.has(hit.id),
        trend: installTrend(hit.id, hit.installs).points,
      }))}
      more={more}
      onShowMore={() => setLimit((l) => l + PAGE_SIZE)}
      onSelect={setSelected}
      onInstall={install}
    >
      <SkillDetail
        hit={selected}
        installed={selected ? isHitInstalled(selected) : false}
        installing={selected ? installingIds.has(selected.id) : false}
        onInstall={() => selected && install(selected)}
        onClose={() => setSelected(null)}
      />
    </SkillsMarketplaceView>
  );
}

/** Lazily fetches the repo preview (description and components) that the
 *  registry search lacks, for the detail dialog. */
function SkillDetail({
  hit,
  installed,
  installing,
  onInstall,
  onClose,
}: {
  hit: PackSearchHit | null;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
  onClose: () => void;
}) {
  // Seed synchronously from cache so a re-opened dialog paints instantly.
  const [preview, setPreview] = useState<Pack | null>(
    hit ? (previewCache.get(hit.source) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!hit) return;
    const cached = previewCache.get(hit.source);
    if (cached) {
      setPreview(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setLoading(true);
    void packsApi
      .remotePreview(hit.source)
      .then((p) => {
        if (cancelled) return;
        previewCache.set(hit.source, p);
        setPreview(p);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [hit]);

  return (
    <SkillDetailDialogView
      hit={hit}
      installed={installed}
      installing={installing}
      status={loading ? "loading" : preview ? "ready" : "failed"}
      detail={detailFromPreview(preview)}
      onInstall={onInstall}
      onCopy={() => hit && void copyText(hitMarkdown(hit, preview))}
      onOpenGithub={() => hit && void openUrl(githubUrlFor(hit.source))}
      onClose={onClose}
    />
  );
}
