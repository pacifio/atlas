// The git verbs "Commit, push & PR" runs, each by path. The git store's own
// actions act on whichever repository is active at the moment they run, and
// a run outlives a project switch (a slow hook is time enough to switch), so
// the run names its repository on every call instead. The ones that stream
// do it under an op id, which feeds the op strip as the store's own do.

import { invoke } from "@tauri-apps/api/core";

import type { GitSnapshotWire } from "../stores/git-store";

function opId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function shipSnapshot(path: string): Promise<GitSnapshotWire> {
  return invoke<GitSnapshotWire>("git_snapshot", { path });
}

/** `checkout -b`: create `name` at HEAD and switch to it. */
export function shipCreateBranch(path: string, name: string): Promise<void> {
  return invoke<void>("git_create_branch", { path, name });
}

export function shipCommit(
  path: string,
  summary: string,
  description: string | null,
  coAuthors: string[],
): Promise<void> {
  return invoke<void>("git_commit_v2", {
    path,
    summary,
    description,
    amend: false,
    coAuthors: coAuthors.length > 0 ? coAuthors : null,
    opId: opId(),
  });
}

export function shipPush(path: string): Promise<void> {
  return invoke<void>("git_push", {
    path,
    forceWithLease: false,
    followTags: false,
    remote: null,
    opId: opId(),
  });
}

/** Push the branch and set its upstream. */
export function shipPublish(path: string): Promise<void> {
  return invoke<void>("git_publish_branch", { path, remote: null, opId: opId() });
}
