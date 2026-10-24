import type { BranchInfo } from "../stores/git-store";

/**
 * The rows of the compare-against picker: one per branch name, pairing a
 * local branch with its remote-tracking twin (`main` with `origin/main`), and
 * a row of its own for a remote branch with no local one. A paired row's
 * switch picks which of the two the branch range is taken against: the local
 * branch as it is here, or the remote's as last fetched.
 */
export interface BaseRefChoice {
  /** Stable across renders: `local:<name>` or `remote:<name>`. */
  readonly id: string;
  /** What the row reads: the local name, or the remote ref's own. */
  readonly label: string;
  readonly local: string | null;
  readonly remote: string | null;
}

/** `origin/feature/x` → `feature/x`. A remote's name holds no slash. */
function remoteBranchName(ref: string): string {
  const slash = ref.indexOf("/");
  return slash < 0 ? ref : ref.slice(slash + 1);
}

/** `origin/feature/x` → `origin`. */
function remoteOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash < 0 ? "" : ref.slice(0, slash);
}

/**
 * Pair `branches` (local and remote, as `git_branches_full` lists them) into
 * picker rows: local branches first, in the order given, each with the remote
 * branch of the same name (from `origin` when several remotes have one), then
 * the remote branches no local one took. `head`, the branch being compared,
 * is left out, and so is its remote twin's pairing: comparing a branch with
 * itself shows nothing, but its remote copy stays offered as remote-only.
 */
export function buildBaseRefChoices(
  branches: readonly BranchInfo[],
  head: string | null,
): BaseRefChoice[] {
  const locals = branches.filter((b) => !b.isRemote && b.name !== head).map((b) => b.name);
  const remotes = branches.filter((b) => b.isRemote).map((b) => b.name);
  const unused = new Set(remotes);
  // Remote refs by the branch name they carry: one pass, not one per local.
  const byBranch = new Map<string, string[]>();
  for (const r of remotes) {
    const name = remoteBranchName(r);
    const list = byBranch.get(name);
    if (list) list.push(r);
    else byBranch.set(name, [r]);
  }
  const paired = locals.map((local): BaseRefChoice => {
    const matches = byBranch.get(local) ?? [];
    const remote = matches.find((r) => remoteOf(r) === "origin") ?? matches[0] ?? null;
    if (remote) unused.delete(remote);
    return { id: `local:${local}`, label: local, local, remote };
  });
  const remoteOnly = remotes
    .filter((r) => unused.has(r))
    .map((remote): BaseRefChoice => ({
      id: `remote:${remote}`,
      label: remote,
      local: null,
      remote,
    }));
  return [...paired, ...remoteOnly];
}

/** The rows whose label, local or remote ref holds `query`, ignoring case. */
export function filterBaseRefChoices(
  choices: readonly BaseRefChoice[],
  query: string,
): readonly BaseRefChoice[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return choices;
  return choices.filter(
    (c) =>
      c.label.toLocaleLowerCase().includes(q) ||
      c.local?.toLocaleLowerCase().includes(q) === true ||
      c.remote?.toLocaleLowerCase().includes(q) === true,
  );
}

/** The ref a row stands for given the reader's `chosen` ref: its remote when
 *  that is what is chosen, else its local branch (or its remote, if alone). */
export function refOfChoice(choice: BaseRefChoice, chosen: string | null): string {
  if (chosen !== null && chosen === choice.remote) return choice.remote;
  return choice.local ?? choice.remote ?? choice.label;
}

/** The ref a paired row's switch picks: the remote when on, the local when off. */
export function toggledRef(choice: BaseRefChoice, useRemote: boolean): string | null {
  return useRemote ? choice.remote : choice.local;
}
