import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAppStore } from "@/features/app/stores/app-store";
import { useAppProfile } from "@/lib/app-profile";
import { logEvent } from "@/features/log/lib/log";
import { metaFromSearch, type ClonedRepo, type GithubRepo } from "@/features/github/types";
import {
  classifySearchError,
  cloneGithubRepo,
  deleteClonedRepo,
  fetchClonedRepoMeta,
  listClonedRepos,
  listRemoteBranches,
  openExternal,
  searchGithub,
  switchClonedRepoBranch,
  updateClonedRepo,
} from "@/features/github/lib/github-api";
import { GithubPanelView, type SearchError } from "./views/github-panel-view";
import type { RowBusy } from "./views/cloned-repo-row-view";

/**
 * The GitHub panel's container: search public repositories, clone them as
 * reference material under `<project>/.atlas/repos/`, and manage what is
 * already there — the checked-out branch, a fetch to the remote's tip, delete.
 *
 * Clones are shallow and single-branch, so "branches" is a live `ls-remote`
 * (asked only when the picker opens) and switching is a shallow fetch of just
 * that branch. Each clone shows the description, language and counts the
 * search result knew at clone time (cached by Rust beside `repos/`, never
 * inside the clone); older clones that predate the cache are filled in once,
 * on demand. Everything it renders is `GithubPanelView`.
 */

/** How many pre-cache clones to ask GitHub about at once. */
const META_BACKFILL_CONCURRENCY = 3;

export function GithubPanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GithubRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<SearchError | null>(null);
  const [cloning, setCloning] = useState<Set<string>>(new Set());
  const [cloned, setCloned] = useState<Set<string>>(new Set());
  const [rowBusy, setRowBusy] = useState<Record<string, RowBusy>>({});
  const currentProject = useAppStore.use.currentProject();
  const projectPath = currentProject?.path ?? null;
  // `.atlas`, or `.atlas-dev` for a dev-profile build — where Rust clones to.
  const atlasDir = useAppProfile().dirName;

  // ── What is already on disk ───────────────────────────────────────────
  const [repos, setRepos] = useState<ClonedRepo[]>([]);
  const refreshRepos = useCallback(async () => {
    if (!projectPath) {
      setRepos([]);
      return;
    }
    try {
      setRepos(await listClonedRepos(projectPath));
    } catch {
      setRepos([]);
    }
  }, [projectPath]);

  useEffect(() => {
    void refreshRepos();
    // The composer's "Add from GitHub" and the Knowledge sidebar clone and
    // delete too; they announce it the same way.
    const onChanged = () => void refreshRepos();
    window.addEventListener("atlas:repo-cloned", onChanged);
    return () => window.removeEventListener("atlas:repo-cloned", onChanged);
  }, [refreshRepos]);

  // Clones made before Atlas cached metadata get theirs filled in once, a
  // few at a time so a long list does not fire thirty requests at GitHub.
  const backfilled = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!projectPath) return;
    const missing = repos.filter((r) => !r.meta && !backfilled.current.has(r.name));
    if (missing.length === 0) return;
    let cancelled = false;
    const queue = missing.slice();
    const worker = async () => {
      for (let r = queue.shift(); r && !cancelled; r = queue.shift()) {
        backfilled.current.add(r.name);
        try {
          const meta = await fetchClonedRepoMeta(projectPath, r.name);
          if (cancelled) return;
          setRepos((cur) => cur.map((x) => (x.name === r!.name ? { ...x, meta } : x)));
        } catch {
          // Rate-limited or offline: the row simply stays without a blurb.
        }
      }
    };
    for (let i = 0; i < Math.min(META_BACKFILL_CONCURRENCY, queue.length); i++) void worker();
    return () => {
      cancelled = true;
    };
  }, [repos, projectPath]);

  // ── Search and clone ──────────────────────────────────────────────────
  // Every search (and clearing the box) takes a number; an answer whose
  // number has moved on is dropped, so a slow earlier search can't land over
  // a later one, or over an emptied box.
  const searchSeq = useRef(0);
  const handleSearch = async () => {
    const q = query.trim();
    if (!q) return;
    const seq = ++searchSeq.current;
    setLoading(true);
    setError(null);
    try {
      const found = await searchGithub(q);
      if (seq !== searchSeq.current) return;
      setResults(found);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setError(classifySearchError(e));
      setResults([]);
    }
    setLoading(false);
  };

  const changeQuery = (next: string) => {
    setQuery(next);
    if (next.trim()) return;
    // Cleared: back to the clones, with nothing of the old search left over.
    searchSeq.current += 1;
    setResults([]);
    setError(null);
    setLoading(false);
  };

  const cloneRepo = async (repo: GithubRepo) => {
    if (!currentProject || cloning.has(repo.full_name)) return;
    setCloning((s) => new Set(s).add(repo.full_name));
    try {
      const repoName = repo.full_name.replace("/", "-");
      await cloneGithubRepo(currentProject.path, repo.clone_url, repoName, metaFromSearch(repo));
      setCloned((s) => new Set(s).add(repo.full_name));
      window.dispatchEvent(new Event("atlas:repo-cloned"));
      logEvent({
        source: "github",
        kind: "clone",
        summary: repo.full_name,
        payload: { repo: repo.full_name, clone_url: repo.clone_url },
      });
    } catch (e) {
      console.error("Clone failed:", e);
      toast.error(`Could not clone ${repo.full_name}: ${String(e)}`);
    }
    setCloning((s) => {
      const n = new Set(s);
      n.delete(repo.full_name);
      return n;
    });
  };

  const cloneStates: Record<string, "cloning" | "cloned"> = {};
  for (const name of cloning) cloneStates[name] = "cloning";
  // On disk or cloned this session wins over an in-flight clone, as before.
  for (const r of repos) cloneStates[r.display_name] = "cloned";
  for (const name of cloned) cloneStates[name] = "cloned";

  // ── Row actions on a clone ────────────────────────────────────────────
  const setBusy = (repo: ClonedRepo, busy: RowBusy | null) =>
    setRowBusy((cur) => {
      const next = { ...cur };
      if (busy) next[repo.name] = busy;
      else delete next[repo.name];
      return next;
    });

  const switchBranch = async (repo: ClonedRepo, branch: string) => {
    if (!projectPath || rowBusy[repo.name]) return;
    setBusy(repo, "switch");
    try {
      await switchClonedRepoBranch(projectPath, repo.name, branch);
      toast.success(`${repo.display_name} is on ${branch}`);
      void refreshRepos();
    } catch (e) {
      toast.error(`Could not switch branch: ${String(e)}`);
    } finally {
      setBusy(repo, null);
    }
  };

  const update = async (repo: ClonedRepo) => {
    if (!projectPath || rowBusy[repo.name]) return;
    setBusy(repo, "update");
    try {
      const branch = await updateClonedRepo(projectPath, repo.name);
      toast.success(`${repo.display_name} updated to origin/${branch}`);
      void refreshRepos();
    } catch (e) {
      toast.error(`Could not fetch: ${String(e)}`);
    } finally {
      setBusy(repo, null);
    }
  };

  const remove = async (repo: ClonedRepo) => {
    if (!projectPath || rowBusy[repo.name]) return;
    setBusy(repo, "delete");
    try {
      await deleteClonedRepo(projectPath, repo.name);
      window.dispatchEvent(new Event("atlas:repo-cloned"));
      // The row stays busy until the re-read drops it, then the entry goes
      // too, so a later clone of the same repo does not come back "deleting".
      await refreshRepos();
      setBusy(repo, null);
    } catch (e) {
      toast.error(`Could not delete: ${String(e)}`);
      setBusy(repo, null);
    }
  };

  return (
    <GithubPanelView
      query={query}
      onQueryChange={changeQuery}
      onSearch={() => void handleSearch()}
      hasProject={!!projectPath}
      cloneDir={`${atlasDir}/repos/`}
      clones={projectPath ? repos : []}
      rowBusy={rowBusy}
      loading={loading}
      error={error}
      results={results}
      cloneStates={cloneStates}
      loadBranches={(repo) =>
        projectPath ? listRemoteBranches(projectPath, repo.name) : Promise.resolve([])
      }
      onSwitchBranch={(repo, branch) => void switchBranch(repo, branch)}
      onUpdate={(repo) => void update(repo)}
      onDelete={(repo) => void remove(repo)}
      onOpenUrl={(url) => void openExternal(url)}
      onClone={(repo) => void cloneRepo(repo)}
    />
  );
}
